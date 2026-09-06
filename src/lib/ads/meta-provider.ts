// Meta ADAPTER for the PaidAdsProvider port. Reuses the existing meta.ts fetch + normalization
// (incl. the BUG-07 grouped-lead rule) and maps FbOverview -> normalized AdInsights.
import type { Fetcher } from "../http"
import { defaultFetcher } from "../http"
import type { ReadResult } from "../result"
import { fetchAccountInsights, normalizeOverview } from "../meta"
import type { PaidAdsProvider, AdInsights, AdBounds } from "./types"

export class MetaAdsProvider implements PaidAdsProvider {
  readonly platform = "meta"
  constructor(
    private token: string,
    private fetcher: Fetcher = defaultFetcher,
  ) {}

  async accountInsights(accountId: string, bounds: AdBounds): Promise<ReadResult<AdInsights>> {
    let raw
    try {
      raw = await fetchAccountInsights(this.fetcher, this.token, accountId, bounds.startDate, bounds.endDate)
    } catch (e) {
      // A read failure is surfaced as error (never fake zeros). A 200-with-no-activity maps to zeros below.
      return { status: "error", error: e instanceof Error ? e.message : String(e) }
    }
    const o = normalizeOverview(raw) // BUG-07 grouped 'lead' action applied here
    return {
      status: "present",
      value: { platform: this.platform, spend: o.spend, impressions: o.impressions, clicks: o.clicks, ctr: o.ctr, cpc: o.cpc, leads: o.leads, cpl: o.cpl },
    }
  }
}
