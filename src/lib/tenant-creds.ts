// NEW (BYO per-tenant credentials): resolve a tenant's own OAuth app, GCP service account, LLM key and
// connector keys from the per-org vault FIRST, falling back to process.env only as a shared default.
// This is what makes "every customer brings their own GCP / OAuth app / keys" work — each secret is
// encrypted per org (integrations vault) and a global env key never shadows a tenant's own.
import type { Repos } from "./db/types"
import type { ReadResult } from "./result"

export type OAuthAppService = "google_ads" | "google_business" | "meta"
export type OAuthApp = { clientId: string; clientSecret: string }

function envFor(service: OAuthAppService): OAuthApp | null {
  const map: Record<OAuthAppService, [string | undefined, string | undefined]> = {
    google_business: [process.env.GOOGLE_BUSINESS_CLIENT_ID ?? process.env.GOOGLE_ADS_CLIENT_ID, process.env.GOOGLE_BUSINESS_CLIENT_SECRET ?? process.env.GOOGLE_ADS_CLIENT_SECRET],
    google_ads: [process.env.GOOGLE_ADS_CLIENT_ID, process.env.GOOGLE_ADS_CLIENT_SECRET],
    meta: [process.env.META_APP_ID, process.env.META_APP_SECRET],
  }
  const [id, secret] = map[service]
  return id && secret ? { clientId: id, clientSecret: secret } : null
}

/** Resolve a tenant's OAuth app (client id/secret). Vault provider `oauth_app_<service>` → env. */
export async function resolveOAuthApp(repos: Repos, service: OAuthAppService): Promise<ReadResult<OAuthApp>> {
  const vault = await repos.credentials.resolve(`oauth_app_${service}`, "agency")
  if (vault.status === "error") return vault
  if (vault.status === "present") {
    try {
      const parsed = JSON.parse(vault.value) as { client_id?: string; clientId?: string; client_secret?: string; clientSecret?: string }
      const clientId = parsed.client_id ?? parsed.clientId
      const clientSecret = parsed.client_secret ?? parsed.clientSecret
      if (clientId && clientSecret) return { status: "present", value: { clientId, clientSecret } }
    } catch (e) {
      return { status: "error", error: `oauth app json: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  const env = envFor(service)
  return env ? { status: "present", value: env } : { status: "absent" }
}

/** Resolve the tenant's GA4/GCP service-account JSON string. Vault provider `ga4_service_account` → env. */
export async function resolveServiceAccountJson(repos: Repos): Promise<ReadResult<string>> {
  const vault = await repos.credentials.resolve("ga4_service_account", "agency")
  if (vault.status === "error" || vault.status === "present") return vault
  const env = process.env.GA4_SERVICE_ACCOUNT_JSON
  return env ? { status: "present", value: env } : { status: "absent" }
}

export type LlmConfig = { provider: string; apiKey: string; model?: string }

/** Resolve the tenant's LLM config. Vault provider `llm` (JSON {apiKey,provider?,model?}) → env. Null if none. */
export async function resolveLlmConfig(repos: Repos): Promise<LlmConfig | null> {
  const vault = await repos.credentials.resolve("llm", "agency")
  if (vault.status === "present") {
    try {
      const p = JSON.parse(vault.value) as { apiKey?: string; key?: string; provider?: string; model?: string }
      const apiKey = p.apiKey ?? p.key
      if (apiKey) return { provider: p.provider ?? "anthropic", apiKey, model: p.model }
    } catch {
      /* fall through to env */
    }
  }
  const apiKey = process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  return { provider: process.env.LLM_PROVIDER ?? "anthropic", apiKey, model: process.env.LLM_MODEL ?? process.env.ANTHROPIC_MODEL }
}

/** Generic connector-key resolver: vault provider FIRST, then an env fallback. Preserves three-state. */
export async function resolveConnectorKey(repos: Repos, provider: string, envName: string): Promise<ReadResult<string>> {
  const vault = await repos.credentials.resolve(provider, "agency")
  if (vault.status === "present" || vault.status === "error") return vault
  const env = process.env[envName]
  return env ? { status: "present", value: env } : { status: "absent" }
}
