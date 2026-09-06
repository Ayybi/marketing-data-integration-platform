// NEW: connect orchestration — OAuth state (CSRF) store + credential persistence into the vault.
import type { Db } from "mongodb"
import { randomBytes } from "node:crypto"
import { COLLECTIONS, getDb } from "../db/mongo/client"
import { encrypt, integrationAad } from "../integrations/vault"
import type { Repos } from "../db/types"
import type { OAuthService } from "./oauth"

export function redirectBase(): string {
  return process.env.OAUTH_REDIRECT_BASE ?? "http://localhost:3000"
}
export function oauthCallbackUri(): string {
  return `${redirectBase()}/api/connect/oauth/callback`
}

type OAuthStateRow = { state: string; orgId: string; service: OAuthService; createdAt: Date }

/** Create a signed-enough random state, bound to org+service, with a TTL (index expires it). */
export async function createOAuthState(orgId: string, service: OAuthService, db?: Db): Promise<string> {
  const state = randomBytes(24).toString("base64url")
  await (db ?? getDb()).collection<OAuthStateRow>(COLLECTIONS.oauthStates).insertOne({ state, orgId, service, createdAt: new Date() })
  return state
}

/** Consume (single-use) an OAuth state. Returns null if unknown/expired. */
export async function consumeOAuthState(state: string, db?: Db): Promise<{ orgId: string; service: OAuthService } | null> {
  // mongodb v6 returns the deleted document directly (or null).
  const doc = await (db ?? getDb()).collection<OAuthStateRow>(COLLECTIONS.oauthStates).findOneAndDelete({ state })
  return doc ? { orgId: doc.orgId, service: doc.service } : null
}

/** Save an API-key credential (CallRail / SEMrush / Stripe) encrypted into the vault. */
export async function saveKeyCredential(
  repos: Repos,
  input: { provider: string; scope: "agency" | "client"; clientId?: string; apiKey: string },
): Promise<void> {
  const aad = integrationAad(input.scope, input.provider, input.clientId)
  await repos.credentials.save({
    provider: input.provider,
    scope: input.scope,
    clientId: input.scope === "client" ? (input.clientId ?? null) : null,
    status: "active",
    authPayload: encrypt(input.apiKey, aad),
  })
}

/**
 * Persist ANY per-tenant secret (a string key/token, or a JSON object like an OAuth app or service
 * account) encrypted into the vault under its provider. Objects are JSON-serialized.
 */
export async function saveTenantCredential(repos: Repos, provider: string, value: string | Record<string, unknown>): Promise<void> {
  const plaintext = typeof value === "string" ? value : JSON.stringify(value)
  await repos.credentials.save({ provider, scope: "agency", clientId: null, status: "active", authPayload: encrypt(plaintext, integrationAad("agency", provider)) })
}

/** Persist an OAuth token (refresh/access) encrypted into the vault under its connector provider. */
export async function saveOAuthCredential(repos: Repos, credentialProvider: string, token: string, expiresAt?: string): Promise<void> {
  const aad = integrationAad("agency", credentialProvider)
  await repos.credentials.save({
    provider: credentialProvider,
    scope: "agency",
    clientId: null,
    status: "active",
    authPayload: encrypt(token, aad),
    ...(expiresAt ? { metadata: { expires_at: expiresAt } } : {}),
  })
}
