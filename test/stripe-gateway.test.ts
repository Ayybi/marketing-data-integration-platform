import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import {
  mapStripeSubscription,
  makeStripeGateway,
  type StripeSubListClient,
  type StripeApiList,
  type StripeRawSubscription,
} from "../src/lib/stripe-gateway.js"
import { runFullStripeSync, getStripeOverviewStats } from "../src/lib/stripe.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_stripe_gw_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  await db.collection("stripe_subscriptions").deleteMany({})
  await db.collection("stripe_overview_cache").deleteMany({})
  await db.collection("sync_log").deleteMany({})
})

function rawSub(id: string, over: Partial<StripeRawSubscription> = {}): StripeRawSubscription {
  return {
    id,
    status: "active",
    customer: { id: "cus_" + id, email: id + "@x.com" },
    items: { data: [{ price: { unit_amount: 10000, nickname: "Pro", recurring: { interval: "month", interval_count: 1 } }, quantity: 1 }] },
    ...over,
  }
}

// Fake Stripe client that paginates a canned roster in pages of `pageSize`.
function fakeClient(subs: StripeRawSubscription[], pageSize = 2): StripeSubListClient & { calls: number } {
  const c = {
    calls: 0,
    subscriptions: {
      async list(params: { starting_after?: string; limit: number }): Promise<StripeApiList> {
        c.calls += 1
        const startIdx = params.starting_after ? subs.findIndex((s) => s.id === params.starting_after) + 1 : 0
        const slice = subs.slice(startIdx, startIdx + pageSize)
        return { data: slice, has_more: startIdx + pageSize < subs.length }
      },
    },
  }
  return c
}

describe("mapStripeSubscription (pure)", () => {
  it("maps customer, items, discount, pause into RawStripeSub", () => {
    const r = mapStripeSubscription(
      rawSub("1", {
        pause_collection: { behavior: "void" },
        discounts: [{ coupon: { percent_off: 10 } }],
        customer: { id: "cus_1", email: "a@b.com" },
      }),
    )
    expect(r).toMatchObject({
      id: "1",
      status: "active",
      customerId: "cus_1",
      customerEmail: "a@b.com",
      collectionPaused: true,
      discountPercentOff: 10,
      productName: "Pro",
    })
    expect(r.items[0]).toEqual({ priceAmountCents: 10000, interval: "month", intervalCount: 1, quantity: 1 })
  })

  it("handles a string customer id and the legacy single-discount field", () => {
    const r = mapStripeSubscription(rawSub("2", { customer: "cus_str", discount: { coupon: { percent_off: 25 } }, discounts: null }))
    expect(r.customerId).toBe("cus_str")
    expect(r.customerEmail).toBeUndefined()
    expect(r.discountPercentOff).toBe(25)
  })
})

describe("makeStripeGateway (pagination)", () => {
  it("follows has_more across pages and returns the full roster", async () => {
    const subs = Array.from({ length: 5 }, (_, i) => rawSub("s" + i))
    const c = fakeClient(subs, 2)
    const gw = makeStripeGateway(c)
    const all = await gw.listSubscriptions()
    expect(all).toHaveLength(5)
    expect(c.calls).toBe(3) // 2 + 2 + 1
    expect(all.map((s) => s.id)).toEqual(["s0", "s1", "s2", "s3", "s4"])
  })
})

describe("end-to-end: fake Stripe client -> gateway -> runFullStripeSync -> Mongo MRR", () => {
  it("computes and stores MRR from the paginated roster", async () => {
    const repos = makeMongoRepos(db, "orgGw")
    const subs = [
      rawSub("a"), // $100/mo
      rawSub("b", { items: { data: [{ price: { unit_amount: 120000, recurring: { interval: "year", interval_count: 1 } }, quantity: 1 }] } }), // $1200/yr = $100/mo
      rawSub("c", { status: "canceled" }), // excluded
    ]
    const gateway = makeStripeGateway(fakeClient(subs, 2))
    const res = await runFullStripeSync(repos, gateway)
    expect(res.processed).toBe(3)
    expect(res.mrrCents).toBe(20000) // 10000 + 10000, canceled excluded

    const overview = await getStripeOverviewStats(repos)
    expect(overview.status).toBe("present")
    if (overview.status === "present") {
      expect(overview.value.mrrCents).toBe(20000)
      expect(overview.value.activeSubscribers).toBe(2)
    }
  })
})
