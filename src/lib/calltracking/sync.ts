// Provider-agnostic call-tracking sync. Sweeps active mappings, pulls calls via the PROVIDER, aggregates
// to daily snapshots + per-call rows, and writes one sync_log row (source = provider.name). A per-company
// failure is counted (partial), leaving other companies' stored data intact — a transient vendor blip
// never wipes metrics (§6, §12). Identical discipline regardless of which vendor is plugged in.
import type { Repos } from "../db/types"
import { type SyncResult, toSyncLogEntry, SYNC_ERROR_SAMPLE_CAP } from "../sync-log"
import type { CallTrackingProvider } from "./types"
import { aggregateCallSnapshots, trackedCallToRow } from "./aggregate"

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
}

export async function syncCallTracking(repos: Repos, provider: CallTrackingProvider, opts: { windowDays?: number } = {}): Promise<SyncResult> {
  const windowDays = opts.windowDays ?? 3
  const bounds = { startDate: daysAgo(windowDays), endDate: daysAgo(0) }

  const mappings = await repos.callrail.activeMappings()
  const errorSample: string[] = []
  let processed = 0
  let errors = 0
  let recordsAffected = 0

  // Resolve the account once; a failure here fails the whole run (nothing to write against).
  let accountId: string
  try {
    accountId = mappings[0]?.callrailAccountId || (await provider.resolveAccountId())
  } catch (e) {
    const result: SyncResult = { processed: 0, errors: 1, total: mappings.length, errorSample: [`account resolve: ${errText(e)}`] }
    await repos.syncLog.write(toSyncLogEntry(provider.name, "snapshot", result))
    return result
  }

  const companyNames = new Map<string, string>()
  try {
    for (const c of await provider.listCompanies(accountId)) companyNames.set(c.companyId, c.name)
  } catch {
    // Non-fatal: names are cosmetic; proceed with mapping ids.
  }

  for (const m of mappings) {
    try {
      const calls = await provider.fetchCalls(m.callrailAccountId, m.callrailCompanyId, bounds)
      const snapshots = aggregateCallSnapshots(m.callrailAccountId, m.callrailCompanyId, companyNames.get(m.callrailCompanyId) ?? m.accountName ?? "", m.clientId, calls)
      for (const s of snapshots) {
        await repos.callrail.upsertSnapshot(s)
        recordsAffected += 1
      }
      for (const c of calls) await repos.callrail.upsertCall(trackedCallToRow(m.callrailCompanyId, m.clientId, c))
      processed += 1
    } catch (e) {
      errors += 1
      if (errorSample.length < SYNC_ERROR_SAMPLE_CAP) errorSample.push(`${m.callrailCompanyId}: ${errText(e)}`)
    }
  }

  const result: SyncResult = { processed, errors, total: mappings.length, errorSample }
  await repos.syncLog.write(toSyncLogEntry(provider.name, "snapshot", { ...result }, { recordsAffected }))
  return result
}
