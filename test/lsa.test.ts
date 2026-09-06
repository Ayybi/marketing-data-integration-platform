import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import type { Repos } from "../src/lib/db/types.js"
import { classifyCharge, aggregateLeadsByDay, syncLsa, fetchAccountSummaryMetrics, type LsaGateway, type RawLsaLead, type RawLsaDailyMetric } from "../src/lib/lsa.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db
let repos: Repos

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_lsa_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  await db.collection("lsa_account_mappings").deleteMany({})
  await db.collection("lsa_lead_snapshots").deleteMany({})
  await db.collection("lsa_leads").deleteMany({})
  await db.collection("sync_log").deleteMany({})
  repos = makeMongoRepos(db, "orgL")
})

const bounds = { startDate: "2026-03-01", endDate: "2026-03-31" }

describe("classifyCharge (pure)", () => {
  it("buckets credited / in_review / charged / not_charged", () => {
    expect(classifyCharge({ id: 1, creditState: "CREDIT_STATE_CREDITED" })).toBe("credited")
    expect(classifyCharge({ id: 2, leadStatus: "IN_REVIEW" })).toBe("in_review")
    expect(classifyCharge({ id: 3, leadCharged: true })).toBe("charged")
    expect(classifyCharge({ id: 4 })).toBe("not_charged")
  })
})

describe("aggregateLeadsByDay (pure)", () => {
  it("counts lead types, sums spend from micros, derives CPL + budget utilization", () => {
    const leads: RawLsaLead[] = [
      { id: 1, leadType: "PHONE_CALL", creationDateTime: "2026-03-02T10:00:00Z" },
      { id: 2, leadType: "MESSAGE", creationDateTime: "2026-03-02T11:00:00Z" },
      { id: 3, leadType: "BOOKING", creationDateTime: "2026-03-02T12:00:00Z" },
    ]
    const metrics: RawLsaDailyMetric[] = [{ date: "2026-03-02", impressions: 500, costMicros: 60_000_000 }] // $60
    const rows = aggregateLeadsByDay("cust1", "c1", 1200, leads, metrics)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.totalLeads).toBe(3)
    expect(r.phoneCalls).toBe(1)
    expect(r.messages).toBe(1)
    expect(r.bookings).toBe(1)
    expect(r.adSpend).toBe(60)
    expect(r.costPerLead).toBe(20) // 60/3
    expect(r.budgetUtilization).toBe(5) // 60/1200 = 5%
  })
})

describe("syncLsa (LSA-02 discipline)", () => {
  beforeEach(async () => {
    await repos.lsa.upsertMapping({ clientId: "c1", googleAdsCustomerId: "cust1", monthlyBudget: 1000, status: "active" })
    await repos.lsa.upsertMapping({ clientId: "c2", googleAdsCustomerId: "cust2", monthlyBudget: 1000, status: "active" })
  })

  it("writes snapshots for healthy accounts and logs success", async () => {
    const gateway: LsaGateway = {
      async fetchLeads(cust) { return cust === "cust1" ? [{ id: 1, leadType: "PHONE_CALL", creationDateTime: "2026-03-05T09:00:00Z" }] : [] },
      async fetchDailyMetrics() { return [{ date: "2026-03-05", impressions: 10, costMicros: 5_000_000 }] },
    }
    const res = await syncLsa(repos, gateway, bounds)
    expect(res).toMatchObject({ processed: 2, errors: 0 })
    const sum = await fetchAccountSummaryMetrics(repos, "cust1", bounds)
    expect(sum.status).toBe("present")
    if (sum.status === "present") expect(sum.value.totalLeads).toBe(1)
  })

  // INVARIANT LSA-02: a transient per-account failure is COUNTED but does NOT flip status to 'error'.
  it("a transient account failure keeps prior status (self-heals), never deactivates", async () => {
    const gateway: LsaGateway = {
      async fetchLeads(cust) {
        if (cust === "cust1") throw new Error("transient 500")
        return [{ id: 2, leadType: "MESSAGE", creationDateTime: "2026-03-06T09:00:00Z" }]
      },
      async fetchDailyMetrics() { return [] },
    }
    const res = await syncLsa(repos, gateway, bounds)
    expect(res.errors).toBe(1)
    expect(res.processed).toBe(1)
    const m1 = await db.collection("lsa_account_mappings").findOne({ orgId: "orgL", googleAdsCustomerId: "cust1" })
    expect(m1?.status).toBe("active") // NOT flipped to 'error' (LSA-02)
    const log = await repos.syncLog.recent("lsa", 1)
    expect(log[0].status).toBe("partial")
  })

  // INVARIANT: persistLsaLeads is wrapped — a lead-detail write failure cannot fail the snapshot.
  it("snapshot persists even if per-lead writes throw", async () => {
    await repos.lsa.upsertMapping({ clientId: "c3", googleAdsCustomerId: "cust3", monthlyBudget: 1000, status: "active" })
    // Wrap repos so lsa.upsertLead throws but upsertSnapshot works.
    const wrapped: Repos = { ...repos, lsa: { ...repos.lsa, upsertLead: async () => { throw new Error("lead write down") } } }
    const gateway: LsaGateway = {
      async fetchLeads(cust) { return cust === "cust3" ? [{ id: 9, leadType: "PHONE_CALL", creationDateTime: "2026-03-07T09:00:00Z" }] : [] },
      async fetchDailyMetrics() { return [{ date: "2026-03-07", impressions: 3, costMicros: 1_000_000 }] },
    }
    const res = await syncLsa(wrapped, gateway, bounds)
    expect(res.errors).toBe(0) // lead-write failure did NOT surface as an account error
    const sum = await fetchAccountSummaryMetrics(repos, "cust3", bounds)
    expect(sum.status).toBe("present")
    if (sum.status === "present") expect(sum.value.totalLeads).toBe(1) // snapshot survived
  })
})

describe("fetchAccountSummaryMetrics (three-state)", () => {
  it("absent when no snapshots exist", async () => {
    expect((await fetchAccountSummaryMetrics(repos, "unknown", bounds)).status).toBe("absent")
  })
  // FAILURE-PATH: a driver error surfaces as error, not absent.
  it("error when the snapshot read throws", async () => {
    const broken = makeMongoRepos({ collection: () => ({ find: () => { throw new Error("db down") } }) } as unknown as Db, "orgL")
    expect((await fetchAccountSummaryMetrics(broken, "cust1", bounds)).status).toBe("error")
  })
})
