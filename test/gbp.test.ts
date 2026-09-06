import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import type { Repos } from "../src/lib/db/types.js"
import type { Fetcher, HttpResponse } from "../src/lib/http.js"
import {
  getAccessToken,
  normalizeGbpSnapshots,
  fetchGbpReviews,
  syncGbpForClient,
  getGbpReviewMetric,
  getGbpLiveDataAggregated,
} from "../src/lib/gbp.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db
let repos: Repos

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_gbp_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  await db.collection("gbp_location_mappings").deleteMany({})
  await db.collection("gbp_snapshots").deleteMany({})
  await db.collection("gbp_review_snapshots").deleteMany({})
  repos = makeMongoRepos(db, "orgB")
})

function route(fn: (url: string, init?: any) => HttpResponse | "throw"): Fetcher {
  return async (url, init) => {
    const r = fn(url, init)
    if (r === "throw") throw new Error(`transport error ${url}`)
    return r
  }
}
const ok = (json: unknown, status = 200): HttpResponse => ({ status, ok: status < 300, text: async () => JSON.stringify(json), json: async () => json })

const today = new Date().toISOString().slice(0, 10)
const bounds = { startDate: today, endDate: today }
const [Y, M, D] = today.split("-").map(Number)

describe("getAccessToken (B5, mint from refresh token)", () => {
  it("returns the minted token", async () => {
    const f = route(() => ok({ access_token: "at123" }))
    expect(await getAccessToken(f, "rt", { clientId: "c", clientSecret: "s" })).toBe("at123")
  })
  // FAILURE-PATH: a token refresh failure THROWS, never returns a blank token.
  it("throws on a non-ok refresh", async () => {
    const f = route(() => ok({}, 400))
    await expect(getAccessToken(f, "rt", { clientId: "c", clientSecret: "s" })).rejects.toThrow(/token refresh failed: 400/)
  })
})

describe("normalizeGbpSnapshots (pure)", () => {
  it("maps metrics to fields and derives views/actions", () => {
    const raw = {
      multiDailyMetricTimeSeries: [
        { dailyMetricTimeSeries: [
          { dailyMetric: "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", timeSeries: { datedValues: [{ date: { year: Y, month: M, day: D }, value: "10" }] } },
          { dailyMetric: "BUSINESS_IMPRESSIONS_MOBILE_MAPS", timeSeries: { datedValues: [{ date: { year: Y, month: M, day: D }, value: "5" }] } },
          { dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ date: { year: Y, month: M, day: D }, value: "3" }] } },
          { dailyMetric: "WEBSITE_CLICKS", timeSeries: { datedValues: [{ date: { year: Y, month: M, day: D }, value: "2" }] } },
        ] },
      ],
    }
    const rows = normalizeGbpSnapshots("c1", "loc1", raw)
    expect(rows).toHaveLength(1)
    expect(rows[0].searchViews).toBe(10)
    expect(rows[0].mapsViews).toBe(5)
    expect(rows[0].views).toBe(15)
    expect(rows[0].actions).toBe(5) // calls 3 + website 2
  })
})

describe("fetchGbpReviews (BUG-166: never '0 reviews')", () => {
  it("ok with an authoritative count", async () => {
    const f = route(() => ok({ totalReviewCount: 42, averageRating: 4.6 }))
    expect(await fetchGbpReviews(f, "t", "loc1")).toEqual({ ok: true, totalCount: 42, averageRating: 4.6 })
  })
  // FAILURE-PATH: a failed reviews read is { ok:false, reason }, NOT a fabricated 0-count.
  it("not-ok on HTTP failure (no fake zero)", async () => {
    const f = route(() => ok({}, 503))
    expect(await fetchGbpReviews(f, "t", "loc1")).toEqual({ ok: false, reason: "HTTP 503" })
  })
  it("not-ok on a transport throw", async () => {
    const f = route(() => "throw")
    const r = await fetchGbpReviews(f, "t", "loc1")
    expect(r.ok).toBe(false)
  })
  it("not-ok when the response has no totalReviewCount (unknown != zero)", async () => {
    const f = route(() => ok({ averageRating: 4.1 }))
    expect(await fetchGbpReviews(f, "t", "loc1")).toEqual({ ok: false, reason: "no totalReviewCount in response" })
  })
})

describe("syncGbpForClient + reads", () => {
  it("writes metrics + an authoritative review snapshot, but never a failed-read review", async () => {
    await repos.gbp.upsertMapping({ clientId: "c1", locationId: "loc1", status: "active" })
    // First: a good reviews read is stored.
    const good = route((url) =>
      url.includes(":fetchMultiDailyMetricsTimeSeries")
        ? ok({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ date: { year: Y, month: M, day: D }, value: "4" }] } }] }] })
        : ok({ totalReviewCount: 12, averageRating: 4.5 }),
    )
    await syncGbpForClient(repos, "c1", "tok", bounds, good)
    let review = await getGbpReviewMetric(repos, "c1", "loc1")
    expect(review.status).toBe("present")
    if (review.status === "present") expect(review.value.totalCount).toBe(12)

    // Then: a FAILED reviews read must NOT overwrite the stored 12 with a zero.
    const badReviews = route((url) =>
      url.includes(":fetchMultiDailyMetricsTimeSeries")
        ? ok({ multiDailyMetricTimeSeries: [] })
        : ok({}, 500),
    )
    await syncGbpForClient(repos, "c1", "tok", bounds, badReviews)
    review = await getGbpReviewMetric(repos, "c1", "loc1")
    expect(review.status).toBe("present")
    if (review.status === "present") expect(review.value.totalCount).toBe(12) // preserved, not zeroed

    const metrics = await getGbpLiveDataAggregated(repos, "c1", bounds)
    expect(metrics.status).toBe("present")
    if (metrics.status === "present") expect(metrics.value.calls).toBe(4)
  })

  it("getGbpLiveDataAggregated: absent for a client with no locations", async () => {
    expect((await getGbpLiveDataAggregated(repos, "nope", bounds)).status).toBe("absent")
  })
})
