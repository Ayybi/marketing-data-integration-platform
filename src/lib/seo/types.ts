// NEW (architecture): the SEO provider PORT. SEO intelligence (domain metrics, backlinks, keyword
// ranks, quota) is vendor-agnostic; SEMrush is one ADAPTER behind this interface. Callers depend only
// on SeoProvider, so switching vendors (Ahrefs, Moz, a Google-only stack) is "add an adapter + set
// SEO_PROVIDER" with zero caller changes.
//
// Normalized output: every adapter returns THESE shapes (it maps its vendor fields in), so callers get
// the same result regardless of which service is configured. The three-state read contract (§12) holds
// at the port: present / absent / error, never conflated.
import type { ReadResult } from "../result"

export type SeoCapability = "overview" | "backlinks" | "keywords" | "quota"

/** Normalized domain overview. `rank` = the vendor's domain rank (lower is better). */
export type SeoDomainOverview = { organicTraffic: number; organicKeywords: number; rank: number }

/** Normalized backlink profile. `authorityScore` = the vendor's 0-100 domain-authority metric
 *  (SEMrush Authority Score, Ahrefs DR, Moz DA — normalized to one field). */
export type SeoBacklinks = { authorityScore: number; totalBacklinks: number; referringDomains: number }

/** Normalized organic keyword. */
export type SeoKeyword = { phrase: string; position: number; volume: number }

/** Generic quota/metering three-state. Metered vendors report a balance; unmetered ones "unlimited". */
export type SeoQuota =
  | { kind: "ok"; balance: number }
  | { kind: "unlimited" }
  | { kind: "unconfigured" }
  | { kind: "unreadable"; detail: string }

export type SeoReadOpts = {
  database?: string // locale/market (SEMrush "database", others may map to a country code)
  limit?: number
  throwOnQuota?: boolean // opt in to a SeoQuotaError on depletion (e.g. snapshot refresh marking a client depleted)
}

export interface SeoProvider {
  readonly name: string
  readonly capabilities: ReadonlySet<SeoCapability>
  domainOverview(domain: string, opts?: SeoReadOpts): Promise<ReadResult<SeoDomainOverview>>
  backlinks(domain: string, opts?: SeoReadOpts): Promise<ReadResult<SeoBacklinks>>
  organicKeywords(domain: string, opts?: SeoReadOpts): Promise<ReadResult<SeoKeyword[]>>
  quota(): Promise<SeoQuota>
}

/** Thrown by the factory when the selected provider has no credentials -> the route maps this to 501. */
export class SeoProviderNotConfigured extends Error {
  constructor(readonly provider: string) {
    super(`SEO provider "${provider}" not configured — set its API key (see WIRING.md)`)
    this.name = "SeoProviderNotConfigured"
  }
}

/** Thrown (opt-in) when a metered provider is depleted, so a caller can mark a client depleted. */
export class SeoQuotaError extends Error {
  constructor(readonly provider: string) {
    super(`SEO provider "${provider}" quota depleted`)
    this.name = "SeoQuotaError"
  }
}

/**
 * Standard result for a capability a provider does not implement. This is a CONFIG condition
 * (`unsupported_capability:<cap>`), distinct from a runtime read failure — callers can pre-check
 * `provider.capabilities.has(cap)`. It is never a fake zero/empty.
 */
export function unsupportedCapability<T>(cap: SeoCapability): ReadResult<T> {
  return { status: "error", error: `unsupported_capability:${cap}` }
}
