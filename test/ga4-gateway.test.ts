import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import { mapGa4Rows, classifyGa4Error, makeGa4Gateway, type Ga4RunReportFn, type Ga4RunReportResponse } from "../src/lib/ga4-gateway.js"
import { Ga4ApiError, syncGa4ForClient, getGa4Analytics } from "../src/lib/ga4.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_ga4_gw_test")
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
})

const today = new Date().toISOString().slice(0, 10)
const y = today.replace(/-/g, "")
const bounds = { startDate: today, endDate: today }

describe("mapGa4Rows (pure)", () => {
  it("flattens dimensionValues/metricValues to strings + numbers", () => {
    const resp: Ga4RunReportResponse = {
      rows: [
        { dimensionValues: [{ value: y }, { value: "Organic Search" }], metricValues: [{ value: "100" }, { value: "90" }] },
        { dimensionValues: [{ value: y }, { value: "Direct" }], metricValues: [{ value: "50" }, { value: null }] },
      ],
    }
    expect(mapGa4Rows(resp)).toEqual([
      { dimensions: [y, "Organic Search"], metrics: [100, 90] },
      { dimensions: [y, "Direct"], metrics: [50, 0] },
    ])
  })
  it("empty response -> []", () => {
    expect(mapGa4Rows({ rows: null })).toEqual([])
  })
})

describe("classifyGa4Error (gRPC codes -> typed)", () => {
  it("maps code 7 -> PERMISSION_DENIED, code 5 -> NOT_FOUND, else OTHER", () => {
    expect(classifyGa4Error({ code: 7, message: "no access" }).code).toBe("PERMISSION_DENIED")
    expect(classifyGa4Error({ code: 5, message: "gone" }).code).toBe("NOT_FOUND")
    expect(classifyGa4Error({ code: 13, message: "internal" }).code).toBe("OTHER")
  })
  it("falls back to message matching when code is a string/absent", () => {
    expect(classifyGa4Error(new Error("User does not have sufficient permissions: PERMISSION_DENIED")).code).toBe("PERMISSION_DENIED")
    expect(classifyGa4Error(new Error("Property NOT_FOUND")).code).toBe("NOT_FOUND")
  })
})

describe("makeGa4Gateway (request construction + error passthrough)", () => {
  it("builds the runReport request and returns mapped rows", async () => {
    let seen: any
    const run: Ga4RunReportFn = async (request) => {
      seen = request
      return [{ rows: [{ dimensionValues: [{ value: y }, { value: "Direct" }], metricValues: [{ value: "10" }, { value: "9" }, { value: "4" }, { value: "1" }, { value: "6" }] }] }]
    }
    const gw = makeGa4Gateway(run)
    const rows = await gw.runReport("12345", { dimensions: ["date", "sessionDefaultChannelGroup"], metrics: ["sessions", "totalUsers", "newUsers", "conversions", "engagedSessions"] }, bounds)
    expect(seen.property).toBe("properties/12345")
    expect(seen.dateRanges).toEqual([{ startDate: today, endDate: today }])
    expect(seen.dimensions).toEqual([{ name: "date" }, { name: "sessionDefaultChannelGroup" }])
    expect(seen.limit).toBe(100000)
    expect(rows[0].metrics[0]).toBe(10)
  })

  // FAILURE-PATH: a gRPC throw becomes a typed Ga4ApiError (not a raw error, not empty rows).
  it("throws a typed Ga4ApiError on a gRPC failure", async () => {
    const run: Ga4RunReportFn = async () => { throw { code: 7, message: "denied" } }
    const gw = makeGa4Gateway(run)
    await expect(gw.runReport("1", { dimensions: [], metrics: [] }, bounds)).rejects.toBeInstanceOf(Ga4ApiError)
  })
})

describe("end-to-end: real error classification -> connector deactivate invariant", () => {
  it("a gRPC PERMISSION_DENIED from the gateway deactivates the mapping", async () => {
    const repos = makeMongoRepos(db, "orgGwG")
    await repos.ga4.upsertMapping({ clientId: "c1", ga4PropertyId: "prop1", status: "active" })
    const run: Ga4RunReportFn = async () => { throw { code: 7, message: "User does not have access" } }
    const gateway = makeGa4Gateway(run)

    const out = await syncGa4ForClient(repos, "c1", gateway, bounds)
    expect(out).toEqual({ kind: "deactivated", reason: "PERMISSION_DENIED" })
    const m = await db.collection("ga4_property_mappings").findOne({ orgId: "orgGwG", clientId: "c1" })
    expect(m?.status).toBe("error")
  })

  it("a healthy response flows through to a stored snapshot", async () => {
    const repos = makeMongoRepos(db, "orgGwG2")
    await repos.ga4.upsertMapping({ clientId: "c1", ga4PropertyId: "prop1", status: "active" })
    const run: Ga4RunReportFn = async (request) => {
      const dims = (request.dimensions as Array<{ name: string }>).map((d) => d.name)
      if (dims.includes("pagePath")) return [{ rows: [{ dimensionValues: [{ value: "/" }], metricValues: [{ value: "200" }] }] }]
      return [{ rows: [{ dimensionValues: [{ value: y }, { value: "Direct" }], metricValues: [{ value: "10" }, { value: "9" }, { value: "4" }, { value: "1" }, { value: "6" }] }] }]
    }
    const out = await syncGa4ForClient(repos, "c1", makeGa4Gateway(run), bounds)
    expect(out).toEqual({ kind: "processed", days: 1 })
    const read = await getGa4Analytics(repos, "c1", bounds)
    expect(read.status).toBe("present")
    if (read.status === "present") {
      expect(read.value.sessions).toBe(10)
      expect(read.value.topPages[0]).toEqual({ path: "/", views: 200 })
    }
  })
})
