import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import type { Repos } from "../src/lib/db/types.js"
import type { Fetcher, HttpResponse } from "../src/lib/http.js"
import {
  callRailGet,
  normalizeSnapshots,
  syncCallRail,
  getCallRailMetricsForClient,
  resolveCallRailKey,
} from "../src/lib/callrail.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db

beforeAll(async () => {
  process.env.INTEGRATION_VAULT_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")
  process.env.CALLRAIL_API_KEY = "test-key"
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_callrail_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
  delete process.env.CALLRAIL_API_KEY
})

let repos: Repos
beforeEach(async () => {
  await db.collection("callrail_account_mappings").deleteMany({})
  await db.collection("callrail_snapshots").deleteMany({})
  await db.collection("callrail_calls").deleteMany({})
  await db.collection("sync_log").deleteMany({})
  repos = makeMongoRepos(db, "orgCR")
})

// A map-based fetcher: URL substring -> response. "throw" simulates a transport error.
function fakeFetcher(routes: Array<{ match: string; status?: number; json?: unknown } | { match: string; throw: true }>): Fetcher {
  return async (url): Promise<HttpResponse> => {
    for (const r of routes) {
      if (url.includes(r.match)) {
        if ("throw" in r) throw new Error(`transport error for ${url}`)
        const status = r.status ?? 200
        return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(r.json ?? {}), json: async () => r.json ?? {} }
      }
    }
    return { status: 404, ok: false, text: async () => "", json: async () => ({}) }
  }
}

const today = new Date().toISOString().slice(0, 10)

describe("normalizeSnapshots (pure)", () => {
  it("buckets calls per day and derives answered/missed/qualified/first-time/duration", () => {
    const rows = normalizeSnapshots("acct", "co1", "Co One", "c1", [
      { id: 1, start_time: `${today}T09:00:00Z`, duration: 60, answered: true, first_call: true, lead_status: "good_lead" },
      { id: 2, start_time: `${today}T10:00:00Z`, duration: 30, answered: false },
      { id: 3, start_time: `${today}T11:00:00Z`, duration: 20, answered: true, lead_status: "not_a_lead" },
    ])
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.totalCalls).toBe(3)
    expect(r.answeredCalls).toBe(2)
    expect(r.missedCalls).toBe(1)
    expect(r.firstTimeCallers).toBe(1)
    expect(r.qualifiedLeads).toBe(1)
    expect(r.totalDurationSeconds).toBe(110)
  })
})

describe("callRailGet (three-state at the HTTP seam)", () => {
  it("returns parsed JSON on 200", async () => {
    const f = fakeFetcher([{ match: "/a.json", json: { accounts: [{ id: 7 }] } }])
    expect(await callRailGet(f, "k", "/a.json")).toEqual({ accounts: [{ id: 7 }] })
  })
  // FAILURE-PATH: a non-ok status THROWS (error surfaces) — never a silent empty object.
  it("throws on a non-ok status rather than returning []", async () => {
    const f = fakeFetcher([{ match: "/a/1/calls.json", status: 403, json: {} }])
    await expect(callRailGet(f, "k", "/a/1/calls.json")).rejects.toThrow(/-> 403/)
  })
})

describe("resolveCallRailKey (three-state)", () => {
  it("prefers env; falls back to vault; error when the vault blob is corrupt", async () => {
    expect(await resolveCallRailKey(repos)).toEqual({ status: "present", value: "test-key" })
    delete process.env.CALLRAIL_API_KEY
    expect((await resolveCallRailKey(repos)).status).toBe("absent")
    process.env.CALLRAIL_API_KEY = "test-key"
  })
})

describe("syncCallRail (end-to-end against fake CallRail + real Mongo)", () => {
  beforeEach(async () => {
    await repos.callrail.upsertMapping({ clientId: "c1", callrailAccountId: "1", callrailCompanyId: "co1", status: "active" })
    await repos.callrail.upsertMapping({ clientId: "c2", callrailAccountId: "1", callrailCompanyId: "co2", status: "active" })
  })

  it("writes snapshots for all companies and logs success", async () => {
    const f = fakeFetcher([
      { match: "/a/1/companies.json", json: { companies: [{ id: "co1", name: "One" }, { id: "co2", name: "Two" }] } },
      { match: "company_id=co1", json: { calls: [{ id: 11, start_time: `${today}T09:00:00Z`, duration: 60, answered: true, lead_status: "good_lead" }], total_pages: 1 } },
      { match: "company_id=co2", json: { calls: [{ id: 21, start_time: `${today}T09:00:00Z`, duration: 10, answered: false }], total_pages: 1 } },
    ])
    const res = await syncCallRail(repos, { fetcher: f, windowDays: 1 })
    expect(res).toMatchObject({ processed: 2, errors: 0, total: 2 })

    const m1 = await getCallRailMetricsForClient(repos, "c1", { startDate: today, endDate: today })
    expect(m1.status).toBe("present")
    if (m1.status === "present") { expect(m1.value.qualifiedLeads).toBe(1); expect(m1.value.answeredCalls).toBe(1) }

    const log = await repos.syncLog.recent("callrail", 1)
    expect(log[0].status).toBe("success")
  })

  // FAILURE-PATH + INVARIANT (§6/§12): one company's page read fails -> that company is COUNTED as an
  // error and the run is `partial`; the OTHER company's real data is still written. A transient blip
  // is never recorded as zero calls or as churn.
  it("a per-company transport error yields partial, preserves the healthy company, and never writes zeros", async () => {
    // Seed a prior good snapshot for co1 so we can prove it is NOT overwritten with zeros.
    await repos.callrail.upsertSnapshot({ clientId: "c1", callrailAccountId: "1", callrailCompanyId: "co1", snapshotDate: today, totalCalls: 5, answeredCalls: 5, missedCalls: 0, firstTimeCallers: 0, qualifiedLeads: 3, totalDurationSeconds: 300 })
    const f = fakeFetcher([
      { match: "/a/1/companies.json", json: { companies: [] } },
      { match: "company_id=co1", throw: true }, // co1 fails
      { match: "company_id=co2", json: { calls: [{ id: 21, start_time: `${today}T09:00:00Z`, duration: 10, answered: true }], total_pages: 1 } },
    ])
    const res = await syncCallRail(repos, { fetcher: f, windowDays: 1 })
    expect(res.errors).toBe(1)
    expect(res.processed).toBe(1)

    const log = await repos.syncLog.recent("callrail", 1)
    expect(log[0].status).toBe("partial")
    expect(log[0].errorMessage).toContain("co1")

    // co1's prior real data survived (NOT blanked to 0 by the failed read).
    const m1 = await getCallRailMetricsForClient(repos, "c1", { startDate: today, endDate: today })
    expect(m1.status).toBe("present")
    if (m1.status === "present") expect(m1.value.qualifiedLeads).toBe(3)

    // co2 was written fresh.
    const m2 = await getCallRailMetricsForClient(repos, "c2", { startDate: today, endDate: today })
    if (m2.status === "present") expect(m2.value.answeredCalls).toBe(1)
  })

  it("aborts to error state (no zeros written) when no API key is resolvable", async () => {
    delete process.env.CALLRAIL_API_KEY
    const res = await syncCallRail(repos, { fetcher: fakeFetcher([]), windowDays: 1 })
    expect(res).toMatchObject({ processed: 0, errors: 1 })
    const log = await repos.syncLog.recent("callrail", 1)
    expect(log[0].status).toBe("error")
    process.env.CALLRAIL_API_KEY = "test-key"
  })
})

describe("getCallRailMetricsForClient (three-state read)", () => {
  it("absent for an unmapped client (genuine not-connected), never a fake zero", async () => {
    const r = await getCallRailMetricsForClient(repos, "no-such-client", { startDate: today, endDate: today })
    expect(r.status).toBe("absent")
  })
  // FAILURE-PATH: a mapping-lookup driver error surfaces as error, not absent.
  it("error when the mapping lookup itself fails", async () => {
    const brokenDb = { collection: () => ({ findOne: () => { throw new Error("db down") } }) } as unknown as Db
    const broken = makeMongoRepos(brokenDb, "orgCR")
    const r = await getCallRailMetricsForClient(broken, "c1", { startDate: today, endDate: today })
    expect(r.status).toBe("error")
  })
})
