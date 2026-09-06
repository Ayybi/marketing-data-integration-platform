// NEW: identity store (orgs / users / api keys). NOT org-scoped — this is the auth backbone that maps a
// bearer API key to an orgId. API keys are stored as sha256 HASHES (never plaintext); the raw key is
// shown once at creation.
import type { Db } from "mongodb"
import { createHash, randomBytes } from "node:crypto"
import { COLLECTIONS, getDb } from "../db/mongo/client"
import type { ReadResult } from "../result"

export type OrgRow = { orgId: string; name: string; createdAt: string }
export type UserRow = { userId: string; orgId: string; email: string; passwordHash: string; role: "owner" | "member"; createdAt: string }
export type ApiKeyRow = { keyId: string; orgId: string; keyHash: string; prefix: string; capabilities: string[]; label?: string; createdAt: string; revokedAt?: string | null }
export type SessionRow = { tokenHash: string; orgId: string; userId: string; capabilities: string[]; createdAt: Date; expiresAt: Date }

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

function id(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`
}
function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

export interface IdentityStore {
  createOrg(name: string): Promise<OrgRow>
  getOrg(orgId: string): Promise<ReadResult<OrgRow>>
  createUser(orgId: string, email: string, passwordHash: string, role?: "owner" | "member"): Promise<UserRow>
  getUserByEmail(email: string): Promise<ReadResult<UserRow>>
  /** Create an API key; returns the row PLUS the plaintext key (shown once). */
  createApiKey(orgId: string, capabilities: string[], label?: string): Promise<{ row: ApiKeyRow; key: string }>
  verifyApiKey(key: string): Promise<{ orgId: string; capabilities: string[] } | null>
  listApiKeys(orgId: string): Promise<ApiKeyRow[]>
  revokeApiKey(orgId: string, keyId: string): Promise<void>
  // Browser sessions (cookie-based)
  createSession(orgId: string, userId: string, capabilities: string[]): Promise<{ token: string; expiresAt: Date }>
  verifySession(token: string): Promise<{ orgId: string; capabilities: string[] } | null>
  destroySession(token: string): Promise<void>
}

export function makeIdentityStore(db: Db): IdentityStore {
  return {
    async createOrg(name) {
      const row: OrgRow = { orgId: id("org"), name, createdAt: new Date().toISOString() }
      await db.collection<OrgRow>(COLLECTIONS.orgs).insertOne(row)
      return row
    },
    async getOrg(orgId) {
      try {
        const row = await db.collection<OrgRow>(COLLECTIONS.orgs).findOne({ orgId })
        return row ? { status: "present", value: row } : { status: "absent" }
      } catch (e) {
        return { status: "error", error: e instanceof Error ? e.message : String(e) }
      }
    },
    async createUser(orgId, email, passwordHash, role = "owner") {
      const row: UserRow = { userId: id("usr"), orgId, email: email.toLowerCase(), passwordHash, role, createdAt: new Date().toISOString() }
      await db.collection<UserRow>(COLLECTIONS.users).insertOne(row)
      return row
    },
    async getUserByEmail(email) {
      try {
        const row = await db.collection<UserRow>(COLLECTIONS.users).findOne({ email: email.toLowerCase() })
        return row ? { status: "present", value: row } : { status: "absent" }
      } catch (e) {
        return { status: "error", error: e instanceof Error ? e.message : String(e) }
      }
    },
    async createApiKey(orgId, capabilities, label) {
      const key = `mdh_${randomBytes(24).toString("base64url")}`
      const row: ApiKeyRow = { keyId: id("key"), orgId, keyHash: sha256(key), prefix: key.slice(0, 12), capabilities, label, createdAt: new Date().toISOString(), revokedAt: null }
      await db.collection<ApiKeyRow>(COLLECTIONS.apiKeys).insertOne(row)
      return { row, key }
    },
    async verifyApiKey(key) {
      if (!key) return null
      const row = await db.collection<ApiKeyRow>(COLLECTIONS.apiKeys).findOne({ keyHash: sha256(key), revokedAt: null })
      return row ? { orgId: row.orgId, capabilities: row.capabilities } : null
    },
    async listApiKeys(orgId) {
      return db.collection<ApiKeyRow>(COLLECTIONS.apiKeys).find({ orgId }).project({ keyHash: 0 }).toArray() as Promise<ApiKeyRow[]>
    },
    async revokeApiKey(orgId, keyId) {
      await db.collection<ApiKeyRow>(COLLECTIONS.apiKeys).updateOne({ orgId, keyId }, { $set: { revokedAt: new Date().toISOString() } })
    },
    async createSession(orgId, userId, capabilities) {
      const token = randomBytes(32).toString("base64url")
      const now = new Date()
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS)
      await db.collection<SessionRow>(COLLECTIONS.sessions).insertOne({ tokenHash: sha256(token), orgId, userId, capabilities, createdAt: now, expiresAt })
      return { token, expiresAt }
    },
    async verifySession(token) {
      if (!token) return null
      const row = await db.collection<SessionRow>(COLLECTIONS.sessions).findOne({ tokenHash: sha256(token) })
      if (!row || row.expiresAt.getTime() <= Date.now()) return null
      return { orgId: row.orgId, capabilities: row.capabilities }
    },
    async destroySession(token) {
      if (!token) return
      await db.collection<SessionRow>(COLLECTIONS.sessions).deleteOne({ tokenHash: sha256(token) })
    },
  }
}

export function identityStore(db?: Db): IdentityStore {
  return makeIdentityStore(db ?? getDb())
}
