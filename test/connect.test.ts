import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import type { Fetcher, HttpResponse } from "../src/lib/http.js"
import { buildAuthorizeUrl, exchangeCode, serviceConfig, ConnectNotConfigured } from "../src/lib/connect/oauth.js"
import { createOAuthState, consumeOAuthState, saveKeyCredential, saveOAuthCredential } from "../src/lib/connect/service.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db

beforeAll(async () => {
  process.env.INTEGRATION_VAULT_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")
  process.env.GOOGLE_ADS_CLIENT_ID = "gads-id"
  process.env.GOOGLE_ADS_CLIENT_SECRET = "gads-secret"
  process.env.META_APP_ID = "meta-id"
  process.env.META_APP_SECRET = "meta-secret"
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_connect_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
  for (const k of ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "META_APP_ID", "META_APP_SECRET"]) delete process.env[k]
})
beforeEach(async () => {
  for (const c of ["oauth_states", "integrations"]) await db.collection(c).deleteMany({})
})

const json = (body: unknown, status = 200): HttpResponse => ({ status, ok: status < 300, text: async () => JSON.stringify(body), json: async () => body })
function route(fn: (url: string) => HttpResponse): Fetcher {
  return async (url) => fn(url)
}

const APP = { clientId: "app-id", clientSecret: "app-secret" }

describe("buildAuthorizeUrl", () => {
  it("google includes offline access + consent + scope + state", () => {
    const u = buildAuthorizeUrl("google_ads", "st8", "https://app/cb", APP)
    expect(u).toContain("accounts.google.com")
    expect(u).toContain("access_type=offline")
    expect(u).toContain("prompt=consent")
    expect(u).toContain("state=st8")
    expect(decodeURIComponent(u)).toContain("auth/adwords")
  })
  it("meta authorize url carries the tenant's client_id + state", () => {
    const u = buildAuthorizeUrl("meta", "st9", "https://app/cb", { clientId: "meta-id", clientSecret: "s" })
    expect(u).toContain("facebook.com")
    expect(u).toContain("client_id=meta-id")
    expect(u).toContain("state=st9")
  })
  it("throws ConnectNotConfigured when the app creds are empty", () => {
    expect(() => buildAuthorizeUrl("google_business", "s", "cb", { clientId: "", clientSecret: "" })).toThrow(ConnectNotConfigured)
  })
})

describe("exchangeCode", () => {
  it("google -> refresh token", async () => {
    const f = route(() => json({ refresh_token: "rt-123", access_token: "at" }))
    const r = await exchangeCode("google_ads", "code1", "https://app/cb", f, APP)
    expect(r).toMatchObject({ token: "rt-123", kind: "refresh", credentialProvider: "google_ads" })
  })
  it("google throws when no refresh_token returned", async () => {
    const f = route(() => json({ access_token: "at" }))
    await expect(exchangeCode("google_ads", "c", "cb", f, APP)).rejects.toThrow(/no refresh_token/)
  })
  it("meta -> long-lived access token", async () => {
    const f = route((url) => (url.includes("fb_exchange_token") ? json({ access_token: "long-tok", expires_in: 5184000 }) : json({ access_token: "short-tok" })))
    const r = await exchangeCode("meta", "code1", "https://app/cb", f, APP)
    expect(r.token).toBe("long-tok")
    expect(r.credentialProvider).toBe("facebook")
    expect(r.expiresAt).toBeTruthy()
  })
  it("meta config maps to the 'facebook' credential provider", () => {
    expect(serviceConfig("meta").credentialProvider).toBe("facebook")
  })
})

describe("OAuth state (single-use, CSRF)", () => {
  it("round-trips org+service and is single-use", async () => {
    const state = await createOAuthState("orgX", "meta", db)
    const first = await consumeOAuthState(state, db)
    expect(first).toEqual({ orgId: "orgX", service: "meta" })
    expect(await consumeOAuthState(state, db)).toBeNull() // already consumed
  })
})

describe("credential persistence (encrypted, resolvable by the connector)", () => {
  it("saveKeyCredential stores an encrypted key the connector can resolve", async () => {
    const repos = makeMongoRepos(db, "orgK")
    await saveKeyCredential(repos, { provider: "callrail", scope: "agency", apiKey: "CR-KEY" })
    const resolved = await repos.credentials.resolve("callrail", "agency")
    expect(resolved).toEqual({ status: "present", value: "CR-KEY" })
    // stored blob is not plaintext
    const doc = await db.collection("integrations").findOne({ orgId: "orgK", provider: "callrail" })
    expect(JSON.stringify(doc)).not.toContain("CR-KEY")
  })
  it("saveOAuthCredential stores a token resolvable under its provider", async () => {
    const repos = makeMongoRepos(db, "orgO")
    await saveOAuthCredential(repos, "google_business", "refresh-xyz", new Date(Date.now() + 1000).toISOString())
    expect(await repos.credentials.resolve("google_business", "agency")).toEqual({ status: "present", value: "refresh-xyz" })
  })
})
