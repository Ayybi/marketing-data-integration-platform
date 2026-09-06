// NEW: identity service — signup (org + owner user + first admin API key) and login. Thin orchestration
// over the store + password hashing.
import type { Db } from "mongodb"
import { identityStore, type IdentityStore } from "./store"
import { hashPassword, verifyPassword } from "./passwords"

export const DEFAULT_CAPABILITIES = ["read", "write", "admin"]

export type SignupResult = { orgId: string; userId: string }

/**
 * Create an org + owner user. Does NOT mint an API key — browser access uses the login session cookie;
 * a developer API key is created on demand from the dashboard's Developer section when needed.
 */
export async function signup(input: { email: string; password: string; orgName: string }, db?: Db): Promise<SignupResult> {
  const store = identityStore(db)
  const existing = await store.getUserByEmail(input.email)
  if (existing.status === "present") throw new Error("email already registered")
  if (existing.status === "error") throw new Error(`identity read failed: ${existing.error}`)

  const org = await store.createOrg(input.orgName)
  const user = await store.createUser(org.orgId, input.email, hashPassword(input.password), "owner")
  return { orgId: org.orgId, userId: user.userId }
}

export async function login(input: { email: string; password: string }, db?: Db): Promise<{ orgId: string; userId: string } | null> {
  const store: IdentityStore = identityStore(db)
  const user = await store.getUserByEmail(input.email)
  if (user.status !== "present") return null
  if (!verifyPassword(input.password, user.value.passwordHash)) return null
  return { orgId: user.value.orgId, userId: user.value.userId }
}
