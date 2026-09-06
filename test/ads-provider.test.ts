import { describe, it, expect, afterEach } from "vitest"
import type { Fetcher, HttpResponse } from "../src/lib/http.js"
import { MetaAdsProvider } from "../src/lib/ads/meta-provider.js"
import { GoogleAdsProvider } from "../src/lib/ads/google-ads-provider.js"
import { FakeAdsProvider } from "../src/lib/ads/fake-provider.js"
import { combineAdInsights, type AdInsights } from "../src/lib/ads/types.js"
import { getAdsProvider, setAdsProvider, listAdPlatforms, isAdPlatform } from "../src/lib/ads/index.js"
import type { LsaGateway } from "../src/lib/lsa.js"

const insights = (json: unknown, status = 200): HttpResponse => ({ status, ok: status < 300, text: async () => JSON.stringify(json), json: async () => json })
function route(fn: (url: string) => HttpResponse | "throw"): Fetcher {
  return async (url) => {
    const r = fn(url)
    if (r === "throw") throw new Error("transport")
    return r
  }
}

afterEach(() => {
  setAdsProvider("meta", null)
  setAdsProvider("google_ads", null)
})

describe("MetaAdsProvider (adapter -> normalized AdInsights, BUG-07 preserved)", () => {
  it("maps account insights, using the grouped 'lead' action", async () => {
    const f = route(() => insights({ data: [{ spend: "100", impressions: "1000", clicks: "50", actions: [{ action_type: "lead", value: "4" }, { action_type: "onsite_conversion.lead_grouped", value: "4" }] }] }))
    const p = new MetaAdsProvider("tok", f)
    const r = await p.accountInsights("act_1", { startDate: "2026-01-01", endDate: "2026-01-31" })
    expect(r.status).toBe("present")
    if (r.status === "present") {
      expect(r.value).toMatchObject({ platform: "meta", spend: 100, impressions: 1000, clicks: 50, leads: 4, cpl: 25 })
    }
  })
  // FAILURE-PATH: a read failure surfaces as error, never fake zeros.
  it("error on a failed insights read", async () => {
    const p = new MetaAdsProvider("tok", route(() => insights({}, 500)))
    expect((await p.accountInsights("act_1", { startDate: "a", endDate: "b" })).status).toBe("error")
  })
})

describe("GoogleAdsProvider (adapter -> normalized AdInsights)", () => {
  const bounds = { startDate: "2026-03-01", endDate: "2026-03-31" }
  it("aggregates leads + daily spend/impressions; leaves clicks/ctr/cpc undefined", async () => {
    const gateway: LsaGateway = {
      async fetchLeads() { return [{ id: 1 }, { id: 2 }, { id: 3 }] },
      async fetchDailyMetrics() { return [{ date: "2026-03-02", impressions: 500, costMicros: 60_000_000 }] }, // $60
    }
    const r = await new GoogleAdsProvider(gateway).accountInsights("cust1", bounds)
    expect(r.status).toBe("present")
    if (r.status === "present") {
      expect(r.value).toMatchObject({ platform: "google_ads", spend: 60, impressions: 500, leads: 3, cpl: 20 })
      expect(r.value.clicks).toBeUndefined() // not measured -> undefined, NOT 0
      expect(r.value.ctr).toBeUndefined()
    }
  })
  // FAILURE-PATH: a gateway throw surfaces as error.
  it("error when the gateway throws", async () => {
    const gateway: LsaGateway = { async fetchLeads() { throw new Error("ads 500") }, async fetchDailyMetrics() { return [] } }
    expect((await new GoogleAdsProvider(gateway).accountInsights("c", bounds)).status).toBe("error")
  })
})

describe("uniform shape + cross-platform rollup (the payoff)", () => {
  it("different platforms return the same normalized keys and combine into a rollup", async () => {
    const meta: AdInsights = { platform: "meta", spend: 100, impressions: 1000, clicks: 50, ctr: 5, cpc: 2, leads: 4, cpl: 25 }
    const google: AdInsights = { platform: "google_ads", spend: 60, impressions: 500, leads: 3, cpl: 20 }
    const roll = combineAdInsights([meta, google])
    expect(roll.spend).toBe(160)
    expect(roll.impressions).toBe(1500)
    expect(roll.leads).toBe(7)
    expect(roll.cpl).toBeCloseTo(160 / 7, 2)
    expect(Object.keys(roll.byPlatform).sort()).toEqual(["google_ads", "meta"])
  })

  it("a caller reads any platform through the same port", async () => {
    const p = new FakeAdsProvider({ status: "present", value: { platform: "tiktok-like", spend: 10, impressions: 100, leads: 1, cpl: 10 } }, "tiktok-like")
    const r = await p.accountInsights("acct", { startDate: "a", endDate: "b" })
    if (r.status === "present") expect(r.value.platform).toBe("tiktok-like")
  })
})

describe("registry", () => {
  it("lists platforms and validates names", () => {
    expect(listAdPlatforms()).toEqual(["meta", "google_ads"])
    expect(isAdPlatform("meta")).toBe(true)
    expect(isAdPlatform("nope")).toBe(false)
  })
  it("rejects an unknown platform without loading any SDK", async () => {
    await expect(getAdsProvider("nope", {} as never)).rejects.toThrow(/Unknown ad platform/)
  })
  it("setAdsProvider overrides a platform for DI", async () => {
    setAdsProvider("meta", new FakeAdsProvider({ status: "absent" }, "meta"))
    const p = await getAdsProvider("meta", {} as never)
    expect(p.platform).toBe("meta")
  })
})
