// NEW: OAuth authorization-code helpers for the per-tenant connect flow (doc B8). Google (GA4-Ads/GBP)
// and Meta. The token exchange is behind an injectable Fetcher so it tests without hitting a provider.
import type { Fetcher } from "../http"

export type OAuthService = "google_ads" | "google_business" | "meta"

export class ConnectNotConfigured extends Error {
  constructor(readonly service: string) {
    super(`OAuth app for "${service}" not configured — set its client id/secret (see WIRING.md)`)
    this.name = "ConnectNotConfigured"
  }
}

type ServiceConfig = {
  kind: "google" | "meta"
  scopes: string[]
  clientId?: string
  clientSecret?: string
  /** integrations `provider` under which the resulting token is stored (matches the connector resolvers). */
  credentialProvider: string
}

/** Static, credential-independent config (scopes + where the token is stored). The app client id/secret
 *  are resolved PER TENANT (BYO) and passed in — not read from env here. */
export function serviceConfig(service: OAuthService): ServiceConfig {
  switch (service) {
    case "google_business":
      return { kind: "google", scopes: ["https://www.googleapis.com/auth/business.manage"], credentialProvider: "google_business" }
    case "google_ads":
      return { kind: "google", scopes: ["https://www.googleapis.com/auth/adwords"], credentialProvider: "google_ads" }
    case "meta":
      return { kind: "meta", scopes: ["ads_read", "business_management", "leads_retrieval"], credentialProvider: "facebook" }
  }
}

export function isOAuthService(s: string): s is OAuthService {
  return s === "google_ads" || s === "google_business" || s === "meta"
}

export type OAuthApp = { clientId: string; clientSecret: string }

/** Build the provider authorize URL. `app` is the tenant's own OAuth app (client id/secret). */
export function buildAuthorizeUrl(service: OAuthService, state: string, redirectUri: string, app: OAuthApp): string {
  const cfg = serviceConfig(service)
  if (!app.clientId || !app.clientSecret) throw new ConnectNotConfigured(service)
  if (cfg.kind === "google") {
    const p = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      scope: cfg.scopes.join(" "),
      state,
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`
  }
  const p = new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, response_type: "code", scope: cfg.scopes.join(","), state })
  return `https://www.facebook.com/v21.0/dialog/oauth?${p}`
}

export type ExchangedToken = { token: string; kind: "refresh" | "access"; expiresAt?: string; credentialProvider: string }

/** Exchange a code for a token using the tenant's own OAuth app. Google -> refresh; Meta -> long-lived access. */
export async function exchangeCode(service: OAuthService, code: string, redirectUri: string, fetcher: Fetcher, app: OAuthApp): Promise<ExchangedToken> {
  const cfg = serviceConfig(service)
  if (!app.clientId || !app.clientSecret) throw new ConnectNotConfigured(service)

  if (cfg.kind === "google") {
    const res = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }).toString(),
    })
    if (!res.ok) throw new Error(`google token exchange failed: ${res.status}`)
    const json = (await res.json()) as { refresh_token?: string }
    if (!json.refresh_token) throw new Error("google token exchange returned no refresh_token (was prompt=consent used?)")
    return { token: json.refresh_token, kind: "refresh", credentialProvider: cfg.credentialProvider }
  }

  // Meta: code -> short-lived, then exchange to long-lived.
  const short = await fetcher(
    `https://graph.facebook.com/v21.0/oauth/access_token?${new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri, code })}`,
  )
  if (!short.ok) throw new Error(`meta token exchange failed: ${short.status}`)
  const shortJson = (await short.json()) as { access_token?: string }
  if (!shortJson.access_token) throw new Error("meta token exchange returned no access_token")

  const long = await fetcher(
    `https://graph.facebook.com/v21.0/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: app.clientId, client_secret: app.clientSecret, fb_exchange_token: shortJson.access_token })}`,
  )
  const longJson = long.ok ? ((await long.json()) as { access_token?: string; expires_in?: number }) : {}
  const token = longJson.access_token ?? shortJson.access_token
  const expiresAt = longJson.expires_in ? new Date(Date.now() + longJson.expires_in * 1000).toISOString() : undefined
  return { token, kind: "access", credentialProvider: cfg.credentialProvider, ...(expiresAt ? { expiresAt } : {}) }
}
