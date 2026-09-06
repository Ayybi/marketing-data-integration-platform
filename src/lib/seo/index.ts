// SEO provider factory. Selects the vendor by SEO_PROVIDER (default "semrush") and builds its adapter.
// To add a vendor: write an adapter implementing SeoProvider, then add a case here — nothing else changes.
import { defaultFetcher } from "../http"
import { SemrushSeoProvider } from "./semrush-provider"
import { type SeoProvider, SeoProviderNotConfigured } from "./types"

export * from "./types"
export { SemrushSeoProvider } from "./semrush-provider"
export { FakeSeoProvider } from "./fake-provider"

let override: SeoProvider | null = null

/**
 * Resolve the configured SEO provider. Env: SEO_PROVIDER (default "semrush"). Each provider validates
 * its own credentials and throws SeoProviderNotConfigured (-> 501 at the route) when missing.
 * Optionally pass an apiKey (e.g. a per-tenant key resolved from the vault) to override the env key.
 */
export function getSeoProvider(opts?: { apiKey?: string }): SeoProvider {
  if (override) return override
  const name = (process.env.SEO_PROVIDER ?? "semrush").toLowerCase()
  switch (name) {
    case "semrush": {
      const key = opts?.apiKey ?? process.env.SEMRUSH_API_KEY
      if (!key) throw new SeoProviderNotConfigured("semrush")
      return new SemrushSeoProvider(defaultFetcher, key)
    }
    // case "ahrefs": { const key = ...; if (!key) throw new SeoProviderNotConfigured("ahrefs"); return new AhrefsSeoProvider(...) }
    // case "moz":    { ... }
    default:
      throw new Error(`Unknown SEO_PROVIDER: "${name}"`)
  }
}

/** Test/DI hook: force a specific provider (e.g. FakeSeoProvider) without touching env. */
export function setSeoProvider(p: SeoProvider | null): void {
  override = p
}
