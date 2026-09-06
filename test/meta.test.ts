import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import type { Repos } from "../src/lib/db/types.js"
import type { Fetcher, HttpResponse } from "../src/lib/http.js"
import {
  extractLeads,
  normalizeOverview,
  getMetaAccessToken,
  resetMetaTokenCache,
  refreshFbOverviewSnapshots,
  getFbClientData,
  computeCplTarget,
} from "../src/lib/meta.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db
let repos: Repos

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_meta_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  await db.collection("fb_account_mappings").deleteMany({})
  await db.collection("fb_overview_snapshots").deleteMany({})
  await db.collection("integrations").deleteMany({})
  await db.collection("sync_log").deleteMany({})
  repos = makeMongoRepos(db, "orgM")
  resetMetaTokenCache()
  delete process.env.META_ACCESS_TOKEN
})

const insights = (json: unknown, status = 200): HttpResponse => ({ status, ok: status < 300, text: async () => JSON.stringify(json), json: async () => json })
function route(fn: (url: string) => HttpResponse | "throw"): Fetcher {
  return async (url) => {
    const r = fn(url)
    if (r === "throw") throw new Error("transport")
    return r
  }
}

describe("extractLeads (BUG-07: grouped 'lead' action, no double counting)", () => {
  it("uses the single grouped 'lead' action, ignoring lead.* subtypes", () => {
    const actions = [
      { action_type: "lead", value: "12" }, // the grouped total
      { action_type: "onsite_conversion.lead_grouped", value: "12" },
      { action_type: "offsite_conversion.fb_pixel_lead", value: "7" },
    ]
    expect(extractLeads(actions)).toBe(12) // NOT 12+12+7
  })
  it("0 only when there is genuinely no 'lead' action", () => {
    expect(extractLeads([{ action_type: "link_click", value: "3" }])).toBe(0)
    expect(extractLeads(undefined)).toBe(0)
  })
})

describe("normalizeOverview (pure)", () => {
  it("computes cpl from grouped leads", () => {
    const o = normalizeOverview({ spend: "100", impressions: "1000", clicks: "50", actions: [{ action_type: "lead", value: "4" }] })
    expect(o.leads).toBe(4)
    expect(o.cpl).toBe(25)
    expect(o.spend).toBe(100)
  })
})

describe("getMetaAccessToken (5-min cache, oauth->env fallback)", () => {
  it("prefers a stored oauth token, caches it", async () => {
    const { encrypt, integrationAad } = await import("../src/lib/integrations/vault.js")
    process.env.INTEGRATION_VAULT_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")
    await repos.credentials.save({ scope: "agency", provider: "facebook", status: "active", authPayload: encrypt("oauth-tok", integrationAad("agency", "facebook")) })
    const t = await getMetaAccessToken(repos, 1000)
    expect(t).toMatchObject({ accessToken: "oauth-tok", source: "oauth" })
  })
  it("falls back to META_ACCESS_TOKEN when no oauth credential", async () => {
    process.env.META_ACCESS_TOKEN = "sys-user-tok"
    const t = await getMetaAccessToken(repos, 2000)
    expect(t).toMatchObject({ accessToken: "sys-user-tok", source: "env" })
  })
  it("null when neither source is available", async () => {
    expect(await getMetaAccessToken(repos, 3000)).toBeNull()
  })
})

describe("refreshFbOverviewSnapshots + getFbClientData (stored snapshot = source of truth)", () => {
  beforeEach(() => {
    process.env.META_ACCESS_TOKEN = "tok"
  })

  it("stores the overview and reads it back", async () => {
    await repos.fb.upsertMapping({ clientId: "c1", fbAccountId: "act_1", status: "active" })
    const f = route(() => insights({ data: [{ spend: "80", impressions: "800", clicks: "40", actions: [{ action_type: "lead", value: "4" }] }] }))
    const res = await refreshFbOverviewSnapshots(repos, { fetcher: f, since: "2026-01-01", until: "2026-01-31", nowMs: 10_000 })
    expect(res.processed).toBe(1)
    const data = await getFbClientData(repos, "c1")
    expect(data.status).toBe("present")
    if (data.status === "present") expect(data.value.leads).toBe(4)
  })

  // INVARIANT: a failed account is isolated as an error row; its LAST GOOD numbers are not overwritten,
  // and the read surfaces error (never a blended/fake zero).
  it("a failed refresh isolates an error row and preserves the last good overview numbers", async () => {
    await repos.fb.upsertMapping({ clientId: "c2", fbAccountId: "act_2", status: "active" })
    resetMetaTokenCache()
    // First: a good snapshot (leads=6).
    await refreshFbOverviewSnapshots(repos, {
      fetcher: route(() => insights({ data: [{ spend: "60", impressions: "600", clicks: "30", actions: [{ action_type: "lead", value: "6" }] }] })),
      since: "2026-01-01", until: "2026-01-31", nowMs: 20_000,
    })
    resetMetaTokenCache()
    // Then: the account read fails.
    const res = await refreshFbOverviewSnapshots(repos, { fetcher: route(() => insights({}, 500)), since: "2026-01-01", until: "2026-01-31", nowMs: 30_000 })
    expect(res.errors).toBe(1)

    // The stored row is now an error row -> read surfaces error, NOT a fake zero.
    const data = await getFbClientData(repos, "c2")
    expect(data.status).toBe("error")

    // But the last good numbers were preserved on the row (not blanked to 0).
    const row = await db.collection("fb_overview_snapshots").findOne({ orgId: "orgM", fbAccountId: "act_2", dateRange: "30d" })
    expect(row?.overview.leads).toBe(6)
    expect(row?.status).toBe("error")
  })

  it("getFbClientData is absent for an unmapped client", async () => {
    expect((await getFbClientData(repos, "nope")).status).toBe("absent")
  })
})

describe("computeCplTarget", () => {
  it("best-month cpl x2, or $25 default", () => {
    expect(computeCplTarget([40, 30, 50])).toBe(60) // min 30 * 2
    expect(computeCplTarget([])).toBe(25)
    expect(computeCplTarget([0, 0])).toBe(25)
  })
})
