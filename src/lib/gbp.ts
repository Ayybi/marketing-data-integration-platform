// Google Business Profile connector (doc §4.3, B4 metrics shape, B5 getAccessToken verbatim).
//
// Auth: OAuth 2.0 refresh token (google_connections provider='google_business', env fallback
// GBP_REFRESH_TOKEN). App creds GOOGLE_BUSINESS_CLIENT_ID/SECRET with a fallback to the Google Ads pair.
//
// Failure discipline (BUG-166, §12): reviews return { ok:true, ... } or { ok:false, reason } — an empty
// or failed reviews read is NEVER written as "0 reviews". Metrics reads throw on failure so the sweep
// counts them (partial) rather than storing zeros.
import type { Fetcher } from "./http"
import { defaultFetcher } from "./http"
import type { Repos, GbpSnapshotRow } from "./db/types"
import type { ReadResult } from "./result"
import { type SyncResult, toSyncLogEntry, SYNC_ERROR_SAMPLE_CAP } from "./sync-log"

export type GbpBounds = { startDate: string; endDate: string } // YYYY-MM-DD

// ---- Auth ----

export function gbpOAuthCreds(): { clientId?: string; clientSecret?: string } {
  return {
    clientId: process.env.GOOGLE_BUSINESS_CLIENT_ID ?? process.env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: process.env.GOOGLE_BUSINESS_CLIENT_SECRET ?? process.env.GOOGLE_ADS_CLIENT_SECRET,
  }
}

/** Resolve the refresh token: GBP_REFRESH_TOKEN env, else the agency vault entry (three-state). */
export async function resolveGbpRefreshToken(repos: Repos): Promise<ReadResult<string>> {
  const env = process.env.GBP_REFRESH_TOKEN
  if (env) return { status: "present", value: env }
  return repos.credentials.resolve("google_business", "agency")
}

export async function isGbpConfigured(repos: Repos): Promise<boolean> {
  const { clientId, clientSecret } = gbpOAuthCreds()
  if (!clientId || !clientSecret) return false
  return (await resolveGbpRefreshToken(repos)).status === "present"
}

/**
 * Mint an access token from the refresh token (B5, verbatim). The refresh MUST use the same client that
 * minted the token (§4.3). Throws (ERROR) on any failure — never returns a blank token.
 */
export async function getAccessToken(
  fetcher: Fetcher,
  refreshToken: string,
  creds: { clientId?: string; clientSecret?: string },
): Promise<string> {
  const { clientId, clientSecret } = creds
  if (!refreshToken || !clientId || !clientSecret) throw new Error("GBP OAuth credentials not configured")
  const res = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
  })
  if (!res.ok) throw new Error(`GBP token refresh failed: ${res.status}`)
  const json = (await res.json()) as { access_token?: string }
  if (!json.access_token) throw new Error("GBP token refresh returned no access_token")
  return json.access_token
}

// ---- Metrics (B4 fetchMultiDailyMetricsTimeSeries) ----

const DAILY_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "BUSINESS_DIRECTION_REQUESTS",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
  "BUSINESS_CONVERSATIONS",
] as const

function ymdParts(d: string): [string, string, string] {
  const [y, m, day] = d.split("-")
  return [y, m, day]
}

export async function fetchGbpDailyMetrics(fetcher: Fetcher, token: string, locationId: string, bounds: GbpBounds): Promise<unknown> {
  const [sy, sm, sd] = ymdParts(bounds.startDate)
  const [ey, em, ed] = ymdParts(bounds.endDate)
  const params = new URLSearchParams()
  for (const metric of DAILY_METRICS) params.append("dailyMetrics", metric)
  params.set("dailyRange.start_date.year", sy)
  params.set("dailyRange.start_date.month", String(Number(sm)))
  params.set("dailyRange.start_date.day", String(Number(sd)))
  params.set("dailyRange.end_date.year", ey)
  params.set("dailyRange.end_date.month", String(Number(em)))
  params.set("dailyRange.end_date.day", String(Number(ed)))
  const url = `https://businessprofileperformance.googleapis.com/v1/locations/${locationId}:fetchMultiDailyMetricsTimeSeries?${params}`
  const res = await fetcher(url, { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 20000 })
  if (!res.ok) throw new Error(`GBP metrics ${locationId} -> ${res.status}`) // ERROR surfaces; never zeros
  return res.json()
}

// Response shape (documented): { multiDailyMetricTimeSeries: [ { dailyMetricTimeSeries: [ { dailyMetric,
//   timeSeries: { datedValues: [ { date: {year,month,day}, value } ] } } ] } ] }
type DatedValue = { date?: { year?: number; month?: number; day?: number }; value?: string | number }
type DailySeries = { dailyMetric?: string; timeSeries?: { datedValues?: DatedValue[] } }
type MultiSeries = { multiDailyMetricTimeSeries?: Array<{ dailyMetricTimeSeries?: DailySeries[] }> }

const METRIC_FIELD: Record<string, keyof Pick<GbpSnapshotRow, "mapsViews" | "searchViews" | "directions" | "calls" | "websiteClicks" | "conversations">> = {
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: "mapsViews",
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: "mapsViews",
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: "searchViews",
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: "searchViews",
  BUSINESS_DIRECTION_REQUESTS: "directions",
  CALL_CLICKS: "calls",
  WEBSITE_CLICKS: "websiteClicks",
  BUSINESS_CONVERSATIONS: "conversations",
}

/** Normalize the multi-metric time series into one snapshot row per day. */
export function normalizeGbpSnapshots(clientId: string, locationId: string, raw: unknown): Array<Omit<GbpSnapshotRow, "orgId">> {
  const data = raw as MultiSeries
  const byDay = new Map<string, Omit<GbpSnapshotRow, "orgId">>()
  const blank = (date: string): Omit<GbpSnapshotRow, "orgId"> => ({
    clientId, locationId, snapshotDate: date, views: 0, searchViews: 0, mapsViews: 0, actions: 0, calls: 0, directions: 0, websiteClicks: 0, conversations: 0,
  })
  for (const outer of data.multiDailyMetricTimeSeries ?? []) {
    for (const series of outer.dailyMetricTimeSeries ?? []) {
      const field = series.dailyMetric ? METRIC_FIELD[series.dailyMetric] : undefined
      if (!field) continue
      for (const dv of series.timeSeries?.datedValues ?? []) {
        const y = dv.date?.year
        const m = dv.date?.month
        const d = dv.date?.day
        if (!y || !m || !d) continue
        const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
        const row = byDay.get(date) ?? blank(date)
        row[field] += Number(dv.value ?? 0)
        byDay.set(date, row)
      }
    }
  }
  // Derive aggregates.
  for (const row of byDay.values()) {
    row.views = row.searchViews + row.mapsViews
    row.actions = row.calls + row.directions + row.websiteClicks + row.conversations
  }
  return [...byDay.values()]
}

// ---- Reviews (BUG-166 discipline) ----

export type ReviewsRead = { ok: true; totalCount: number; averageRating: number } | { ok: false; reason: string }

/**
 * Fetch review summary via the legacy My Business v4 API. Returns { ok:false, reason } on ANY failure —
 * an empty/failed read is NEVER coerced into "0 reviews". Only an authoritative { ok:true } is stored.
 */
export async function fetchGbpReviews(fetcher: Fetcher, token: string, locationId: string): Promise<ReviewsRead> {
  let res
  try {
    res = await fetcher(`https://mybusiness.googleapis.com/v4/${locationId}/reviews`, { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 20000 })
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
  let body: { averageRating?: number; totalReviewCount?: number }
  try {
    body = (await res.json()) as { averageRating?: number; totalReviewCount?: number }
  } catch (e) {
    return { ok: false, reason: `parse: ${e instanceof Error ? e.message : String(e)}` }
  }
  // A genuinely absent count is unknown, not zero -> report as not-ok rather than fabricate 0.
  if (body.totalReviewCount === undefined) return { ok: false, reason: "no totalReviewCount in response" }
  return { ok: true, totalCount: Number(body.totalReviewCount), averageRating: Number(body.averageRating ?? 0) }
}

// ---- Sync ----

export async function syncGbpForClient(
  repos: Repos,
  clientId: string,
  token: string,
  bounds: GbpBounds,
  fetcher: Fetcher,
): Promise<{ locations: number; days: number }> {
  const mappings = await repos.gbp.mappingsForClient(clientId)
  let days = 0
  for (const m of mappings.filter((x) => x.status === "active")) {
    const raw = await fetchGbpDailyMetrics(fetcher, token, m.locationId, bounds) // throws -> caller counts
    for (const s of normalizeGbpSnapshots(clientId, m.locationId, raw)) {
      await repos.gbp.upsertSnapshot(s)
      days += 1
    }
    const reviews = await fetchGbpReviews(fetcher, token, m.locationId)
    if (reviews.ok) {
      // Store ONLY an authoritative reviews read; a not-ok read leaves the last good value untouched.
      await repos.gbp.upsertReviewSnapshot({ clientId, locationId: m.locationId, snapshotDate: bounds.endDate, totalCount: reviews.totalCount, averageRating: reviews.averageRating })
    }
  }
  return { locations: mappings.length, days }
}

export async function syncAllGbp(repos: Repos, opts: { fetcher?: Fetcher; bounds: GbpBounds }): Promise<SyncResult> {
  const fetcher = opts.fetcher ?? defaultFetcher
  const refresh = await resolveGbpRefreshToken(repos)
  if (refresh.status !== "present") {
    const result: SyncResult = { processed: 0, errors: 1, total: 0, errorSample: [`gbp refresh token ${refresh.status}`] }
    await repos.syncLog.write(toSyncLogEntry("gbp", "snapshot", result))
    return result
  }
  let token: string
  try {
    token = await getAccessToken(fetcher, refresh.value, gbpOAuthCreds())
  } catch (e) {
    const result: SyncResult = { processed: 0, errors: 1, total: 0, errorSample: [`gbp token: ${e instanceof Error ? e.message : String(e)}`] }
    await repos.syncLog.write(toSyncLogEntry("gbp", "snapshot", result))
    return result
  }

  const mappings = await repos.gbp.activeMappings()
  const clients = [...new Set(mappings.map((m) => m.clientId))]
  const errorSample: string[] = []
  let processed = 0
  let errors = 0
  for (const clientId of clients) {
    try {
      await syncGbpForClient(repos, clientId, token, opts.bounds, fetcher)
      processed += 1
    } catch (e) {
      errors += 1
      if (errorSample.length < SYNC_ERROR_SAMPLE_CAP) errorSample.push(`${clientId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const result: SyncResult = { processed, errors, total: clients.length, errorSample }
  await repos.syncLog.write(toSyncLogEntry("gbp", "snapshot", result))
  return result
}

// ---- Reads ----

export type GbpMetrics = { views: number; searchViews: number; mapsViews: number; actions: number; calls: number; directions: number; websiteClicks: number; conversations: number }

/** Aggregate stored GBP snapshots for a client across its locations. Three-state. */
export async function getGbpLiveDataAggregated(repos: Repos, clientId: string, bounds: GbpBounds): Promise<ReadResult<GbpMetrics>> {
  const mappings = await repos.gbp.mappingsForClient(clientId)
  if (mappings.length === 0) return { status: "absent" }
  const rows = await repos.gbp.snapshotsForClient(clientId, bounds.startDate, bounds.endDate)
  const acc: GbpMetrics = { views: 0, searchViews: 0, mapsViews: 0, actions: 0, calls: 0, directions: 0, websiteClicks: 0, conversations: 0 }
  for (const r of rows) {
    acc.views += r.views
    acc.searchViews += r.searchViews
    acc.mapsViews += r.mapsViews
    acc.actions += r.actions
    acc.calls += r.calls
    acc.directions += r.directions
    acc.websiteClicks += r.websiteClicks
    acc.conversations += r.conversations
  }
  return { status: "present", value: acc }
}

/** Latest stored review metric for a location. Three-state: absent = never read authoritatively. */
export async function getGbpReviewMetric(repos: Repos, clientId: string, locationId: string): Promise<ReadResult<{ totalCount: number; averageRating: number }>> {
  const r = await repos.gbp.latestReview(clientId, locationId)
  if (r.status !== "present") return r
  return { status: "present", value: { totalCount: r.value.totalCount, averageRating: r.value.averageRating } }
}
