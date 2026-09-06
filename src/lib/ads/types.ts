// NEW (architecture): the PAID-ADS provider PORT. Unlike the SEO / call-tracking ports (interchangeable
// vendors of ONE capability), Meta and Google Ads are DIFFERENT platforms you run together. So this is a
// MULTI-PLATFORM port (a registry of adapters), not a single-swap: each platform implements the port at
// the level they share, so callers can read EVERY ad platform uniformly and roll them up.
//
// Platform-specific richness (LSA lead types/charge buckets, Meta campaigns) stays in the concrete
// connectors, OUTSIDE this port. Fields a platform does not measure are `undefined`, never a fake 0.
import type { ReadResult } from "../result"

export type AdBounds = { startDate: string; endDate: string }

/** Normalized cross-platform ad metrics. spend/impressions/leads/cpl are common to every platform;
 *  clicks/ctr/cpc are optional (some platforms, e.g. LSA, don't expose them — left undefined). */
export type AdInsights = {
  platform: string
  spend: number
  impressions: number
  leads: number
  cpl: number
  clicks?: number
  ctr?: number
  cpc?: number
  currency?: string
}

export interface PaidAdsProvider {
  readonly platform: string
  /** Account insights over a window. Three-state (§12): present / absent / error, never a fake zero. */
  accountInsights(accountId: string, bounds: AdBounds): Promise<ReadResult<AdInsights>>
}

/** Thrown by the factory when a platform's credentials are missing -> the route maps this to 501. */
export class AdsProviderNotConfigured extends Error {
  constructor(readonly platform: string) {
    super(`Ad platform "${platform}" not configured — set its credentials (see WIRING.md)`)
    this.name = "AdsProviderNotConfigured"
  }
}

/** Cross-platform rollup: sum the normalized insights across platforms (the unified-schema payoff). */
export function combineAdInsights(list: AdInsights[]): { spend: number; impressions: number; leads: number; cpl: number; byPlatform: Record<string, AdInsights> } {
  let spend = 0
  let impressions = 0
  let leads = 0
  const byPlatform: Record<string, AdInsights> = {}
  for (const a of list) {
    spend += a.spend
    impressions += a.impressions
    leads += a.leads
    byPlatform[a.platform] = a
  }
  return { spend, impressions, leads, cpl: leads > 0 ? Math.round((spend / leads) * 100) / 100 : 0, byPlatform }
}
