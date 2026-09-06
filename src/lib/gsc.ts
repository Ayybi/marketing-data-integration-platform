// Google Search Console connector (doc §4.4, B4 searchanalytics.query shape).
//
// Auth: reuses the GA4 service-account credential with the single scope webmasters.readonly (§4.4).
// The service account must be added as a user on each GSC property.
//
// GSC is READ LIVE (no snapshot table, no cron) because position is already impression-weighted (§4.4).
// The query call is behind an injectable GscGateway so the aggregation + three-state discipline test
// without a live API.
//
// Failure discipline (§12): a permission_denied/403 read is surfaced as ERROR (not silently nulled) so
// the caller can tell "no access" from "no data". In an agency aggregate a PAUSED mapping renders as a
// zeroed row (it still shows), which is distinct from an errored read.
import type { Repos } from "./db/types"
import type { ReadResult } from "./result"
import { isGa4Configured } from "./ga4"

export type GscBounds = { startDate: string; endDate: string }

export type GscErrorCode = "PERMISSION_DENIED" | "OTHER"
export class GscApiError extends Error {
  constructor(
    message: string,
    readonly code: GscErrorCode,
  ) {
    super(message)
    this.name = "GscApiError"
  }
}

export type GscRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }
export interface GscGateway {
  // Mirrors searchanalytics.query (B4); throws GscApiError on failure.
  query(siteUrl: string, dimensions: string[], bounds: GscBounds, rowLimit: number): Promise<GscRow[]>
}

export function isGscConfigured(): boolean {
  return isGa4Configured() // shares the GA4 service account
}

export type GscMetrics = { clicks: number; impressions: number; ctr: number; position: number }

/** Aggregate rows into totals with an impression-weighted position (matches the GSC UI, §4.4). */
export function aggregateGscRows(rows: GscRow[]): GscMetrics {
  let clicks = 0
  let impressions = 0
  let weightedPos = 0
  for (const r of rows) {
    clicks += r.clicks
    impressions += r.impressions
    weightedPos += r.position * r.impressions
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weightedPos / impressions : 0,
  }
}

const ZERO: GscMetrics = { clicks: 0, impressions: 0, ctr: 0, position: 0 }

/**
 * Live GSC read for a client. Three-state:
 *   absent  -> no mapping (not connected),
 *   error   -> mapping lookup failed, OR the query failed (incl. permission_denied) — surfaced, never nulled,
 *   present -> aggregated metrics; a PAUSED mapping returns present-but-zeroed (it still renders).
 */
export async function getGscAnalytics(repos: Repos, clientId: string, gateway: GscGateway, bounds: GscBounds): Promise<ReadResult<GscMetrics>> {
  const mapping = await repos.gsc.getMappingByClient(clientId)
  if (mapping.status === "absent") return { status: "absent" }
  if (mapping.status === "error") return { status: "error", error: mapping.error }
  if (mapping.value.status === "paused") return { status: "present", value: { ...ZERO } } // paused -> zeroed row

  try {
    const rows = await gateway.query(mapping.value.siteUrl, ["query"], bounds, 25000)
    return { status: "present", value: aggregateGscRows(rows) }
  } catch (e) {
    // permission_denied/other are ERROR — never a silent null/zero that looks like "no traffic".
    const code = e instanceof GscApiError ? e.code : "OTHER"
    return { status: "error", error: `${code}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export type GscQueryPosition = { query: string; clicks: number; impressions: number; position: number }

/** Top query positions. Three-state (same rules as getGscAnalytics). */
export async function getGscQueryPositions(repos: Repos, clientId: string, gateway: GscGateway, bounds: GscBounds, limit = 25): Promise<ReadResult<GscQueryPosition[]>> {
  const mapping = await repos.gsc.getMappingByClient(clientId)
  if (mapping.status === "absent") return { status: "absent" }
  if (mapping.status === "error") return { status: "error", error: mapping.error }
  if (mapping.value.status === "paused") return { status: "present", value: [] }
  try {
    const rows = await gateway.query(mapping.value.siteUrl, ["query"], bounds, limit)
    const out = rows
      .map((r) => ({ query: r.keys[0] ?? "", clicks: r.clicks, impressions: r.impressions, position: r.position }))
      .sort((a, b) => b.clicks - a.clicks)
    return { status: "present", value: out.slice(0, limit) }
  } catch (e) {
    const code = e instanceof GscApiError ? e.code : "OTHER"
    return { status: "error", error: `${code}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Agency aggregate: paused mappings render as zeroed rows; errored reads are reported distinctly. */
export async function getGscPropertyAggregate(
  repos: Repos,
  gateway: GscGateway,
  bounds: GscBounds,
): Promise<{ rows: Array<{ clientId: string; metrics: GscMetrics }>; errors: Array<{ clientId: string; error: string }> }> {
  const mappings = await repos.gsc.activeMappings()
  const rows: Array<{ clientId: string; metrics: GscMetrics }> = []
  const errors: Array<{ clientId: string; error: string }> = []
  for (const m of mappings) {
    if (m.status === "paused") {
      rows.push({ clientId: m.clientId, metrics: { ...ZERO } }) // still renders
      continue
    }
    try {
      const r = await gateway.query(m.siteUrl, ["query"], bounds, 25000)
      rows.push({ clientId: m.clientId, metrics: aggregateGscRows(r) })
    } catch (e) {
      errors.push({ clientId: m.clientId, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { rows, errors }
}
