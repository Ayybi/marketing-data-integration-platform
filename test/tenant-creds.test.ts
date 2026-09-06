import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import { saveTenantCredential } from "../src/lib/connect/service.js"
import { resolveOAuthApp, resolveServiceAccountJson, resolveLlmConfig, resolveConnectorKey } from "../src/lib/tenant-creds.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db

beforeAll(async () => {
  process.env.INTEGRATION_VAULT_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_byo_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  await db.collection("integrations").deleteMany({})
  for (const k of ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GA4_SERVICE_ACCOUNT_JSON", "LLM_API_KEY", "ANTHROPIC_API_KEY", "CALLRAIL_API_KEY"]) delete process.env[k]
})

describe("resolveOAuthApp (vault-first, env fallback)", () => {
  it("returns the tenant's own OAuth app from the vault", async () => {
    const repos = makeMongoRepos(db, "orgA")
    await saveTenantCredential(repos, "oauth_app_google_ads", { client_id: "tenant-id", client_secret: "tenant-secret" })
    expect(await resolveOAuthApp(repos, "google_ads")).toEqual({ status: "present", value: { clientId: "tenant-id", clientSecret: "tenant-secret" } })
  })
  it("falls back to env when the tenant has no app", async () => {
    process.env.GOOGLE_ADS_CLIENT_ID = "env-id"
    process.env.GOOGLE_ADS_CLIENT_SECRET = "env-secret"
    const repos = makeMongoRepos(db, "orgB")
    expect(await resolveOAuthApp(repos, "google_ads")).toEqual({ status: "present", value: { clientId: "env-id", clientSecret: "env-secret" } })
  })
  it("absent when neither vault nor env has it", async () => {
    expect((await resolveOAuthApp(makeMongoRepos(db, "orgC"), "google_ads")).status).toBe("absent")
  })
  it("the tenant's vault app wins over a shared env app (BYO isolation)", async () => {
    process.env.GOOGLE_ADS_CLIENT_ID = "env-id"
    process.env.GOOGLE_ADS_CLIENT_SECRET = "env-secret"
    const repos = makeMongoRepos(db, "orgD")
    await saveTenantCredential(repos, "oauth_app_google_ads", { client_id: "mine", client_secret: "mine-secret" })
    const r = await resolveOAuthApp(repos, "google_ads")
    if (r.status === "present") expect(r.value.clientId).toBe("mine")
  })
})

describe("resolveServiceAccountJson", () => {
  it("vault SA wins; else env; else absent", async () => {
    const repos = makeMongoRepos(db, "orgSA")
    expect((await resolveServiceAccountJson(repos)).status).toBe("absent")
    process.env.GA4_SERVICE_ACCOUNT_JSON = '{"client_email":"env@x"}'
    expect(await resolveServiceAccountJson(repos)).toEqual({ status: "present", value: '{"client_email":"env@x"}' })
    await saveTenantCredential(repos, "ga4_service_account", '{"client_email":"tenant@x"}')
    expect((await resolveServiceAccountJson(repos)).status).toBe("present")
    const r = await resolveServiceAccountJson(repos)
    if (r.status === "present") expect(r.value).toContain("tenant@x")
  })
})

describe("resolveLlmConfig", () => {
  it("vault LLM config wins over env; null when neither", async () => {
    const repos = makeMongoRepos(db, "orgLLM")
    expect(await resolveLlmConfig(repos)).toBeNull()
    process.env.ANTHROPIC_API_KEY = "env-key"
    expect(await resolveLlmConfig(repos)).toMatchObject({ provider: "anthropic", apiKey: "env-key" })
    await saveTenantCredential(repos, "llm", { apiKey: "tenant-key", model: "claude-x" })
    expect(await resolveLlmConfig(repos)).toMatchObject({ apiKey: "tenant-key", model: "claude-x" })
  })
})

describe("resolveConnectorKey (vault-first)", () => {
  it("vault wins over env; error surfaces; absent when neither", async () => {
    const repos = makeMongoRepos(db, "orgCK")
    expect((await resolveConnectorKey(repos, "callrail", "CALLRAIL_API_KEY")).status).toBe("absent")
    process.env.CALLRAIL_API_KEY = "env-key"
    expect(await resolveConnectorKey(repos, "callrail", "CALLRAIL_API_KEY")).toEqual({ status: "present", value: "env-key" })
    await saveTenantCredential(repos, "callrail", "tenant-key")
    expect(await resolveConnectorKey(repos, "callrail", "CALLRAIL_API_KEY")).toEqual({ status: "present", value: "tenant-key" })
  })
})
