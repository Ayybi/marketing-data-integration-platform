import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import type { Repos } from "../src/lib/db/types.js"
import {
  normalizeSubscriptionMrr,
  computeMrrCents,
  runFullStripeSync,
  getStripeOverviewStats,
  StripeSyncAbortError,
  type StripeGateway,
  type RawStripeSub,
} from "../src/lib/stripe.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db
let repos: Repos

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_stripe_test")
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
  repos = makeMongoRepos(db, "orgStripe")
})

function sub(id: string, over: Partial<RawStripeSub> = {}): RawStripeSub {
  return {
    id, status: "active", customerId: "cus_" + id, items: [{ priceAmountCents: 10000, interval: "month", intervalCount: 1, quantity: 1 }], ...over,
  }
}
const gw = (subs: RawStripeSub[] | Error): StripeGateway => ({
  async listSubscriptions() {
    if (subs instanceof Error) throw subs
    return subs
  },
})

describe("normalizeSubscriptionMrr (pure)", () => {
  it("monthly stays; yearly /12; quantity multiplies; discount applies", () => {
    expect(normalizeSubscriptionMrr(sub("a"))).toBe(10000)
    expect(normalizeSubscriptionMrr(sub("b", { items: [{ priceAmountCents: 120000, interval: "year", intervalCount: 1, quantity: 1 }] }))).toBe(10000)
    expect(normalizeSubscriptionMrr(sub("c", { items: [{ priceAmountCents: 10000, interval: "month", intervalCount: 1, quantity: 3 }] }))).toBe(30000)
    expect(normalizeSubscriptionMrr(sub("d", { discountPercentOff: 10 }))).toBe(9000)
  })
  it("only active/trialing/past_due count; collection-paused is 0", () => {
    expect(normalizeSubscriptionMrr(sub("e", { status: "canceled" }))).toBe(0)
    expect(normalizeSubscriptionMrr(sub("f", { collectionPaused: true }))).toBe(0)
    expect(normalizeSubscriptionMrr(sub("g", { status: "trialing" }))).toBe(10000)
  })
})

describe("runFullStripeSync (happy path)", () => {
  it("upserts subscriptions and computes overview MRR", async () => {
    const res = await runFullStripeSync(repos, gw([sub("1"), sub("2"), sub("3", { status: "canceled" })]))
    expect(res.processed).toBe(3)
    expect(res.mrrCents).toBe(20000) // canceled excluded
    const overview = await getStripeOverviewStats(repos)
    expect(overview.status).toBe("present")
    if (overview.status === "present") {
      expect(overview.value.mrrCents).toBe(20000)
      expect(overview.value.activeSubscribers).toBe(2)
    }
  })
})

describe("BUG-145 roster-sanity guard (never wipe MRR)", () => {
  it("aborts (partial) and preserves stored MRR when the fetched roster is implausibly small", async () => {
    // Seed 12 stored subs + a good overview.
    const many = Array.from({ length: 12 }, (_, i) => sub("s" + i))
    await runFullStripeSync(repos, gw(many))
    const before = await getStripeOverviewStats(repos)
    expect(before.status).toBe("present")

    // Now Stripe returns only 3 (implausible) -> controlled abort, existing data intact.
    await expect(runFullStripeSync(repos, gw([sub("s0"), sub("s1"), sub("s2")]))).rejects.toBeInstanceOf(StripeSyncAbortError)

    // MRR + roster preserved (12 rows still stored, overview unchanged).
    expect(await repos.stripe.countSubscriptions()).toBe(12)
    const after = await getStripeOverviewStats(repos)
    if (after.status === "present" && before.status === "present") expect(after.value.mrrCents).toBe(before.value.mrrCents)

    // The run was logged as partial.
    const log = await repos.syncLog.recent("stripe", 1)
    expect(log[0].status).toBe("partial")
    expect(log[0].metadata?.aborted).toBe(true)
  })

  // FAILURE-PATH: a load-bearing list read failure aborts (partial), does not wipe, returns aborted.
  it("aborts on a load-bearing read failure without wiping", async () => {
    await runFullStripeSync(repos, gw([sub("a"), sub("b")]))
    const res = await runFullStripeSync(repos, gw(new Error("stripe 500")))
    expect(res.aborted).toBe(true)
    expect(await repos.stripe.countSubscriptions()).toBe(2) // preserved
    const log = await repos.syncLog.recent("stripe", 1)
    expect(log[0].status).toBe("partial")
  })

  it("does NOT abort when stored roster is small (<10) even if fetch shrinks", async () => {
    await runFullStripeSync(repos, gw([sub("a"), sub("b"), sub("c")]))
    // stored 3 (<10) -> guard does not trip; a legitimately smaller roster is allowed.
    const res = await runFullStripeSync(repos, gw([sub("a")]))
    expect(res.aborted).toBe(false)
    expect(res.processed).toBe(1)
  })
})

describe("getStripeOverviewStats (three-state)", () => {
  it("absent before any sync", async () => {
    expect((await getStripeOverviewStats(repos)).status).toBe("absent")
  })
})
