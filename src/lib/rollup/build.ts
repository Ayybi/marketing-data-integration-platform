// NEW (§11): the unified cross-source daily rollup. Merges each source's STORED per-day snapshots into
// one row per (client, day): calls/leads (CallRail), sessions/conversions (GA4), views/actions (GBP),
// ad leads/spend (LSA). Sources without per-day snapshots (Meta overview, GSC live, Stripe agency-level)
// are intentionally excluded from the per-day rollup rather than faked in.
import type { Repos, CrossSourceRollupRow } from "../db/types"

export type RollupDay = Omit<CrossSourceRollupRow, "orgId">
export type RollupBounds = { startDate: string; endDate: string }

function blank(clientId: string, date: string): RollupDay {
  return { clientId, date, calls: 0, qualifiedLeads: 0, sessions: 0, conversions: 0, gbpViews: 0, gbpActions: 0, adLeads: 0, adSpend: 0 }
}

/** Build the per-day rollup for one client over a window (pure read of stored snapshots). */
export async function buildRollupForClient(repos: Repos, clientId: string, bounds: RollupBounds): Promise<RollupDay[]> {
  const byDay = new Map<string, RollupDay>()
  const get = (date: string) => {
    let r = byDay.get(date)
    if (!r) {
      r = blank(clientId, date)
      byDay.set(date, r)
    }
    return r
  }

  for (const s of await repos.callrail.snapshotsForClient(clientId, bounds.startDate, bounds.endDate)) {
    const r = get(s.snapshotDate)
    r.calls += s.totalCalls
    r.qualifiedLeads += s.qualifiedLeads
  }
  for (const s of await repos.ga4.snapshotsForClient(clientId, bounds.startDate, bounds.endDate)) {
    const r = get(s.snapshotDate)
    r.sessions += s.sessions
    r.conversions += s.conversions
  }
  for (const s of await repos.gbp.snapshotsForClient(clientId, bounds.startDate, bounds.endDate)) {
    const r = get(s.snapshotDate)
    r.gbpViews += s.views
    r.gbpActions += s.actions
  }
  // LSA is account-keyed; sum every LSA account mapped to this client.
  const lsaCustomers = (await repos.lsa.activeMappings()).filter((m) => m.clientId === clientId).map((m) => m.googleAdsCustomerId)
  for (const customerId of lsaCustomers) {
    for (const s of await repos.lsa.snapshotsForCustomer(customerId, bounds.startDate, bounds.endDate)) {
      const r = get(s.date)
      r.adLeads += s.totalLeads
      r.adSpend += s.adSpend
    }
  }

  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** Build + persist the rollup for one client. Returns the rows written. */
export async function persistRollupForClient(repos: Repos, clientId: string, bounds: RollupBounds): Promise<RollupDay[]> {
  const rows = await buildRollupForClient(repos, clientId, bounds)
  for (const row of rows) await repos.rollup.upsert(row)
  return rows
}

/** Build + persist rollups for every active client (drives the monthly rollup cron). */
export async function persistAllRollups(repos: Repos, bounds: RollupBounds): Promise<{ clients: number; rows: number }> {
  const clientIds = await repos.clients.activeClientIds()
  let rows = 0
  for (const clientId of clientIds) rows += (await persistRollupForClient(repos, clientId, bounds)).length
  return { clients: clientIds.length, rows }
}
