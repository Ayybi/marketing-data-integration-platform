// Provider-agnostic aggregation: normalized TrackedCall[] -> daily snapshot rows + per-call rows.
// This is our domain logic and works over ANY provider's calls (it never touches a vendor field).
import type { CallRailSnapshotRow, CallRailCallRow } from "../db/types"
import type { TrackedCall } from "./types"

function dayOf(iso: string | undefined): string | null {
  if (!iso) return null
  const d = iso.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
}

/** Aggregate normalized calls into one snapshot row per (company, day). */
export function aggregateCallSnapshots(
  accountId: string,
  companyId: string,
  companyName: string,
  clientId: string,
  calls: TrackedCall[],
): Array<Omit<CallRailSnapshotRow, "orgId">> {
  const byDay = new Map<string, Omit<CallRailSnapshotRow, "orgId">>()
  for (const c of calls) {
    const day = dayOf(c.startTime)
    if (!day) continue
    let row = byDay.get(day)
    if (!row) {
      row = {
        clientId,
        callrailAccountId: accountId,
        callrailCompanyId: companyId,
        companyName,
        snapshotDate: day,
        totalCalls: 0,
        answeredCalls: 0,
        missedCalls: 0,
        firstTimeCallers: 0,
        qualifiedLeads: 0,
        totalDurationSeconds: 0,
      }
      byDay.set(day, row)
    }
    row.totalCalls += 1
    if (c.answered) row.answeredCalls += 1
    else row.missedCalls += 1
    if (c.firstTimeCaller) row.firstTimeCallers += 1
    if (c.qualifiedLead) row.qualifiedLeads += 1
    row.totalDurationSeconds += Number(c.durationSeconds ?? 0)
  }
  return [...byDay.values()]
}

/** Map a normalized call into a per-call storage row. */
export function trackedCallToRow(companyId: string, clientId: string, c: TrackedCall): Omit<CallRailCallRow, "orgId"> {
  return {
    callrailCallId: c.callId,
    callrailCompanyId: companyId,
    clientId,
    startTime: c.startTime,
    duration: c.durationSeconds,
    answered: c.answered,
    leadStatus: c.leadStatus,
    customerName: c.customerName,
    customerPhone: c.customerPhone,
    recordingUrl: c.recordingUrl,
    transcription: c.transcription,
  }
}
