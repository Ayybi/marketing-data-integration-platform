// Google Local Services Ads connector (doc §4.5, B4 GAQL shapes).
//
// Auth: OAuth 2.0 refresh token (google_connections provider='google_ads') + a developer token; MCC
// (manager) mode via login_customer_id. The GAQL calls are behind an injectable LsaGateway so the
// aggregation + failure discipline test without a live Google Ads account.
//
// Failure discipline (LSA-02, §12): a transient per-account failure does NOT flip the mapping to
// 'error'; it is caught, counted, sampled, and the account keeps its prior status and self-heals next
// run. persistLsaLeads is wrapped so a lead-detail write can never fail the snapshot.
import type { Repos, LsaSnapshotRow, LsaLeadRow, LsaMappingRow } from "./db/types"
import type { ReadResult } from "./result"
import { type SyncResult, toSyncLogEntry, SYNC_ERROR_SAMPLE_CAP } from "./sync-log"

export type LsaBounds = { startDate: string; endDate: string }

// ---- External call seam (GAQL) ----

export type RawLsaLead = {
  id: string | number
  leadType?: "PHONE_CALL" | "MESSAGE" | "BOOKING" | string
  leadStatus?: string
  creationDateTime?: string
  categoryId?: string
  leadCharged?: boolean
  creditState?: string // e.g. "CREDIT_STATE_..." from credit_details
}
export type RawLsaDailyMetric = { date: string; impressions: number; costMicros: number }

export interface LsaGateway {
  fetchLeads(customerId: string, loginCustomerId: string | undefined, bounds: LsaBounds): Promise<RawLsaLead[]>
  fetchDailyMetrics(customerId: string, loginCustomerId: string | undefined, bounds: LsaBounds): Promise<RawLsaDailyMetric[]>
}

export function isLsaConfigured(): boolean {
  return Boolean(process.env.GOOGLE_ADS_CLIENT_ID && process.env.GOOGLE_ADS_CLIENT_SECRET && process.env.GOOGLE_ADS_DEVELOPER_TOKEN)
}

// ---- Classification + aggregation (pure) ----

export type ChargeBucket = "charged" | "credited" | "in_review" | "not_charged"

/** Bucket a lead's charge state (§4.5). */
export function classifyCharge(lead: RawLsaLead): ChargeBucket {
  const credit = (lead.creditState ?? "").toUpperCase()
  if (credit.includes("CREDIT")) return "credited"
  if (credit.includes("REVIEW") || (lead.leadStatus ?? "").toUpperCase().includes("REVIEW")) return "in_review"
  if (lead.leadCharged === true) return "charged"
  return "not_charged"
}

function leadType(l: RawLsaLead): LsaLeadRow["leadType"] {
  return l.leadType === "MESSAGE" || l.leadType === "BOOKING" ? l.leadType : "PHONE_CALL"
}

/** Aggregate leads + daily metrics into one snapshot row per day. */
export function aggregateLeadsByDay(
  customerId: string,
  clientId: string,
  monthlyBudget: number,
  leads: RawLsaLead[],
  metrics: RawLsaDailyMetric[],
): Array<Omit<LsaSnapshotRow, "orgId">> {
  const byDay = new Map<string, Omit<LsaSnapshotRow, "orgId">>()
  const blank = (date: string): Omit<LsaSnapshotRow, "orgId"> => ({
    clientId, googleAdsCustomerId: customerId, date, totalLeads: 0, phoneCalls: 0, messages: 0, bookings: 0, impressions: 0, adSpend: 0, costPerLead: 0, budgetUtilization: 0,
  })
  for (const l of leads) {
    const date = (l.creationDateTime ?? "").slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const row = byDay.get(date) ?? blank(date)
    row.totalLeads += 1
    const t = leadType(l)
    if (t === "PHONE_CALL") row.phoneCalls += 1
    else if (t === "MESSAGE") row.messages += 1
    else row.bookings += 1
    byDay.set(date, row)
  }
  for (const m of metrics) {
    const date = m.date.slice(0, 10)
    const row = byDay.get(date) ?? blank(date)
    row.impressions += m.impressions
    row.adSpend += m.costMicros / 1_000_000
    byDay.set(date, row)
  }
  // Derive CPL + budget utilization (monthly budget is a whole-month figure; utilization is indicative).
  for (const row of byDay.values()) {
    row.costPerLead = row.totalLeads > 0 ? Math.round((row.adSpend / row.totalLeads) * 100) / 100 : 0
    row.budgetUtilization = monthlyBudget > 0 ? Math.round((row.adSpend / monthlyBudget) * 100) : 0
  }
  return [...byDay.values()]
}

// ---- Sync ----

/** Effective status honoring a manual pin (status_override). */
function effectiveStatus(m: LsaMappingRow): LsaMappingRow["status"] {
  return (m.statusOverride ?? m.status) as LsaMappingRow["status"]
}

/**
 * persistLsaLeads (§4.5): write per-lead rows, wrapped so a lead-detail write failure can NEVER fail the
 * snapshot. Returns how many failed (surfaced to the caller, not thrown).
 */
async function persistLsaLeads(repos: Repos, customerId: string, clientId: string, leads: RawLsaLead[]): Promise<number> {
  let failed = 0
  for (const l of leads) {
    try {
      await repos.lsa.upsertLead({
        googleAdsCustomerId: customerId,
        leadId: String(l.id),
        clientId,
        leadType: leadType(l),
        chargeBucket: classifyCharge(l),
        creationDateTime: l.creationDateTime,
        categoryId: l.categoryId,
      })
    } catch {
      failed += 1 // swallowed: the snapshot must still persist
    }
  }
  return failed
}

/**
 * Sweep active LSA accounts. On a transient per-account failure: count + sample, KEEP prior status
 * (LSA-02 — do NOT set 'error'), so the account self-heals next run and stored data is untouched.
 */
export async function syncLsa(repos: Repos, gateway: LsaGateway, bounds: LsaBounds): Promise<SyncResult> {
  const mappings = await repos.lsa.activeMappings()
  const errorSample: string[] = []
  let processed = 0
  let errors = 0
  let recordsAffected = 0

  for (const m of mappings) {
    if (effectiveStatus(m) === "paused") continue
    try {
      const [leads, metrics] = await Promise.all([
        gateway.fetchLeads(m.googleAdsCustomerId, m.loginCustomerId, bounds),
        gateway.fetchDailyMetrics(m.googleAdsCustomerId, m.loginCustomerId, bounds),
      ])
      const snapshots = aggregateLeadsByDay(m.googleAdsCustomerId, m.clientId, m.monthlyBudget, leads, metrics)
      for (const s of snapshots) {
        await repos.lsa.upsertSnapshot(s)
        recordsAffected += 1
      }
      // Lead-detail writes cannot fail the snapshot (§4.5).
      await persistLsaLeads(repos, m.googleAdsCustomerId, m.clientId, leads)
      processed += 1
    } catch (e) {
      // LSA-02: transient failure -> counted, sampled, status UNCHANGED (never flipped to 'error').
      errors += 1
      if (errorSample.length < SYNC_ERROR_SAMPLE_CAP) errorSample.push(`${m.googleAdsCustomerId}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const result: SyncResult = { processed, errors, total: mappings.length, errorSample }
  await repos.syncLog.write(toSyncLogEntry("lsa", "snapshot", result, { recordsAffected }))
  return result
}

// ---- Reads ----

export type LsaSummary = { totalLeads: number; phoneCalls: number; messages: number; bookings: number; impressions: number; adSpend: number; costPerLead: number }

/** Aggregate stored snapshots for an account. Three-state at the DB seam. */
export async function fetchAccountSummaryMetrics(repos: Repos, customerId: string, bounds: LsaBounds): Promise<ReadResult<LsaSummary>> {
  let rows: LsaSnapshotRow[]
  try {
    rows = await repos.lsa.snapshotsForCustomer(customerId, bounds.startDate, bounds.endDate)
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) }
  }
  if (rows.length === 0) return { status: "absent" }
  const acc: LsaSummary = { totalLeads: 0, phoneCalls: 0, messages: 0, bookings: 0, impressions: 0, adSpend: 0, costPerLead: 0 }
  for (const r of rows) {
    acc.totalLeads += r.totalLeads
    acc.phoneCalls += r.phoneCalls
    acc.messages += r.messages
    acc.bookings += r.bookings
    acc.impressions += r.impressions
    acc.adSpend += r.adSpend
  }
  acc.costPerLead = acc.totalLeads > 0 ? Math.round((acc.adSpend / acc.totalLeads) * 100) / 100 : 0
  return { status: "present", value: acc }
}
