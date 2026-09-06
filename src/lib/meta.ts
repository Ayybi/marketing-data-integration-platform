// Meta / Facebook Ads connector (doc §4.6, B4 Graph API shapes, B5 getMetaAccessToken verbatim).
//
// Auth: OAuth token in meta_connections (encrypted, with expires_at), fallback to META_ACCESS_TOKEN (a
// non-expiring system-user token). Resolved token is cached for 5 minutes.
//
// Failure discipline (§4.6, §12):
//  - BUG-07: leads come from the grouped 'lead' action, NOT the sum of lead.* subtypes (double counting).
//  - The STORED snapshot is the source of truth; a fresh read that fails leaves the last good snapshot.
//  - A failed account is isolated into an ERROR row, never blended into totals; canceled accounts are excluded.
import type { Fetcher } from "./http"
import { defaultFetcher } from "./http"
import type { Repos, FbOverview } from "./db/types"
import type { ReadResult } from "./result"
import { type SyncResult, toSyncLogEntry, SYNC_ERROR_SAMPLE_CAP } from "./sync-log"

const GRAPH = "https://graph.facebook.com/v21.0"

// ---- Auth (B5, verbatim intent) ----

export type MetaToken = { accessToken: string; source: "oauth" | "env"; expiresAt: Date | null; userName: string | null }

type TokenCache = { data: MetaToken | null; timestamp: number }
const CACHE_TTL = 5 * 60 * 1000
// Cache keyed BY ORG (multi-tenant): one tenant's token must never be served to another (BYO isolation).
const globalCache = globalThis as unknown as { __metaTokenCache?: Map<string, TokenCache> }
function tokenCache(): Map<string, TokenCache> {
  return (globalCache.__metaTokenCache ??= new Map())
}

/**
 * Resolve the Meta token for THIS org: a stored oauth credential first, else META_ACCESS_TOKEN. Cached 5
 * minutes PER ORG. Returns null only when NEITHER source yields a usable token. A decrypt error on the
 * stored token is treated as "no oauth token" and falls back to env.
 */
export async function getMetaAccessToken(repos: Repos, nowMs: number): Promise<MetaToken | null> {
  const cache = tokenCache()
  const entry = cache.get(repos.orgId)
  if (entry && nowMs - entry.timestamp < CACHE_TTL) return entry.data

  const cred = await repos.credentials.resolve("facebook", "agency")
  if (cred.status === "present") {
    const result: MetaToken = { accessToken: cred.value, source: "oauth", expiresAt: null, userName: null }
    cache.set(repos.orgId, { data: result, timestamp: nowMs })
    return result
  }

  const envToken = process.env.META_ACCESS_TOKEN
  if (envToken) {
    const result: MetaToken = { accessToken: envToken, source: "env", expiresAt: null, userName: null }
    cache.set(repos.orgId, { data: result, timestamp: nowMs })
    return result
  }
  cache.set(repos.orgId, { data: null, timestamp: nowMs })
  return null
}

/** Test hook: reset the per-org token cache. */
export function resetMetaTokenCache(): void {
  delete globalCache.__metaTokenCache
}

export function isMetaConfigured(repos: Repos): Promise<boolean> {
  return repos.credentials.isConfigured("facebook", "agency").then((c) => c || Boolean(process.env.META_ACCESS_TOKEN))
}

// ---- Insights (B4) ----

export type MetaAction = { action_type: string; value: string | number }
export type RawInsights = {
  spend?: string | number
  impressions?: string | number
  clicks?: string | number
  ctr?: string | number
  cpc?: string | number
  actions?: MetaAction[]
}

/**
 * BUG-07: read leads from the SINGLE grouped 'lead' action, not by summing every lead.* subtype (which
 * double counts). Returns 0 only when there is genuinely no 'lead' action present.
 */
export function extractLeads(actions: MetaAction[] | undefined): number {
  if (!actions) return 0
  const grouped = actions.find((a) => a.action_type === "lead")
  return grouped ? Number(grouped.value) : 0
}

export function normalizeOverview(raw: RawInsights): FbOverview {
  const spend = Number(raw.spend ?? 0)
  const impressions = Number(raw.impressions ?? 0)
  const clicks = Number(raw.clicks ?? 0)
  const leads = extractLeads(raw.actions)
  return {
    spend,
    impressions,
    clicks,
    ctr: raw.ctr !== undefined ? Number(raw.ctr) : impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: raw.cpc !== undefined ? Number(raw.cpc) : clicks > 0 ? spend / clicks : 0,
    leads,
    cpl: leads > 0 ? Math.round((spend / leads) * 100) / 100 : 0,
  }
}

export async function fetchAccountInsights(fetcher: Fetcher, token: string, accountId: string, since: string, until: string): Promise<RawInsights> {
  const params = new URLSearchParams({
    access_token: token,
    fields: "spend,impressions,clicks,ctr,cpc,actions",
    time_range: JSON.stringify({ since, until }),
  })
  const res = await fetcher(`${GRAPH}/${accountId}/insights?${params}`, { timeoutMs: 20000 })
  if (!res.ok) throw new Error(`Meta insights ${accountId} -> ${res.status}`) // ERROR surfaces
  const json = (await res.json()) as { data?: RawInsights[] }
  return json.data?.[0] ?? {}
}

// ---- Sync ----

/**
 * Refresh the stored overview snapshot for each active account. A per-account read failure is written
 * as an ISOLATED error row (status:'error') — never blended into a total and never overwriting the last
 * good snapshot's numbers. Canceled/disabled accounts are excluded by activeMappings().
 */
export async function refreshFbOverviewSnapshots(
  repos: Repos,
  opts: { fetcher?: Fetcher; since: string; until: string; nowMs: number; dateRange?: "30d" | "prev_30d" | "all_time" },
): Promise<SyncResult> {
  const fetcher = opts.fetcher ?? defaultFetcher
  const dateRange = opts.dateRange ?? "30d"
  const token = await getMetaAccessToken(repos, opts.nowMs)
  if (!token) {
    const result: SyncResult = { processed: 0, errors: 1, total: 0, errorSample: ["meta token absent"] }
    await repos.syncLog.write(toSyncLogEntry("meta", "overview", result))
    return result
  }

  const mappings = await repos.fb.activeMappings()
  const errorSample: string[] = []
  let processed = 0
  let errors = 0
  const syncedAt = new Date(opts.nowMs).toISOString()

  for (const m of mappings) {
    try {
      const raw = await fetchAccountInsights(fetcher, token.accessToken, m.fbAccountId, opts.since, opts.until)
      await repos.fb.upsertOverview({ fbAccountId: m.fbAccountId, clientId: m.clientId, dateRange, overview: normalizeOverview(raw), status: "ok", syncedAt })
      processed += 1
    } catch (e) {
      errors += 1
      const error = e instanceof Error ? e.message : String(e)
      if (errorSample.length < SYNC_ERROR_SAMPLE_CAP) errorSample.push(`${m.fbAccountId}: ${error}`)
      // Isolate the failure as an error row WITHOUT touching the last good overview numbers.
      const prev = await repos.fb.getOverview(m.fbAccountId, dateRange)
      const overview = prev.status === "present" ? prev.value.overview : ZERO_OVERVIEW
      await repos.fb.upsertOverview({ fbAccountId: m.fbAccountId, clientId: m.clientId, dateRange, overview, status: "error", error, syncedAt })
    }
  }
  const result: SyncResult = { processed, errors, total: mappings.length, errorSample }
  await repos.syncLog.write(toSyncLogEntry("meta", "overview", result))
  return result
}

const ZERO_OVERVIEW: FbOverview = { spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, leads: 0, cpl: 0 }

// ---- Reads ----

/**
 * Read a client's stored Meta overview (the source of truth). Three-state:
 *   absent  -> no mapping (not connected),
 *   error   -> mapping lookup failed, OR the stored snapshot is an isolated error row (surfaced, not zeros),
 *   present -> the last good overview.
 */
export async function getFbClientData(repos: Repos, clientId: string, dateRange: "30d" | "prev_30d" | "all_time" = "30d"): Promise<ReadResult<FbOverview>> {
  const mapping = await repos.fb.getMappingByClient(clientId)
  if (mapping.status === "absent") return { status: "absent" }
  if (mapping.status === "error") return { status: "error", error: mapping.error }

  const snap = await repos.fb.getOverview(mapping.value.fbAccountId, dateRange)
  if (snap.status === "absent") return { status: "absent" }
  if (snap.status === "error") return { status: "error", error: snap.error }
  if (snap.value.status === "error") return { status: "error", error: snap.value.error ?? "account read failed" }
  return { status: "present", value: snap.value.overview }
}

export type FbAccountOverview = { fbAccountId: string; clientId?: string | null; status: "ok" | "error"; overview: FbOverview }

/** Department view (§4.6): the latest stored overview for every mapped Meta account. Failed accounts
 *  appear with status 'error' (not blended into totals), never silently dropped. */
export async function getFbAccountsOverview(repos: Repos, dateRange: "30d" | "prev_30d" | "all_time" = "30d"): Promise<FbAccountOverview[]> {
  const mappings = await repos.fb.activeMappings()
  const out: FbAccountOverview[] = []
  for (const m of mappings) {
    const snap = await repos.fb.getOverview(m.fbAccountId, dateRange)
    if (snap.status === "present") out.push({ fbAccountId: m.fbAccountId, clientId: m.clientId, status: snap.value.status, overview: snap.value.overview })
  }
  return out
}

/** CPL target: best-month CPL x2, or a $25 default (§4.6). */
export function computeCplTarget(monthlyCpls: number[]): number {
  const positive = monthlyCpls.filter((c) => c > 0)
  if (positive.length === 0) return 25
  return Math.round(Math.min(...positive) * 2 * 100) / 100
}
