// CallRail connector FACADE. The vendor-specific fetch now lives behind the CallTrackingProvider port
// (src/lib/calltracking/*); CallRail is one adapter. This file preserves the original public surface
// (existing routes/crons/tests import from here) while delegating to the provider-agnostic core.
//
// To swap vendors set CALL_TRACKING_PROVIDER and add an adapter in calltracking/ — syncCallRail and the
// stored-snapshot reads below are already provider-neutral.
import type { Fetcher } from "./http"
import type { Repos, CallRailSnapshotRow } from "./db/types"
import type { ReadResult } from "./result"
import type { SyncResult } from "./sync-log"
import { toSyncLogEntry } from "./sync-log"
import {
  getCallTrackingProvider,
  syncCallTracking,
  selectedProviderName,
  CallTrackingNotConfigured,
  aggregateCallSnapshots,
  mapRawCallToTracked,
  resolveCallRailKey,
} from "./calltracking"
import type { RawCall } from "./calltracking"

// Backward-compat re-exports of names NOT bound locally above.
export {
  callRailGet,
  getAgencyAccountId,
  fetchCompanies,
  fetchCallsForCompany,
  CallRailProvider,
  setCallTrackingProvider,
  FakeCallTrackingProvider,
} from "./calltracking"
export type { CallRailCompany, CallTrackingProvider, TrackedCall, TrackedCompany } from "./calltracking"
// Re-export locally-bound names (imported above and used in this file).
export { getCallTrackingProvider, syncCallTracking, resolveCallRailKey, mapRawCallToTracked }
export type { RawCall }

export type Bounds = { startDate: string; endDate: string } // YYYY-MM-DD inclusive

export async function isCallRailConfigured(repos: Repos): Promise<boolean> {
  return (await resolveCallRailKey(repos)).status === "present"
}

/**
 * Aggregate CallRail raw calls into daily snapshots (backward-compatible signature). Delegates to the
 * provider-agnostic aggregator after mapping CallRail's raw shape into normalized calls.
 */
export function normalizeSnapshots(
  accountId: string,
  companyId: string,
  companyName: string,
  clientId: string,
  calls: RawCall[],
): Array<Omit<CallRailSnapshotRow, "orgId">> {
  return aggregateCallSnapshots(accountId, companyId, companyName, clientId, calls.map(mapRawCallToTracked))
}

/**
 * Sweep and sync call-tracking snapshots. Honors CALL_TRACKING_PROVIDER (default "callrail"): builds the
 * selected provider and runs the provider-agnostic sync. If no credential is configured, aborts to an
 * error sync_log (never records success/zeros) — preserving the original CallRail behavior.
 */
export async function syncCallRail(repos: Repos, opts: { fetcher?: Fetcher; windowDays?: number } = {}): Promise<SyncResult> {
  let provider
  try {
    provider = await getCallTrackingProvider(repos, opts.fetcher ? { fetcher: opts.fetcher } : undefined)
  } catch (e) {
    const reason = e instanceof CallTrackingNotConfigured ? `${e.provider} not configured` : e instanceof Error ? e.message : String(e)
    const result: SyncResult = { processed: 0, errors: 1, total: 0, errorSample: [reason] }
    await repos.syncLog.write(toSyncLogEntry(selectedProviderName(), "snapshot", result))
    return result
  }
  return syncCallTracking(repos, provider, opts.windowDays !== undefined ? { windowDays: opts.windowDays } : {})
}

// ---- Reads (stored snapshots; already provider-agnostic) ----

export type CallRailMetrics = {
  totalCalls: number
  answeredCalls: number
  missedCalls: number
  firstTimeCallers: number
  qualifiedLeads: number
  totalDurationSeconds: number
}

/**
 * Aggregate stored snapshots for a client. `absent` ONLY for a missing mapping (genuine "not
 * connected"), `error` when the mapping lookup failed, `present` otherwise — never zeros on an error.
 */
export async function getCallRailMetricsForClient(repos: Repos, clientId: string, bounds: Bounds): Promise<ReadResult<CallRailMetrics>> {
  const mapping = await repos.callrail.getMappingByClient(clientId)
  if (mapping.status === "absent") return { status: "absent" }
  if (mapping.status === "error") return { status: "error", error: mapping.error }

  const rows = await repos.callrail.snapshotsForClient(clientId, bounds.startDate, bounds.endDate)
  const acc: CallRailMetrics = { totalCalls: 0, answeredCalls: 0, missedCalls: 0, firstTimeCallers: 0, qualifiedLeads: 0, totalDurationSeconds: 0 }
  for (const r of rows) {
    acc.totalCalls += r.totalCalls
    acc.answeredCalls += r.answeredCalls
    acc.missedCalls += r.missedCalls
    acc.firstTimeCallers += r.firstTimeCallers
    acc.qualifiedLeads += r.qualifiedLeads
    acc.totalDurationSeconds += r.totalDurationSeconds
  }
  return { status: "present", value: acc }
}

export type CallDay = { date: string; totalCalls: number; answeredCalls: number; qualifiedLeads: number }

/** Per-day call series for a client (from stored snapshots). Three-state on the mapping. */
export async function getCallRailCallsByDayForClient(repos: Repos, clientId: string, bounds: Bounds): Promise<ReadResult<CallDay[]>> {
  const mapping = await repos.callrail.getMappingByClient(clientId)
  if (mapping.status === "absent") return { status: "absent" }
  if (mapping.status === "error") return { status: "error", error: mapping.error }
  const rows = await repos.callrail.snapshotsForClient(clientId, bounds.startDate, bounds.endDate)
  const byDay = new Map<string, CallDay>()
  for (const r of rows) {
    const d = byDay.get(r.snapshotDate) ?? { date: r.snapshotDate, totalCalls: 0, answeredCalls: 0, qualifiedLeads: 0 }
    d.totalCalls += r.totalCalls
    d.answeredCalls += r.answeredCalls
    d.qualifiedLeads += r.qualifiedLeads
    byDay.set(r.snapshotDate, d)
  }
  return { status: "present", value: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)) }
}
