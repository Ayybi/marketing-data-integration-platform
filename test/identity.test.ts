import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import { makeIdentityStore } from "../src/lib/identity/store.js"
import { hashPassword, verifyPassword } from "../src/lib/identity/passwords.js"
import { signup, login } from "../src/lib/identity/service.js"
import { getSession, SESSION_COOKIE } from "../src/lib/tenants.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_identity_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  for (const c of ["orgs", "users", "api_keys", "auth_sessions"]) await db.collection(c).deleteMany({})
})

function reqWith(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/v1/usage", { headers })
}

describe("password hashing (scrypt)", () => {
  it("round-trips and rejects wrong/tampered", () => {
    const h = hashPassword("s3cret-pass")
    expect(verifyPassword("s3cret-pass", h)).toBe(true)
    expect(verifyPassword("wrong", h)).toBe(false)
    expect(verifyPassword("s3cret-pass", "garbage")).toBe(false)
  })
})

describe("identity store — API keys (hashed)", () => {
  it("creates a key, verifies by hash, never stores plaintext", async () => {
    const store = makeIdentityStore(db)
    const org = await store.createOrg("Acme")
    const { row, key } = await store.createApiKey(org.orgId, ["read", "admin"], "test")
    expect(key.startsWith("mdh_")).toBe(true)

    // Stored doc has a hash, not the key.
    const stored = await db.collection("api_keys").findOne({ keyId: row.keyId })
    expect(stored?.keyHash).toBeTruthy()
    expect(JSON.stringify(stored)).not.toContain(key)

    // Verify resolves to org + capabilities.
    expect(await store.verifyApiKey(key)).toEqual({ orgId: org.orgId, capabilities: ["read", "admin"] })
    // Wrong key -> null.
    expect(await store.verifyApiKey("mdh_wrong")).toBeNull()
  })

  it("revoked keys stop verifying", async () => {
    const store = makeIdentityStore(db)
    const org = await store.createOrg("Acme")
    const { row, key } = await store.createApiKey(org.orgId, ["read"])
    expect(await store.verifyApiKey(key)).not.toBeNull()
    await store.revokeApiKey(org.orgId, row.keyId)
    expect(await store.verifyApiKey(key)).toBeNull()
  })
})

describe("sessions (cookie-based)", () => {
  it("createSession -> verifySession round-trips; destroy invalidates", async () => {
    const store = makeIdentityStore(db)
    const org = await store.createOrg("Acme")
    const { token } = await store.createSession(org.orgId, "usr_1", ["read", "admin"])
    expect(await store.verifySession(token)).toEqual({ orgId: org.orgId, capabilities: ["read", "admin"] })
    expect(await store.verifySession("bogus")).toBeNull()
    await store.destroySession(token)
    expect(await store.verifySession(token)).toBeNull()
  })

  it("getSession resolves a cookie session and a bearer key; null when neither", async () => {
    const store = makeIdentityStore(db)
    const org = await store.createOrg("Acme")
    const { token } = await store.createSession(org.orgId, "usr_1", ["read"])
    const { key } = await store.createApiKey(org.orgId, ["read", "admin"], "prog")

    // via cookie
    const viaCookie = await getSession(reqWith({ cookie: `${SESSION_COOKIE}=${token}` }), db)
    expect(viaCookie).toEqual({ orgId: org.orgId, capabilities: ["read"] })

    // via bearer key (takes precedence)
    const viaKey = await getSession(reqWith({ authorization: `Bearer ${key}` }), db)
    expect(viaKey).toEqual({ orgId: org.orgId, capabilities: ["read", "admin"] })

    // neither -> null (never fail open)
    expect(await getSession(reqWith({}), db)).toBeNull()
    expect(await getSession(reqWith({ cookie: `${SESSION_COOKIE}=tampered` }), db)).toBeNull()
  })
})

describe("signup / login", () => {
  it("signup creates org + owner (no API key); duplicate email rejected", async () => {
    const r = await signup({ email: "a@b.com", password: "password123", orgName: "Acme" }, db)
    expect(r.orgId).toBeTruthy()
    expect(r.userId).toBeTruthy()
    // No API key is minted at signup; the org + user exist.
    expect((await makeIdentityStore(db).getUserByEmail("a@b.com")).status).toBe("present")
    await expect(signup({ email: "a@b.com", password: "password123", orgName: "Dup" }, db)).rejects.toThrow(/already registered/)
  })

  it("login verifies the password", async () => {
    await signup({ email: "c@d.com", password: "password123", orgName: "Co" }, db)
    expect(await login({ email: "c@d.com", password: "password123" }, db)).toMatchObject({})
    expect(await login({ email: "c@d.com", password: "nope" }, db)).toBeNull()
    expect(await login({ email: "missing@x.com", password: "x" }, db)).toBeNull()
  })
})
