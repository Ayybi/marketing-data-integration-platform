import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import { makeUsageMeter, monthWindow, planLimit } from "../src/lib/quota/meter.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_quota_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  await db.collection("usage_counters").deleteMany({})
})

const W = "2026-09"

describe("UsageMeter", () => {
  it("records and reads usage", async () => {
    const m = makeUsageMeter(db)
    expect(await m.get("orgA", "seo_reads", W)).toBe(0)
    await m.consume("orgA", "seo_reads", W, 100)
    await m.consume("orgA", "seo_reads", W, 100)
    expect(await m.get("orgA", "seo_reads", W)).toBe(2)
  })

  it("consume allows up to the limit then refuses (atomic guard)", async () => {
    const m = makeUsageMeter(db)
    const r1 = await m.consume("orgB", "ads_reads", W, 2)
    const r2 = await m.consume("orgB", "ads_reads", W, 2)
    const r3 = await m.consume("orgB", "ads_reads", W, 2)
    expect(r1).toMatchObject({ allowed: true, used: 1 })
    expect(r2).toMatchObject({ allowed: true, used: 2 })
    expect(r3).toMatchObject({ allowed: false, used: 2, limit: 2 }) // over-limit refused, count NOT incremented
    expect(await m.get("orgB", "ads_reads", W)).toBe(2)
  })

  it("isolates tenants", async () => {
    const m = makeUsageMeter(db)
    await m.consume("orgX", "seo_reads", W, 10)
    expect(await m.get("orgX", "seo_reads", W)).toBe(1)
    expect(await m.get("orgY", "seo_reads", W)).toBe(0) // orgY unaffected
  })

  it("usageForOrg returns a per-meter map", async () => {
    const m = makeUsageMeter(db)
    await m.consume("orgZ", "seo_reads", W, 10)
    await m.consume("orgZ", "ads_reads", W, 10)
    expect(await m.usageForOrg("orgZ", W)).toEqual({ seo_reads: 1, ads_reads: 1 })
  })
})

describe("plan limits + window", () => {
  it("planLimit falls back to a generous default", () => {
    expect(planLimit("seo_reads")).toBeGreaterThan(0)
  })
  it("monthWindow is YYYY-MM", () => {
    expect(monthWindow(new Date("2026-09-05T00:00:00Z"))).toBe("2026-09")
  })
})
