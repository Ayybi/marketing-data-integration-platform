import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import { repos } from "../src/lib/db/index.js"
import { encrypt, integrationAad } from "../src/lib/integrations/vault.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db

beforeAll(async () => {
  process.env.INTEGRATION_VAULT_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_test_" + Math.abs(hash(expect.getState().testPath ?? "t")))
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
function hash(s: string): number { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h }

describe("tenant isolation (RLS replacement)", () => {
  it("refuses to build repos without an orgId", () => {
    expect(() => makeMongoRepos(db, "")).toThrow()
    expect(() => repos("", db)).toThrow()
  })

  it("org A never sees org B's CallRail snapshots for the same company", async () => {
    const a = makeMongoRepos(db, "orgA")
    const b = makeMongoRepos(db, "orgB")
    const base = { callrailAccountId: "acct1", callrailCompanyId: "co1", snapshotDate: "2026-01-01", answeredCalls: 0, missedCalls: 0, firstTimeCallers: 0, qualifiedLeads: 0, totalDurationSeconds: 0 }
    await a.callrail.upsertSnapshot({ ...base, clientId: "cA", totalCalls: 10 })
    await b.callrail.upsertSnapshot({ ...base, clientId: "cB", totalCalls: 99 })
    const ra = await a.callrail.snapshotsForClient("cA", "2026-01-01", "2026-01-01")
    const rb = await b.callrail.snapshotsForClient("cB", "2026-01-01", "2026-01-01")
    expect(ra).toHaveLength(1); expect(ra[0].totalCalls).toBe(10)
    expect(rb).toHaveLength(1); expect(rb[0].totalCalls).toBe(99)
  })
})

describe("idempotent conflict keys (§6)", () => {
  it("re-running a company/day overwrites rather than duplicating", async () => {
    const r = makeMongoRepos(db, "orgIdem")
    const base = { clientId: "c1", callrailAccountId: "a", callrailCompanyId: "coX", snapshotDate: "2026-02-02", answeredCalls: 0, missedCalls: 0, firstTimeCallers: 0, qualifiedLeads: 0, totalDurationSeconds: 0 }
    await r.callrail.upsertSnapshot({ ...base, totalCalls: 1 })
    await r.callrail.upsertSnapshot({ ...base, totalCalls: 5 }) // same key, corrected value
    const rows = await r.callrail.snapshotsForClient("c1", "2026-02-02", "2026-02-02")
    expect(rows).toHaveLength(1)
    expect(rows[0].totalCalls).toBe(5)
  })
})

describe("client filtering (§2)", () => {
  it("activeClientIds excludes soft-deleted and churned tenants", async () => {
    const r = makeMongoRepos(db, "orgFilter")
    await r.clients.upsert({ clientId: "active1" })
    await r.clients.upsert({ clientId: "churned", status: "cancel" })
    await r.clients.upsert({ clientId: "deleted", deletedAt: "2026-01-01T00:00:00Z" })
    const ids = await r.clients.activeClientIds()
    expect(ids).toEqual(["active1"])
  })
})

describe("credential vault repo (three-state)", () => {
  it("resolve: present after save, absent when missing", async () => {
    const r = makeMongoRepos(db, "orgCred")
    await r.credentials.save({ scope: "agency", provider: "callrail", status: "active", authPayload: encrypt("KEY123", integrationAad("agency", "callrail")) })
    const present = await r.credentials.resolve("callrail", "agency")
    expect(present).toEqual({ status: "present", value: "KEY123" })
    expect(await r.credentials.resolve("stripe", "agency")).toEqual({ status: "absent" })
    expect(await r.credentials.isConfigured("callrail", "agency")).toBe(true)
    expect(await r.credentials.isConfigured("stripe", "agency")).toBe(false)
  })

  // FAILURE-PATH: a stored blob that cannot be decrypted is ERROR, never absent (never "no credential").
  it("resolve: error when the stored blob is corrupt (decrypt failure != absent)", async () => {
    const r = makeMongoRepos(db, "orgCredBad")
    // Save a blob bound to the WRONG aad so decrypt with the correct aad fails the auth tag.
    await r.credentials.save({ scope: "agency", provider: "semrush", status: "active", authPayload: encrypt("x", integrationAad("agency", "WRONG")) })
    const res = await r.credentials.resolve("semrush", "agency")
    expect(res.status).toBe("error")
  })

  // FAILURE-PATH: a driver throw surfaces as error, never masquerades as absent.
  it("getMappingByClient: driver error surfaces as error, not absent", async () => {
    const brokenDb = { collection: () => ({ findOne: () => { throw new Error("connection reset") } }) } as unknown as Db
    const r = makeMongoRepos(brokenDb, "orgBroken")
    const res = await r.callrail.getMappingByClient("whatever")
    expect(res.status).toBe("error")
  })
})
