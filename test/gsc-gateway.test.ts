import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import { mapGscRows, classifyGscError, makeGscGateway, type GscQueryFn, type GscQueryResponse } from "../src/lib/gsc-gateway.js"
import { GscApiError, getGscAnalytics } from "../src/lib/gsc.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_gsc_gw_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  await db.collection("gsc_property_mappings").deleteMany({})
})

const bounds = { startDate: "2026-01-01", endDate: "2026-01-31" }

describe("mapGscRows (pure)", () => {
  it("maps rows, defaulting missing fields to 0/[]", () => {
    const resp: GscQueryResponse = { data: { rows: [{ keys: ["plumber near me"], clicks: 10, impressions: 100, ctr: 0.1, position: 3.4 }, { impressions: 5 }] } }
    expect(mapGscRows(resp)).toEqual([
      { keys: ["plumber near me"], clicks: 10, impressions: 100, ctr: 0.1, position: 3.4 },
      { keys: [], clicks: 0, impressions: 5, ctr: 0, position: 0 },
    ])
  })
  it("empty/absent data -> []", () => {
    expect(mapGscRows({ data: null })).toEqual([])
    expect(mapGscRows({})).toEqual([])
  })
})

describe("classifyGscError (403 -> PERMISSION_DENIED)", () => {
  it("maps code/status 403 and permission messages", () => {
    expect(classifyGscError({ code: 403, message: "forbidden" }).code).toBe("PERMISSION_DENIED")
    expect(classifyGscError({ status: 403, message: "no" }).code).toBe("PERMISSION_DENIED")
    expect(classifyGscError(new Error("User does not have sufficient permission")).code).toBe("PERMISSION_DENIED")
    expect(classifyGscError({ code: 500, message: "internal" }).code).toBe("OTHER")
  })
})

describe("makeGscGateway (request construction + error passthrough)", () => {
  it("builds the query request and returns mapped rows", async () => {
    let seen: any
    const query: GscQueryFn = async (params) => {
      seen = params
      return { data: { rows: [{ keys: ["k"], clicks: 2, impressions: 20, ctr: 0.1, position: 5 }] } }
    }
    const gw = makeGscGateway(query)
    const rows = await gw.query("sc-domain:example.com", ["query"], bounds, 25000)
    expect(seen.siteUrl).toBe("sc-domain:example.com")
    expect(seen.requestBody).toEqual({ startDate: "2026-01-01", endDate: "2026-01-31", dimensions: ["query"], rowLimit: 25000 })
    expect(rows[0].clicks).toBe(2)
  })
  // FAILURE-PATH: a 403 becomes a typed GscApiError (not empty rows).
  it("throws a typed GscApiError on a 403", async () => {
    const query: GscQueryFn = async () => { throw { code: 403, message: "denied" } }
    await expect(makeGscGateway(query).query("s", ["query"], bounds, 10)).rejects.toBeInstanceOf(GscApiError)
  })
})

describe("end-to-end: real error classification -> connector three-state read", () => {
  it("a 403 from the gateway surfaces as ERROR (never a fake zero)", async () => {
    const repos = makeMongoRepos(db, "orgGscGw")
    await repos.gsc.upsertMapping({ clientId: "c1", siteUrl: "sc-domain:denied.com", status: "active" })
    const gateway = makeGscGateway(async () => { throw { code: 403, message: "no access" } })
    const r = await getGscAnalytics(repos, "c1", gateway, bounds)
    expect(r.status).toBe("error")
    if (r.status === "error") expect(r.error).toContain("PERMISSION_DENIED")
  })

  it("a healthy response aggregates to present metrics", async () => {
    const repos = makeMongoRepos(db, "orgGscGw2")
    await repos.gsc.upsertMapping({ clientId: "c1", siteUrl: "sc-domain:ok.com", status: "active" })
    const gateway = makeGscGateway(async () => ({ data: { rows: [{ keys: ["a"], clicks: 4, impressions: 40, ctr: 0.1, position: 2 }] } }))
    const r = await getGscAnalytics(repos, "c1", gateway, bounds)
    expect(r.status).toBe("present")
    if (r.status === "present") expect(r.value.clicks).toBe(4)
  })
})
