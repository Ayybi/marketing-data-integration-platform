// LIVE WIRING for LSA / Google Ads (doc §4.5, B4 GAQL shapes). Turns Google Ads query rows into the
// connector's RawLsaLead[] / RawLsaDailyMetric[]. The GAQL execution sits behind LsaQueryFn so the
// query builders + mappers test with a fake (no live Google Ads); buildLsaGateway() supplies the real
// google-ads-api Customer.query.
//
// Note (LSA-02): this gateway does NOT classify errors into a "deactivate" signal — a query failure is
// thrown and the connector treats it as a transient error (keeps prior status, self-heals next run).
import type { LsaGateway, LsaBounds, RawLsaLead, RawLsaDailyMetric } from "./lsa"

export type LsaQueryParams = { customerId: string; loginCustomerId?: string; gaql: string }
export type LsaQueryFn = (params: LsaQueryParams) => Promise<Array<Record<string, unknown>>>

// ---- GAQL builders (B4, verbatim shapes) ----

export function leadsGaql(bounds: LsaBounds): string {
  return (
    `SELECT local_services_lead.id, local_services_lead.lead_type, local_services_lead.lead_status, ` +
    `local_services_lead.creation_date_time, local_services_lead.category_id, ` +
    `local_services_lead.lead_charged, local_services_lead.credit_details.credit_state ` +
    `FROM local_services_lead ` +
    `WHERE local_services_lead.creation_date_time >= '${bounds.startDate} 00:00:00' ` +
    `AND local_services_lead.creation_date_time <= '${bounds.endDate} 23:59:59'`
  )
}

export function dailyMetricsGaql(bounds: LsaBounds): string {
  return (
    `SELECT metrics.impressions, metrics.cost_micros, segments.date ` +
    `FROM campaign ` +
    `WHERE campaign.advertising_channel_type = 'LOCAL_SERVICES' ` +
    `AND segments.date >= '${bounds.startDate}' AND segments.date <= '${bounds.endDate}'`
  )
}

// ---- Row mappers (pure) ----

type LeadRow = {
  local_services_lead?: {
    id?: string | number
    lead_type?: string
    lead_status?: string
    creation_date_time?: string
    category_id?: string
    lead_charged?: boolean
    credit_details?: { credit_state?: string } | null
  }
}
type MetricRow = { metrics?: { impressions?: number | string; cost_micros?: number | string }; segments?: { date?: string } }

export function mapLead(row: Record<string, unknown>): RawLsaLead {
  const l = (row as LeadRow).local_services_lead ?? {}
  return {
    id: l.id ?? "",
    leadType: l.lead_type,
    leadStatus: l.lead_status,
    creationDateTime: l.creation_date_time,
    categoryId: l.category_id,
    leadCharged: l.lead_charged,
    creditState: l.credit_details?.credit_state,
  }
}

export function mapDailyMetric(row: Record<string, unknown>): RawLsaDailyMetric {
  const r = row as MetricRow
  return {
    date: r.segments?.date ?? "",
    impressions: Number(r.metrics?.impressions ?? 0),
    costMicros: Number(r.metrics?.cost_micros ?? 0),
  }
}

/** Build an LsaGateway over any GAQL query function (real google-ads-api Customer or a test fake). */
export function makeLsaGateway(runQuery: LsaQueryFn): LsaGateway {
  return {
    async fetchLeads(customerId, loginCustomerId, bounds) {
      const rows = await runQuery({ customerId, loginCustomerId, gaql: leadsGaql(bounds) })
      return rows.map(mapLead)
    },
    async fetchDailyMetrics(customerId, loginCustomerId, bounds) {
      const rows = await runQuery({ customerId, loginCustomerId, gaql: dailyMetricsGaql(bounds) })
      return rows.map(mapDailyMetric)
    },
  }
}
