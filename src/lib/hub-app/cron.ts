// NEW: cron runners (doc §8 schedule, B7). Each Next cron route verifies CRON_SECRET, then calls one of
// these to sweep tenants stalest-first (a single sweep across tenants, per §11). External clients
// (fetcher/gateways) are injected so the runners test without live APIs; production entrypoints build
// them from env + the credential vault.
import type { Repos } from "../db/types"
import type { SyncResult } from "../sync-log"
import { verifyCronSecret } from "../auth/cron"
import { syncCallRail } from "../callrail"
import { syncAllGbp, type GbpBounds } from "../gbp"
import { syncAllGa4, type Ga4Gateway, type Ga4Bounds } from "../ga4"
import { syncLsa, type LsaGateway, type LsaBounds } from "../lsa"
import { refreshFbOverviewSnapshots } from "../meta"
import { runFullStripeSync, StripeSyncAbortError, type StripeGateway } from "../stripe"
import type { Fetcher } from "../http"

export { verifyCronSecret }

/** How a cron resolves the tenants to sweep and gets a scoped repo for each. */
export type CronTenancy = {
  orgIds: string[]
  makeRepos: (orgId: string) => Repos
}

export type PerOrg<T> = { orgId: string; result: T }
export type CronSummary<T> = { tenants: number; runs: Array<PerOrg<T>> }

async function sweep<T>(t: CronTenancy, run: (repos: Repos) => Promise<T>): Promise<CronSummary<T>> {
  const runs: Array<PerOrg<T>> = []
  for (const orgId of t.orgIds) {
    runs.push({ orgId, result: await run(t.makeRepos(orgId)) })
  }
  return { tenants: t.orgIds.length, runs }
}

// ---- Per-source runners (doc B7) ----

export function runCallRailCron(t: CronTenancy, deps: { fetcher?: Fetcher; windowDays?: number } = {}): Promise<CronSummary<SyncResult>> {
  return sweep(t, (repos) => syncCallRail(repos, deps))
}

export function runGbpCron(t: CronTenancy, deps: { fetcher?: Fetcher; bounds: GbpBounds }): Promise<CronSummary<SyncResult>> {
  return sweep(t, (repos) => syncAllGbp(repos, deps))
}

export function runGa4Cron(t: CronTenancy, deps: { gateway: Ga4Gateway; bounds: Ga4Bounds }): Promise<CronSummary<SyncResult & { deactivated: number }>> {
  return sweep(t, (repos) => syncAllGa4(repos, deps.gateway, deps.bounds))
}

export function runLsaCron(t: CronTenancy, deps: { gateway: LsaGateway; bounds: LsaBounds }): Promise<CronSummary<SyncResult>> {
  return sweep(t, (repos) => syncLsa(repos, deps.gateway, deps.bounds))
}

export function runMetaCron(t: CronTenancy, deps: { fetcher?: Fetcher; since: string; until: string; nowMs: number }): Promise<CronSummary<SyncResult>> {
  return sweep(t, (repos) => refreshFbOverviewSnapshots(repos, deps))
}

/** Stripe cron swallows the controlled BUG-145 abort per tenant (logged partial) so one tenant's
 *  implausible roster never fails the whole sweep. */
export function runStripeCron(t: CronTenancy, deps: { gateway: StripeGateway }): Promise<CronSummary<{ aborted: boolean; mrrCents: number; processed: number }>> {
  return sweep(t, async (repos) => {
    try {
      const r = await runFullStripeSync(repos, deps.gateway)
      return { aborted: r.aborted, mrrCents: r.mrrCents, processed: r.processed }
    } catch (e) {
      if (e instanceof StripeSyncAbortError) return { aborted: true, mrrCents: 0, processed: 0 }
      throw e
    }
  })
}
