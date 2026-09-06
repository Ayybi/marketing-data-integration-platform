import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import type { Repos } from "../src/lib/db/types.js"
import type { Fetcher, HttpResponse } from "../src/lib/http.js"
import { matchStripeClient, getMrrBreakdown } from "../src/lib/stripe.js"
import { getCallRailCallsByDayForClient } from "../src/lib/callrail.js"
import { classifyLeadEvent, getGa4LeadEvents, type Ga4Gateway } from "../src/lib/ga4.js"
import { fetchSearchVolumes } from "../src/lib/semrush.js"
import { getFbAccountsOverview } from "../src/lib/meta.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db
let repos: Repos

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_depth_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  for (const c of ["stripe_subscriptions", "callrail_account_mappings", "callrail_snapshots", "ga4_property_mappings", "fb_account_mappings", "fb_overview_snapshots"]) await db.collection(c).deleteMany({})
  repos = makeMongoRepos(db, "orgDepth")
})

const text = (body: string, status = 200): HttpResponse => ({ status, ok: status < 300, text: async () => body, json: async () => ({}) })

describe("Stripe: matchStripeClient (priority chain + ambiguity guard)", () => {
  const candidates = [
    { clientId: "cManual", stripeCustomerId: "cus_1" },
    { clientId: "cEmail", email: "a@b.com" },
    { clientId: "cName", name: "Acme Plumbing" },
  ]
  it("manual mapping wins", () => {
    expect(matchStripeClient({ customerId: "cus_9" }, candidates, { cus_9: "cPinned" })).toEqual({ clientId: "cPinned", via: "manual" })
  })
  it("then customer id, then email, then name", () => {
    expect(matchStripeClient({ customerId: "cus_1" }, candidates)).toEqual({ clientId: "cManual", via: "customer_id" })
    expect(matchStripeClient({ customerId: "x", customerEmail: "A@B.com" }, candidates)).toEqual({ clientId: "cEmail", via: "email" })
    expect(matchStripeClient({ customerId: "x", customerName: "acme  plumbing" }, candidates)).toEqual({ clientId: "cName", via: "name" })
  })
  // INVARIANT: two clients with the same name do NOT auto-link.
  it("ambiguous name -> no match", () => {
    const dup = [{ clientId: "c1", name: "Acme" }, { clientId: "c2", name: "Acme" }]
    expect(matchStripeClient({ customerId: "x", customerName: "Acme" }, dup)).toEqual({ clientId: null, via: "ambiguous" })
  })
  it("no match -> none", () => {
    expect(matchStripeClient({ customerId: "x", customerEmail: "none@x.com" }, candidates)).toEqual({ clientId: null, via: "none" })
  })
})

describe("Stripe: getMrrBreakdown (from stored subs)", () => {
  it("sums MRR-eligible and groups by status", async () => {
    await repos.stripe.upsertSubscription({ subscriptionId: "s1", customerId: "c", status: "active", monthlyMrrCents: 10000 })
    await repos.stripe.upsertSubscription({ subscriptionId: "s2", customerId: "c", status: "trialing", monthlyMrrCents: 5000 })
    await repos.stripe.upsertSubscription({ subscriptionId: "s3", customerId: "c", status: "canceled", monthlyMrrCents: 9999 })
    const b = await getMrrBreakdown(repos)
    expect(b.mrrCents).toBe(15000) // canceled excluded
    expect(b.activeSubscribers).toBe(2)
    expect(b.byStatus.canceled.count).toBe(1)
  })
})

describe("CallRail: getCallRailCallsByDayForClient", () => {
  it("returns a sorted per-day series; absent for an unmapped client", async () => {
    await repos.callrail.upsertMapping({ clientId: "c1", callrailAccountId: "1", callrailCompanyId: "co1", status: "active" })
    await repos.callrail.upsertSnapshot({ clientId: "c1", callrailAccountId: "1", callrailCompanyId: "co1", snapshotDate: "2026-01-02", totalCalls: 3, answeredCalls: 2, missedCalls: 1, firstTimeCallers: 0, qualifiedLeads: 1, totalDurationSeconds: 0 })
    const r = await getCallRailCallsByDayForClient(repos, "c1", { startDate: "2026-01-01", endDate: "2026-01-31" })
    expect(r.status).toBe("present")
    if (r.status === "present") expect(r.value[0]).toEqual({ date: "2026-01-02", totalCalls: 3, answeredCalls: 2, qualifiedLeads: 1 })
    expect((await getCallRailCallsByDayForClient(repos, "nope", { startDate: "a", endDate: "b" })).status).toBe("absent")
  })
})

describe("GA4: lead events", () => {
  it("classifyLeadEvent buckets by name", () => {
    expect(classifyLeadEvent("generate_lead")).toBe("form")
    expect(classifyLeadEvent("click_to_call")).toBe("call")
    expect(classifyLeadEvent("email_click")).toBe("email")
    expect(classifyLeadEvent("scroll")).toBe("other")
  })
  it("getGa4LeadEvents buckets a report; three-state on mapping", async () => {
    await repos.ga4.upsertMapping({ clientId: "c1", ga4PropertyId: "p1", status: "active" })
    const gateway: Ga4Gateway = { async runReport() { return [{ dimensions: ["generate_lead"], metrics: [4] }, { dimensions: ["phone_call"], metrics: [2] }] } }
    const r = await getGa4LeadEvents(repos, "c1", gateway, { startDate: "a", endDate: "b" })
    expect(r.status).toBe("present")
    if (r.status === "present") expect(r.value).toMatchObject({ form: 4, call: 2, total: 6 })
    expect((await getGa4LeadEvents(repos, "nope", gateway, { startDate: "a", endDate: "b" })).status).toBe("absent")
  })
})

describe("SEMrush: fetchSearchVolumes", () => {
  it("parses batched phrase volumes", async () => {
    const f: Fetcher = async () => text("Keyword;Search Volume\nplumber;5400\nhvac repair;880")
    const r = await fetchSearchVolumes(f, "k", ["plumber", "hvac repair"])
    expect(r.status).toBe("present")
    if (r.status === "present") expect(r.value).toEqual([{ phrase: "plumber", volume: 5400 }, { phrase: "hvac repair", volume: 880 }])
  })
  it("empty phrase list -> present []", async () => {
    const f: Fetcher = async () => text("")
    expect(await fetchSearchVolumes(f, "k", [])).toEqual({ status: "present", value: [] })
  })
})

describe("Meta: getFbAccountsOverview (department view)", () => {
  it("returns each mapped account's stored overview, keeping error rows distinct", async () => {
    await repos.fb.upsertMapping({ clientId: "c1", fbAccountId: "act_1", status: "active" })
    await repos.fb.upsertMapping({ clientId: "c2", fbAccountId: "act_2", status: "active" })
    const ov = { spend: 10, impressions: 100, clicks: 5, ctr: 5, cpc: 2, leads: 1, cpl: 10 }
    await repos.fb.upsertOverview({ fbAccountId: "act_1", clientId: "c1", dateRange: "30d", overview: ov, status: "ok", syncedAt: "t" })
    await repos.fb.upsertOverview({ fbAccountId: "act_2", clientId: "c2", dateRange: "30d", overview: ov, status: "error", error: "boom", syncedAt: "t" })
    const all = await getFbAccountsOverview(repos, "30d")
    expect(all).toHaveLength(2)
    expect(all.find((a) => a.fbAccountId === "act_2")?.status).toBe("error")
  })
})
