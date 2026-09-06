// Google Ads (LSA) ADAPTER for the PaidAdsProvider port. Reads live via the injectable LsaGateway and
// aggregates leads + daily spend/impressions into normalized AdInsights. LSA does not expose
// clicks/ctr/cpc in the same sense, so those are left UNDEFINED (never a fake 0).
import type { ReadResult } from "../result"
import type { LsaGateway, LsaBounds } from "../lsa"
import type { PaidAdsProvider, AdInsights, AdBounds } from "./types"

export class GoogleAdsProvider implements PaidAdsProvider {
  readonly platform = "google_ads"
  constructor(
    private gateway: LsaGateway,
    private loginCustomerId?: string,
  ) {}

  async accountInsights(accountId: string, bounds: AdBounds): Promise<ReadResult<AdInsights>> {
    const lsaBounds: LsaBounds = { startDate: bounds.startDate, endDate: bounds.endDate }
    try {
      const [leads, metrics] = await Promise.all([
        this.gateway.fetchLeads(accountId, this.loginCustomerId, lsaBounds),
        this.gateway.fetchDailyMetrics(accountId, this.loginCustomerId, lsaBounds),
      ])
      let spend = 0
      let impressions = 0
      for (const m of metrics) {
        spend += m.costMicros / 1_000_000
        impressions += m.impressions
      }
      const leadCount = leads.length
      return {
        status: "present",
        value: {
          platform: this.platform,
          spend: Math.round(spend * 100) / 100,
          impressions,
          leads: leadCount,
          cpl: leadCount > 0 ? Math.round((spend / leadCount) * 100) / 100 : 0,
          // clicks / ctr / cpc: not measured by LSA -> intentionally undefined
        },
      }
    } catch (e) {
      return { status: "error", error: e instanceof Error ? e.message : String(e) }
    }
  }
}
