// Paid-ads platform REGISTRY. Unlike the single-swap SEO/call-tracking factories, this returns the
// adapter for a NAMED platform (you run several at once). To add a platform: write an adapter + a case.
import type { Repos } from "../db/types"
import { getMetaAccessToken } from "../meta"
import { MetaAdsProvider } from "./meta-provider"
import { GoogleAdsProvider } from "./google-ads-provider"
import { type PaidAdsProvider, AdsProviderNotConfigured } from "./types"

export * from "./types"
export { MetaAdsProvider } from "./meta-provider"
export { GoogleAdsProvider } from "./google-ads-provider"
export { FakeAdsProvider } from "./fake-provider"

export const AD_PLATFORMS = ["meta", "google_ads"] as const
export type AdPlatform = (typeof AD_PLATFORMS)[number]

export function listAdPlatforms(): readonly string[] {
  return AD_PLATFORMS
}
export function isAdPlatform(name: string): name is AdPlatform {
  return (AD_PLATFORMS as readonly string[]).includes(name)
}

const overrides = new Map<string, PaidAdsProvider>()

/**
 * Resolve a platform's adapter, wiring live credentials. Throws AdsProviderNotConfigured (-> 501) when a
 * platform's credentials are missing. The heavy Google Ads SDK is dynamic-imported only when needed.
 */
export async function getAdsProvider(platform: string, repos: Repos): Promise<PaidAdsProvider> {
  const override = overrides.get(platform)
  if (override) return override

  switch (platform) {
    case "meta": {
      const token = await getMetaAccessToken(repos, Date.now())
      if (!token) throw new AdsProviderNotConfigured("meta")
      return new MetaAdsProvider(token.accessToken)
    }
    case "google_ads": {
      // Dynamic import: keeps google-ads-api out of the module graph unless this platform is used.
      const { buildLsaGateway, GatewayNotConfigured } = await import("../gateways")
      try {
        return new GoogleAdsProvider(buildLsaGateway())
      } catch (e) {
        if (e instanceof GatewayNotConfigured) throw new AdsProviderNotConfigured("google_ads")
        throw e
      }
    }
    default:
      throw new Error(`Unknown ad platform: "${platform}"`)
  }
}

/** Test/DI hook: force a provider for a platform without touching env. Pass null to clear. */
export function setAdsProvider(platform: string, p: PaidAdsProvider | null): void {
  if (p) overrides.set(platform, p)
  else overrides.delete(platform)
}
