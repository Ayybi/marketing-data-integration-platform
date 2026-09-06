import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import type { Repos } from "../src/lib/db/types.js"
import type { Fetcher, HttpResponse } from "../src/lib/http.js"
import { aggregateCallSnapshots } from "../src/lib/calltracking/aggregate.js"
import { syncCallTracking } from "../src/lib/calltracking/sync.js"
import { CallRailProvider, mapRawCallToTracked } from "../src/lib/calltracking/callrail-provider.js"
import { FakeCallTrackingProvider } from "../src/lib/calltracking/fake-provider.js"
import { getCallTrackingProvider, setCallTrackingProvider, CallTrackingNotConfigured } from "../src/lib/calltracking/index.js"
import type { TrackedCall } from "../src/lib/calltracking/types.js"
import { getCallRailMetricsForClient } from "../src/lib/callrail.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db
let repos: Repos

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_calltracking_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  for (const c of ["callrail_account_mappings", "callrail_snapshots", "callrail_calls", "sync_log", "integrations"]) await db.collection(c).deleteMany({})
  repos = makeMongoRepos(db, "orgCT")
})
afterEach(() => setCallTrackingProvider(null))

const today = new Date().toISOString().slice(0, 10)
const call = (over: Partial<TrackedCall> = {}): TrackedCall => ({ callId: "1", startTime: `${today}T09:00:00Z`, durationSeconds: 60, answered: true, ...over })

function jsonFetcher(map: (url: string) => unknown): Fetcher {
  return async (url): Promise<HttpResponse> => {
    const body = map(url)
    return { status: 200, ok: true, text: async () => JSON.stringify(body), json: async () => body }
  }
}

describe("aggregateCallSnapshots (provider-agnostic, over normalized calls)", () => {
  it("counts answered/missed/qualified/first-time and sums duration", () => {
    const rows = aggregateCallSnapshots("acct", "co1", "Co", "c1", [
      call({ callId: "1", qualifiedLead: true, firstTimeCaller: true }),
      call({ callId: "2", answered: false, durationSeconds: 30 }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ totalCalls: 2, answeredCalls: 1, missedCalls: 1, firstTimeCallers: 1, qualifiedLeads: 1, totalDurationSeconds: 90 })
  })
})

describe("CallRail adapter maps raw -> normalized", () => {
  it("mapRawCallToTracked normalizes lead_status/first_call", () => {
    expect(mapRawCallToTracked({ id: 5, start_time: "x", duration: 12, answered: true, first_call: true, lead_status: "good_lead" })).toMatchObject({
      callId: "5",
      durationSeconds: 12,
      firstTimeCaller: true,
      qualifiedLead: true,
      leadStatus: "good_lead",
    })
    expect(mapRawCallToTracked({ id: 6, lead_status: "not_a_lead" }).qualifiedLead).toBe(false)
  })

  it("provider.fetchCalls returns normalized TrackedCall[] from the CallRail API", async () => {
    const f = jsonFetcher((url) => (url.includes("company_id=co1") ? { calls: [{ id: 9, start_time: `${today}T10:00:00Z`, answered: true, lead_status: "good_lead" }], total_pages: 1 } : {}))
    const provider = new CallRailProvider(f, "k")
    const calls = await provider.fetchCalls("1", "co1", { startDate: today, endDate: today })
    expect(calls[0]).toMatchObject({ callId: "9", answered: true, qualifiedLead: true })
  })
})

describe("provider is swappable — ANY provider drives the same aggregation/storage", () => {
  it("a Fake provider produces the same stored snapshots a real vendor would", async () => {
    await repos.callrail.upsertMapping({ clientId: "c1", callrailAccountId: "acct", callrailCompanyId: "co1", status: "active" })
    const provider = new FakeCallTrackingProvider({
      name: "twilio-like",
      accountId: "acct",
      companies: [{ companyId: "co1", name: "Co One" }],
      callsByCompany: { co1: [call({ callId: "1", qualifiedLead: true }), call({ callId: "2", answered: false })] },
    })
    const res = await syncCallTracking(repos, provider, { windowDays: 1 })
    expect(res.processed).toBe(1)

    const m = await getCallRailMetricsForClient(repos, "c1", { startDate: today, endDate: today })
    expect(m.status).toBe("present")
    if (m.status === "present") expect(m.value).toMatchObject({ totalCalls: 2, answeredCalls: 1, qualifiedLeads: 1 })

    // sync_log source carries the provider name (whichever vendor is plugged in).
    const log = await repos.syncLog.recent("twilio-like", 1)
    expect(log[0].status).toBe("success")
  })

  // INVARIANT preserved regardless of vendor: a per-company fetch error -> partial, healthy company kept,
  // prior data not zeroed.
  it("a per-company error is partial and never wipes stored data (generic sync)", async () => {
    await repos.callrail.upsertMapping({ clientId: "c1", callrailAccountId: "acct", callrailCompanyId: "co1", status: "active" })
    await repos.callrail.upsertMapping({ clientId: "c2", callrailAccountId: "acct", callrailCompanyId: "co2", status: "active" })
    await repos.callrail.upsertSnapshot({ clientId: "c1", callrailAccountId: "acct", callrailCompanyId: "co1", snapshotDate: today, totalCalls: 5, answeredCalls: 5, missedCalls: 0, firstTimeCallers: 0, qualifiedLeads: 3, totalDurationSeconds: 300 })
    const provider = new FakeCallTrackingProvider({
      accountId: "acct",
      companies: [],
      callsByCompany: { co1: new Error("vendor 500"), co2: [call({ callId: "21", answered: true })] },
    })
    const res = await syncCallTracking(repos, provider, { windowDays: 1 })
    expect(res.errors).toBe(1)
    expect(res.processed).toBe(1)
    const m1 = await getCallRailMetricsForClient(repos, "c1", { startDate: today, endDate: today })
    if (m1.status === "present") expect(m1.value.qualifiedLeads).toBe(3) // preserved, not zeroed
  })

  it("account-resolve failure -> error sync_log (nothing written)", async () => {
    await repos.callrail.upsertMapping({ clientId: "c1", callrailAccountId: "", callrailCompanyId: "co1", status: "active" })
    const provider = new FakeCallTrackingProvider({ accountError: new Error("no account") })
    const res = await syncCallTracking(repos, provider, { windowDays: 1 })
    expect(res).toMatchObject({ processed: 0, errors: 1 })
    const log = await repos.syncLog.recent("fake-calltracking", 1)
    expect(log[0].status).toBe("error")
  })
})

describe("getCallTrackingProvider factory", () => {
  it("defaults to CallRail with an env key", async () => {
    process.env.CALLRAIL_API_KEY = "k"
    const p = await getCallTrackingProvider(repos)
    expect(p.name).toBe("callrail")
    delete process.env.CALLRAIL_API_KEY
  })
  it("throws CallTrackingNotConfigured when no key is resolvable", async () => {
    delete process.env.CALLRAIL_API_KEY
    await expect(getCallTrackingProvider(repos)).rejects.toBeInstanceOf(CallTrackingNotConfigured)
  })
  it("rejects an unknown provider", async () => {
    process.env.CALL_TRACKING_PROVIDER = "not-a-vendor"
    await expect(getCallTrackingProvider(repos)).rejects.toThrow(/Unknown CALL_TRACKING_PROVIDER/)
    delete process.env.CALL_TRACKING_PROVIDER
  })
  it("setCallTrackingProvider overrides for DI", async () => {
    setCallTrackingProvider(new FakeCallTrackingProvider({ name: "injected" }))
    expect((await getCallTrackingProvider(repos)).name).toBe("injected")
  })
})
