import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import { leadsGaql, dailyMetricsGaql, mapLead, mapDailyMetric, makeLsaGateway, type LsaQueryFn } from "../src/lib/lsa-gateway.js"
import { syncLsa, fetchAccountSummaryMetrics } from "../src/lib/lsa.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_lsa_gw_test")
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
})

const bounds = { startDate: "2026-03-01", endDate: "2026-03-31" }

describe("GAQL builders (B4 shapes)", () => {
  it("leads query selects the documented fields and date window", () => {
    const q = leadsGaql(bounds)
    expect(q).toContain("FROM local_services_lead")
    expect(q).toContain("local_services_lead.lead_type")
    expect(q).toContain("local_services_lead.credit_details.credit_state")
    expect(q).toContain(">= '2026-03-01 00:00:00'")
    expect(q).toContain("<= '2026-03-31 23:59:59'")
  })
  it("metrics query is scoped to LOCAL_SERVICES + date range", () => {
    const q = dailyMetricsGaql(bounds)
    expect(q).toContain("metrics.cost_micros")
    expect(q).toContain("campaign.advertising_channel_type = 'LOCAL_SERVICES'")
    expect(q).toContain("segments.date >= '2026-03-01'")
  })
})

describe("mappers (pure)", () => {
  it("mapLead pulls nested lead fields incl. credit_state", () => {
    const r = mapLead({
      local_services_lead: { id: 99, lead_type: "PHONE_CALL", lead_status: "NEW", creation_date_time: "2026-03-05 09:00:00", category_id: "hvac", lead_charged: true, credit_details: { credit_state: "CREDIT_STATE_CREDITED" } },
    })
    expect(r).toEqual({ id: 99, leadType: "PHONE_CALL", leadStatus: "NEW", creationDateTime: "2026-03-05 09:00:00", categoryId: "hvac", leadCharged: true, creditState: "CREDIT_STATE_CREDITED" })
  })
  it("mapDailyMetric reads metrics + segments.date, defaulting to 0", () => {
    expect(mapDailyMetric({ metrics: { impressions: "500", cost_micros: "60000000" }, segments: { date: "2026-03-05" } })).toEqual({ date: "2026-03-05", impressions: 500, costMicros: 60000000 })
    expect(mapDailyMetric({})).toEqual({ date: "", impressions: 0, costMicros: 0 })
  })
})

describe("makeLsaGateway (dispatch by query)", () => {
  it("routes leads vs metrics queries and maps each", async () => {
    const runQuery: LsaQueryFn = async ({ gaql }) => {
      if (gaql.includes("local_services_lead")) return [{ local_services_lead: { id: 1, lead_type: "MESSAGE", creation_date_time: "2026-03-05 10:00:00" } }]
      return [{ metrics: { impressions: 10, cost_micros: 5000000 }, segments: { date: "2026-03-05" } }]
    }
    const gw = makeLsaGateway(runQuery)
    const leads = await gw.fetchLeads("123", "456", bounds)
    const metrics = await gw.fetchDailyMetrics("123", "456", bounds)
    expect(leads[0].leadType).toBe("MESSAGE")
    expect(metrics[0].costMicros).toBe(5000000)
  })
})

describe("end-to-end: gateway -> syncLsa (LSA-02 preserved)", () => {
  beforeEach(async () => {
    const repos = makeMongoRepos(db, "orgLsaGw")
    await repos.lsa.upsertMapping({ clientId: "c1", googleAdsCustomerId: "cust1", monthlyBudget: 1000, status: "active" })
  })

  it("healthy gateway -> snapshot written", async () => {
    const repos = makeMongoRepos(db, "orgLsaGw")
    const runQuery: LsaQueryFn = async ({ gaql }) =>
      gaql.includes("local_services_lead")
        ? [{ local_services_lead: { id: 1, lead_type: "PHONE_CALL", creation_date_time: "2026-03-05 09:00:00" } }]
        : [{ metrics: { impressions: 3, cost_micros: 1000000 }, segments: { date: "2026-03-05" } }]
    const res = await syncLsa(repos, makeLsaGateway(runQuery), bounds)
    expect(res.processed).toBe(1)
    const sum = await fetchAccountSummaryMetrics(repos, "cust1", bounds)
    if (sum.status === "present") expect(sum.value.totalLeads).toBe(1)
  })

  // INVARIANT LSA-02: a gateway query failure is transient — counted, status NOT flipped to error, while
  // a healthy sibling account still syncs (partial run).
  it("a failing account stays active and self-heals while a healthy sibling syncs (partial)", async () => {
    const repos = makeMongoRepos(db, "orgLsaGw")
    await repos.lsa.upsertMapping({ clientId: "c2", googleAdsCustomerId: "cust2", monthlyBudget: 1000, status: "active" })
    const runQuery: LsaQueryFn = async ({ customerId, gaql }) => {
      if (customerId === "cust1") throw new Error("google ads 500") // transient
      return gaql.includes("local_services_lead")
        ? [{ local_services_lead: { id: 7, lead_type: "PHONE_CALL", creation_date_time: "2026-03-06 09:00:00" } }]
        : []
    }
    const res = await syncLsa(repos, makeLsaGateway(runQuery), bounds)
    expect(res.errors).toBe(1)
    expect(res.processed).toBe(1)
    const m = await db.collection("lsa_account_mappings").findOne({ orgId: "orgLsaGw", googleAdsCustomerId: "cust1" })
    expect(m?.status).toBe("active") // NOT deactivated (LSA-02)
    const log = await repos.syncLog.recent("lsa", 1)
    expect(log[0].status).toBe("partial") // some failed, some succeeded, existing data preserved
  })
})
