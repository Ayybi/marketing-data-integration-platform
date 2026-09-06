import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import { tokenAccessControl, type HubContext } from "../src/lib/hub-app/adapters.js"
import { handleMetricsRead, handleSyncLog, readToResponse } from "../src/lib/hub-app/handlers.js"
import { runCallRailCron, runStripeCron, verifyCronSecret } from "../src/lib/hub-app/cron.js"
import type { Fetcher, HttpResponse } from "../src/lib/http.js"
import type { StripeGateway, RawStripeSub } from "../src/lib/stripe.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db

beforeAll(async () => {
  process.env.CALLRAIL_API_KEY = "k"
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_hubapp_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
  delete process.env.CALLRAIL_API_KEY
})
beforeEach(async () => {
  for (const c of ["callrail_account_mappings", "callrail_snapshots", "sync_log", "stripe_subscriptions", "stripe_overview_cache"]) await db.collection(c).deleteMany({})
})

const today = new Date().toISOString().slice(0, 10)

describe("readToResponse (three-state -> HTTP)", () => {
  it("present 200, absent 404, error 502", () => {
    expect(readToResponse({ status: "present", value: { x: 1 } })).toEqual({ status: 200, body: { data: { x: 1 } } })
    expect(readToResponse({ status: "absent" })).toEqual({ status: 404, body: { error: "not_connected" } })
    expect(readToResponse({ status: "error", error: "boom" })).toEqual({ status: 502, body: { error: "boom" } })
  })
})

describe("tokenAccessControl", () => {
  it("resolves a bearer to a session, rejects unknown/missing", async () => {
    const ac = tokenAccessControl({ tok1: { orgId: "orgA", capabilities: ["read"] } })
    expect(await ac.authenticate("Bearer tok1")).toEqual({ orgId: "orgA", capabilities: ["read"] })
    expect(await ac.authenticate("Bearer nope")).toBeNull()
    expect(await ac.authenticate(null)).toBeNull()
  })
})

describe("handleMetricsRead", () => {
  function ctx(orgId: string, caps = ["read"]): HubContext {
    return { session: { orgId, capabilities: caps }, repos: makeMongoRepos(db, orgId) }
  }

  it("404 not_connected for an unmapped client (never a fake 200 zero)", async () => {
    const res = await handleMetricsRead(ctx("orgA"), { source: "callrail", clientId: "nope" })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: "not_connected" })
  })

  it("200 with data once a mapping + snapshot exist", async () => {
    const repos = makeMongoRepos(db, "orgA")
    await repos.callrail.upsertMapping({ clientId: "c1", callrailAccountId: "1", callrailCompanyId: "co1", status: "active" })
    await repos.callrail.upsertSnapshot({ clientId: "c1", callrailAccountId: "1", callrailCompanyId: "co1", snapshotDate: today, totalCalls: 8, answeredCalls: 6, missedCalls: 2, firstTimeCallers: 3, qualifiedLeads: 4, totalDurationSeconds: 500 })
    const res = await handleMetricsRead(ctx("orgA"), { source: "callrail", clientId: "c1", from: today, to: today })
    expect(res.status).toBe(200)
    expect((res.body as any).data.qualifiedLeads).toBe(4)
  })

  it("403 without the read capability; 400 for an unknown source", async () => {
    expect((await handleMetricsRead(ctx("orgA", []), { source: "callrail", clientId: "c1" })).status).toBe(403)
    expect((await handleMetricsRead(ctx("orgA"), { source: "wat", clientId: "c1" })).status).toBe(400)
  })

  // Tenant isolation through the handler: orgB cannot see orgA's data.
  it("isolates tenants (orgB sees absent for orgA's client)", async () => {
    const res = await handleMetricsRead(ctx("orgB"), { source: "callrail", clientId: "c1", from: today, to: today })
    expect(res.status).toBe(404)
  })
})

describe("handleSyncLog", () => {
  it("returns tenant-scoped recent runs", async () => {
    const repos = makeMongoRepos(db, "orgLog")
    await repos.syncLog.write({ source: "callrail", operation: "snapshot", recordsAffected: 1, status: "success", errorMessage: null, createdAt: new Date().toISOString() })
    const res = await handleSyncLog({ session: { orgId: "orgLog", capabilities: ["read"] }, repos }, "callrail", 10)
    expect(res.status).toBe(200)
    expect((res.body as any).data).toHaveLength(1)
  })
})

describe("crons (multi-tenant sweep + secret guard)", () => {
  it("verifyCronSecret gates on the bearer", () => {
    process.env.CRON_SECRET = "abc"
    expect(verifyCronSecret("Bearer abc")).toBe(true)
    expect(verifyCronSecret("Bearer x")).toBe(false)
    delete process.env.CRON_SECRET
  })

  it("runCallRailCron sweeps each tenant independently", async () => {
    for (const org of ["o1", "o2"]) {
      const r = makeMongoRepos(db, org)
      await r.callrail.upsertMapping({ clientId: "c", callrailAccountId: "1", callrailCompanyId: "co", status: "active" })
    }
    const fetcher: Fetcher = async (url): Promise<HttpResponse> => {
      const json = url.includes("companies.json") ? { companies: [] } : url.includes("calls.json") ? { calls: [{ id: 1, start_time: `${today}T09:00:00Z`, duration: 10, answered: true }], total_pages: 1 } : {}
      return { status: 200, ok: true, text: async () => JSON.stringify(json), json: async () => json }
    }
    const summary = await runCallRailCron({ orgIds: ["o1", "o2"], makeRepos: (o) => makeMongoRepos(db, o) }, { fetcher, windowDays: 1 })
    expect(summary.tenants).toBe(2)
    expect(summary.runs.every((r) => r.result.processed === 1)).toBe(true)
  })

  // A Stripe BUG-145 abort in one tenant is swallowed (logged partial) and does not throw out of the
  // sweep — proving one tenant's implausible roster cannot fail the whole cron.
  it("runStripeCron swallows a per-tenant abort and preserves that tenant's data", async () => {
    const o1 = makeMongoRepos(db, "o1")
    const many: RawStripeSub[] = Array.from({ length: 12 }, (_, i) => ({ id: "s" + i, status: "active", customerId: "c", items: [{ priceAmountCents: 1000, interval: "month", intervalCount: 1, quantity: 1 }] }))
    // Seed 12 stored subs for o1.
    await runStripeCron({ orgIds: ["o1"], makeRepos: () => o1 }, { gateway: { async listSubscriptions() { return many } } })

    // Now o1's gateway returns an implausibly small roster -> the runner swallows StripeSyncAbortError.
    const abortGateway: StripeGateway = { async listSubscriptions() { return many.slice(0, 2) } }
    const summary = await runStripeCron({ orgIds: ["o1"], makeRepos: () => o1 }, { gateway: abortGateway })
    expect(summary.runs[0].result.aborted).toBe(true)
    expect(await o1.stripe.countSubscriptions()).toBe(12) // preserved through the abort
  })
})
