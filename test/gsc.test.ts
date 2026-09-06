import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import type { Repos } from "../src/lib/db/types.js"
import { aggregateGscRows, getGscAnalytics, getGscPropertyAggregate, GscApiError, type GscGateway, type GscRow } from "../src/lib/gsc.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db
let repos: Repos

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_gsc_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  await db.collection("gsc_property_mappings").deleteMany({})
  repos = makeMongoRepos(db, "orgS")
})

const bounds = { startDate: "2026-01-01", endDate: "2026-01-31" }
const gw = (rows: GscRow[] | GscApiError): GscGateway => ({
  async query() {
    if (rows instanceof GscApiError) throw rows
    return rows
  },
})

describe("aggregateGscRows (impression-weighted position)", () => {
  it("weights position by impressions", () => {
    const m = aggregateGscRows([
      { keys: ["a"], clicks: 10, impressions: 100, ctr: 0.1, position: 2 },
      { keys: ["b"], clicks: 5, impressions: 300, ctr: 0.016, position: 6 },
    ])
    expect(m.clicks).toBe(15)
    expect(m.impressions).toBe(400)
    // (2*100 + 6*300) / 400 = 2000/400 = 5
    expect(m.position).toBe(5)
  })
  it("zero impressions -> zeroed, no divide-by-zero", () => {
    expect(aggregateGscRows([])).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: 0 })
  })
})

describe("getGscAnalytics (three-state, live read)", () => {
  it("present on a successful query", async () => {
    await repos.gsc.upsertMapping({ clientId: "c1", siteUrl: "sc-domain:example.com", status: "active" })
    const r = await getGscAnalytics(repos, "c1", gw([{ keys: ["x"], clicks: 3, impressions: 30, ctr: 0.1, position: 4 }]), bounds)
    expect(r.status).toBe("present")
    if (r.status === "present") expect(r.value.clicks).toBe(3)
  })
  it("absent when the client has no mapping", async () => {
    expect((await getGscAnalytics(repos, "nope", gw([]), bounds)).status).toBe("absent")
  })
  it("paused mapping -> present but zeroed (still renders)", async () => {
    await repos.gsc.upsertMapping({ clientId: "c2", siteUrl: "sc-domain:paused.com", status: "paused" })
    const r = await getGscAnalytics(repos, "c2", gw(new GscApiError("should not be called", "OTHER")), bounds)
    expect(r).toEqual({ status: "present", value: { clicks: 0, impressions: 0, ctr: 0, position: 0 } })
  })
  // FAILURE-PATH: permission_denied is ERROR (surfaced), never a silent zero that reads as "no traffic".
  it("error on permission_denied, not a fake zero", async () => {
    await repos.gsc.upsertMapping({ clientId: "c3", siteUrl: "sc-domain:denied.com", status: "active" })
    const r = await getGscAnalytics(repos, "c3", gw(new GscApiError("403", "PERMISSION_DENIED")), bounds)
    expect(r.status).toBe("error")
    if (r.status === "error") expect(r.error).toContain("PERMISSION_DENIED")
  })
})

describe("getGscPropertyAggregate", () => {
  it("paused rows render zeroed; errored reads are reported separately (not mixed into totals)", async () => {
    await repos.gsc.upsertMapping({ clientId: "ok", siteUrl: "sc-domain:ok.com", status: "active" })
    await repos.gsc.upsertMapping({ clientId: "paused", siteUrl: "sc-domain:p.com", status: "paused" })
    const gateway: GscGateway = {
      async query(siteUrl) {
        if (siteUrl.includes("ok.com")) return [{ keys: ["k"], clicks: 2, impressions: 20, ctr: 0.1, position: 3 }]
        throw new GscApiError("boom", "OTHER")
      },
    }
    const out = await getGscPropertyAggregate(repos, gateway, bounds)
    const paused = out.rows.find((r) => r.clientId === "paused")
    expect(paused?.metrics.clicks).toBe(0)
    const ok = out.rows.find((r) => r.clientId === "ok")
    expect(ok?.metrics.clicks).toBe(2)
    expect(out.errors).toHaveLength(0) // ok + paused only; no active errored mapping here
  })
})
