// NEW: framework-agnostic request handlers. Each returns { status, body } so it mounts in a thin Next
// route (see WIRING.md) — nothing here imports `next`.
//
// The three-state read contract (§12) maps cleanly to HTTP:
//   present -> 200 { data }
//   absent  -> 404 { error: "not_connected" }   (a genuine "nothing here", never a fake zero)
//   error   -> 502 { error }                     (a read failure is surfaced, not disguised as 200/empty)
import type { HubContext } from "./adapters"
import type { ReadResult } from "../result"
import { getCallRailMetricsForClient } from "../callrail"
import { getGa4Analytics } from "../ga4"
import { getGbpLiveDataAggregated } from "../gbp"
import { fetchAccountSummaryMetrics } from "../lsa"
import { getFbClientData } from "../meta"
import { getStripeOverviewStats } from "../stripe"

export type HandlerResponse = { status: number; body: unknown }

/** Map a three-state read to the HTTP response shape. */
export function readToResponse<T>(r: ReadResult<T>): HandlerResponse {
  if (r.status === "present") return { status: 200, body: { data: r.value } }
  if (r.status === "absent") return { status: 404, body: { error: "not_connected" } }
  return { status: 502, body: { error: r.error } } // failure surfaced, never a 200 with fake zeros
}

export type MetricsQuery = { source: string; clientId?: string; from?: string; to?: string }

const SNAPSHOT_SOURCES = new Set(["callrail", "ga4", "gbp", "lsa", "meta", "stripe"])

/**
 * GET /v1/{source}/metrics?client=...&from=...&to=... — read a workspace's stored, normalized metrics.
 * Snapshot-backed sources are served from Postgres/Mongo; live sources (gsc, semrush) are read through
 * their own endpoints that construct a credentialed gateway (flagged as live-wiring in the report).
 */
export async function handleMetricsRead(ctx: HubContext, q: MetricsQuery): Promise<HandlerResponse> {
  if (!SNAPSHOT_SOURCES.has(q.source)) return { status: 400, body: { error: `unknown or non-snapshot source: ${q.source}` } }
  if (!ctx.session.capabilities.includes("read")) return { status: 403, body: { error: "forbidden" } }

  const to = q.to ?? new Date().toISOString().slice(0, 10)
  const from = q.from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
  const bounds = { startDate: from, endDate: to }
  const clientId = q.clientId ?? ""

  switch (q.source) {
    case "callrail":
      return readToResponse(await getCallRailMetricsForClient(ctx.repos, clientId, bounds))
    case "ga4":
      return readToResponse(await getGa4Analytics(ctx.repos, clientId, bounds))
    case "gbp":
      return readToResponse(await getGbpLiveDataAggregated(ctx.repos, clientId, bounds))
    case "lsa":
      // LSA is account-keyed; clientId here is the google_ads_customer_id.
      return readToResponse(await fetchAccountSummaryMetrics(ctx.repos, clientId, bounds))
    case "meta":
      return readToResponse(await getFbClientData(ctx.repos, clientId))
    case "stripe":
      return readToResponse(await getStripeOverviewStats(ctx.repos))
    default:
      return { status: 400, body: { error: "unreachable" } }
  }
}

/** GET /v1/sync-log?source=... — a tenant-scoped view of recent sync runs (§11 sync observability). */
export async function handleSyncLog(ctx: HubContext, source: string, limit = 20): Promise<HandlerResponse> {
  if (!ctx.session.capabilities.includes("read")) return { status: 403, body: { error: "forbidden" } }
  const rows = await ctx.repos.syncLog.recent(source, limit)
  return { status: 200, body: { data: rows } }
}
