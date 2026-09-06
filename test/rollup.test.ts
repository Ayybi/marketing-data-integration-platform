import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import type { Repos } from "../src/lib/db/types.js"
import { buildRollupForClient, persistRollupForClient, persistAllRollups } from "../src/lib/rollup/build.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db
let repos: Repos

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_rollup_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  for (const c of ["callrail_snapshots", "ga4_snapshots", "gbp_snapshots", "lsa_lead_snapshots", "lsa_account_mappings", "cross_source_rollups", "clients"]) await db.collection(c).deleteMany({})
  repos = makeMongoRepos(db, "orgR")
})

const bounds = { startDate: "2026-01-01", endDate: "2026-01-31" }

describe("buildRollupForClient (cross-source per-day merge)", () => {
  it("merges CallRail + GA4 + GBP + LSA into one row per day", async () => {
    const day = "2026-01-05"
    await repos.callrail.upsertSnapshot({ clientId: "c1", callrailAccountId: "1", callrailCompanyId: "co1", snapshotDate: day, totalCalls: 8, answeredCalls: 6, missedCalls: 2, firstTimeCallers: 0, qualifiedLeads: 4, totalDurationSeconds: 0 })
    await repos.ga4.upsertSnapshot({ clientId: "c1", ga4PropertyId: "p1", snapshotDate: day, sessions: 100, totalUsers: 90, newUsers: 40, conversions: 5, engagedSessions: 70, channels: [], topPages: [] })
    await repos.gbp.upsertSnapshot({ clientId: "c1", locationId: "loc1", snapshotDate: day, views: 200, searchViews: 150, mapsViews: 50, actions: 12, calls: 5, directions: 4, websiteClicks: 3, conversations: 0 })
    await repos.lsa.upsertMapping({ clientId: "c1", googleAdsCustomerId: "cust1", monthlyBudget: 1000, status: "active" })
    await repos.lsa.upsertSnapshot({ clientId: "c1", googleAdsCustomerId: "cust1", date: day, totalLeads: 3, phoneCalls: 2, messages: 1, bookings: 0, impressions: 500, adSpend: 60, costPerLead: 20, budgetUtilization: 6 })

    const rows = await buildRollupForClient(repos, "c1", bounds)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ clientId: "c1", date: day, calls: 8, qualifiedLeads: 4, sessions: 100, conversions: 5, gbpViews: 200, gbpActions: 12, adLeads: 3, adSpend: 60 })
  })

  it("empty when the client has no snapshots", async () => {
    expect(await buildRollupForClient(repos, "nobody", bounds)).toEqual([])
  })
})

describe("persist", () => {
  it("persistRollupForClient upserts rows; forClient reads them back", async () => {
    await repos.ga4.upsertSnapshot({ clientId: "c1", ga4PropertyId: "p1", snapshotDate: "2026-01-06", sessions: 10, totalUsers: 9, newUsers: 4, conversions: 1, engagedSessions: 7, channels: [], topPages: [] })
    await persistRollupForClient(repos, "c1", bounds)
    const stored = await repos.rollup.forClient("c1", bounds.startDate, bounds.endDate)
    expect(stored).toHaveLength(1)
    expect(stored[0].sessions).toBe(10)
  })

  it("persistAllRollups sweeps active clients", async () => {
    await repos.clients.upsert({ clientId: "c1", domain: "a.com" })
    await repos.callrail.upsertSnapshot({ clientId: "c1", callrailAccountId: "1", callrailCompanyId: "co1", snapshotDate: "2026-01-07", totalCalls: 2, answeredCalls: 2, missedCalls: 0, firstTimeCallers: 0, qualifiedLeads: 1, totalDurationSeconds: 0 })
    const res = await persistAllRollups(repos, bounds)
    expect(res.clients).toBe(1)
    expect(res.rows).toBe(1)
  })
})
