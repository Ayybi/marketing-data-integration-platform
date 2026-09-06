import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import type { Repos } from "../src/lib/db/types.js"
import {
  normalizeGa4Snapshots,
  syncGa4ForClient,
  syncAllGa4,
  getGa4Analytics,
  resolveGa4ServiceAccount,
  Ga4ApiError,
  type Ga4Gateway,
  type Ga4ReportRow,
} from "../src/lib/ga4.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db
let repos: Repos

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_ga4_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  await db.collection("ga4_property_mappings").deleteMany({})
  await db.collection("ga4_snapshots").deleteMany({})
  await db.collection("sync_log").deleteMany({})
  repos = makeMongoRepos(db, "orgG")
})

const today = new Date().toISOString().slice(0, 10)
const y = today.replace(/-/g, "")
const bounds = { startDate: today, endDate: today }

// Fake gateway: returns scripted rows, or throws a coded Ga4ApiError.
function gw(core: Ga4ReportRow[] | Ga4ApiError, pages: Ga4ReportRow[] = []): Ga4Gateway {
  return {
    async runReport(_p, req) {
      if (core instanceof Ga4ApiError) throw core
      return req.dimensions.includes("pagePath") ? pages : core
    },
  }
}

describe("normalizeGa4Snapshots (pure)", () => {
  it("groups core rows by date, aggregates metrics, keeps channels + top pages", () => {
    const rows = normalizeGa4Snapshots(
      "c1",
      "prop1",
      [
        { dimensions: [y, "Organic Search"], metrics: [100, 90, 40, 5, 70] },
        { dimensions: [y, "Direct"], metrics: [50, 45, 20, 2, 30] },
      ],
      [
        { dimensions: ["/"], metrics: [200] },
        { dimensions: ["/services"], metrics: [120] },
      ],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].sessions).toBe(150)
    expect(rows[0].conversions).toBe(7)
    expect(rows[0].channels).toHaveLength(2)
    expect(rows[0].topPages[0]).toEqual({ path: "/", views: 200 })
  })
})

describe("resolveGa4ServiceAccount (three-state)", () => {
  it("absent when unset, present when valid JSON, error when unparseable", () => {
    delete process.env.GA4_SERVICE_ACCOUNT_JSON
    expect(resolveGa4ServiceAccount().status).toBe("absent")
    process.env.GA4_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "svc@x.iam" })
    expect(resolveGa4ServiceAccount()).toEqual({ status: "present", value: { client_email: "svc@x.iam" } })
    process.env.GA4_SERVICE_ACCOUNT_JSON = "{not json"
    expect(resolveGa4ServiceAccount().status).toBe("error")
    delete process.env.GA4_SERVICE_ACCOUNT_JSON
  })
})

describe("syncGa4ForClient (failure discipline §4.2)", () => {
  beforeEach(async () => {
    await repos.ga4.upsertMapping({ clientId: "c1", ga4PropertyId: "prop1", status: "active" })
  })

  it("processed: writes daily snapshots on success", async () => {
    const out = await syncGa4ForClient(repos, "c1", gw([{ dimensions: [y, "Direct"], metrics: [10, 9, 4, 1, 6] }], [{ dimensions: ["/"], metrics: [10] }]), bounds)
    expect(out).toEqual({ kind: "processed", days: 1 })
    const read = await getGa4Analytics(repos, "c1", bounds)
    expect(read.status).toBe("present")
    if (read.status === "present") expect(read.value.sessions).toBe(10)
  })

  // INVARIANT: PERMISSION_DENIED deactivates the mapping (lost access), distinct from a transient blip.
  it("deactivates the mapping on PERMISSION_DENIED", async () => {
    const out = await syncGa4ForClient(repos, "c1", gw(new Ga4ApiError("no access", "PERMISSION_DENIED")), bounds)
    expect(out).toEqual({ kind: "deactivated", reason: "PERMISSION_DENIED" })
    const m = await db.collection("ga4_property_mappings").findOne({ orgId: "orgG", clientId: "c1" })
    expect(m?.status).toBe("error")
  })

  // FAILURE-PATH: a transient (OTHER) error is COUNTED for retry, NOT deactivated, NOT written as zeros.
  it("counts a transient error without deactivating", async () => {
    const out = await syncGa4ForClient(repos, "c1", gw(new Ga4ApiError("500", "OTHER")), bounds)
    expect(out.kind).toBe("transient")
    const m = await db.collection("ga4_property_mappings").findOne({ orgId: "orgG", clientId: "c1" })
    expect(m?.status).toBe("active") // still active -> will retry next run
    // no snapshot written (no fake zeros)
    expect(await db.collection("ga4_snapshots").countDocuments({ orgId: "orgG" })).toBe(0)
  })
})

describe("syncAllGa4 (sweep + sync_log)", () => {
  it("separates deactivations from transient errors in the log metadata", async () => {
    await repos.ga4.upsertMapping({ clientId: "ok", ga4PropertyId: "p_ok", status: "active" })
    await repos.ga4.upsertMapping({ clientId: "gone", ga4PropertyId: "p_gone", status: "active" })
    const gateway: Ga4Gateway = {
      async runReport(propertyId, req) {
        if (propertyId === "p_gone") throw new Ga4ApiError("gone", "NOT_FOUND")
        return req.dimensions.includes("pagePath") ? [] : [{ dimensions: [y, "Direct"], metrics: [1, 1, 1, 0, 1] }]
      },
    }
    const res = await syncAllGa4(repos, gateway, bounds)
    expect(res.processed).toBe(1)
    expect(res.deactivated).toBe(1)
    expect(res.errors).toBe(0)
    const log = await repos.syncLog.recent("ga4", 1)
    expect(log[0].metadata?.deactivated).toBe(1)
    expect(log[0].status).toBe("success") // no transient errors -> success (deactivation is handled, not an error)
  })
})

describe("getGa4Analytics (three-state read)", () => {
  it("absent for an unmapped client", async () => {
    expect((await getGa4Analytics(repos, "nope", bounds)).status).toBe("absent")
  })
  // FAILURE-PATH: mapping lookup driver error surfaces as error, not absent.
  it("error when the mapping lookup fails", async () => {
    const broken = makeMongoRepos({ collection: () => ({ findOne: () => { throw new Error("db down") } }) } as unknown as Db, "orgG")
    expect((await getGa4Analytics(broken, "c1", bounds)).status).toBe("error")
  })
})
