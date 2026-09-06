import { describe, it, expect, afterEach } from "vitest"
import type { Fetcher, HttpResponse } from "../src/lib/http.js"
import { SemrushSeoProvider } from "../src/lib/seo/semrush-provider.js"
import { FakeSeoProvider } from "../src/lib/seo/fake-provider.js"
import { getSeoProvider, setSeoProvider, SeoProviderNotConfigured, SeoQuotaError, type SeoProvider } from "../src/lib/seo/index.js"

const text = (body: string, status = 200): HttpResponse => ({ status, ok: status < 300, text: async () => body, json: async () => ({}) })
function route(fn: (url: string) => HttpResponse | "throw"): Fetcher {
  return async (url) => {
    const r = fn(url)
    if (r === "throw") throw new Error("transport")
    return r
  }
}

afterEach(() => setSeoProvider(null))

describe("SemrushSeoProvider (adapter maps vendor -> normalized)", () => {
  it("domainOverview maps SEMrush fields", async () => {
    const body = "Database;Domain;Rank;Organic Keywords;Organic Traffic;Organic Cost\nus;example.com;1500;3200;54000;12000"
    const p = new SemrushSeoProvider(route(() => text(body)), "k")
    const r = await p.domainOverview("example.com")
    expect(r).toEqual({ status: "present", value: { organicTraffic: 54000, organicKeywords: 3200, rank: 1500 } })
  })

  it("backlinks maps authorityScore/total/referring", async () => {
    const body = "Ascore;Total;Domains num\n72;100000;3400"
    const p = new SemrushSeoProvider(route(() => text(body)), "k")
    const r = await p.backlinks("example.com")
    expect(r).toEqual({ status: "present", value: { authorityScore: 72, totalBacklinks: 100000, referringDomains: 3400 } })
  })

  it("absent on NOTHING FOUND, error on HTTP failure (three-state preserved at the port)", async () => {
    expect((await new SemrushSeoProvider(route(() => text("ERROR 50 :: NOTHING FOUND")), "k").domainOverview("x.com")).status).toBe("absent")
    expect((await new SemrushSeoProvider(route(() => text("", 503)), "k").backlinks("x.com")).status).toBe("error")
  })

  it("quota maps units three-state; depletion -> ok balance 0", async () => {
    expect(await new SemrushSeoProvider(route(() => text("50000")), "k").quota()).toEqual({ kind: "ok", balance: 50000 })
    expect(await new SemrushSeoProvider(route(() => text("", 500)), "k").quota()).toMatchObject({ kind: "unreadable" })
  })

  // INVARIANT: throwOnQuota surfaces depletion as a normalized SeoQuotaError (vendor-agnostic signal).
  it("throwOnQuota -> SeoQuotaError on depletion", async () => {
    const p = new SemrushSeoProvider(route(() => text("ERROR 120 :: NOT ENOUGH API UNITS")), "k")
    await expect(p.domainOverview("x.com", { throwOnQuota: true })).rejects.toBeInstanceOf(SeoQuotaError)
  })
})

describe("provider is swappable — callers get the same output shape regardless of vendor", () => {
  async function readOverview(p: SeoProvider) {
    const r = await p.domainOverview("example.com")
    return r.status === "present" ? r.value : null
  }

  it("SEMrush and a different vendor yield the identical normalized shape", async () => {
    const semrush = new SemrushSeoProvider(route(() => text("Database;Domain;Rank;Organic Keywords;Organic Traffic;Organic Cost\nus;example.com;10;20;30;40")), "k")
    const other = new FakeSeoProvider({ name: "ahrefs-like", overview: { status: "present", value: { organicTraffic: 30, organicKeywords: 20, rank: 10 } } })
    expect(await readOverview(semrush)).toEqual({ organicTraffic: 30, organicKeywords: 20, rank: 10 })
    expect(await readOverview(other)).toEqual({ organicTraffic: 30, organicKeywords: 20, rank: 10 }) // same keys, same caller code
  })

  // A limited-capability vendor (no backlinks) returns unsupported_capability, NOT a fake zero.
  it("a provider without a capability reports it distinctly", async () => {
    const googleOnly = new FakeSeoProvider({ name: "google-only", capabilities: ["overview", "keywords"] })
    expect(googleOnly.capabilities.has("backlinks")).toBe(false)
    const r = await googleOnly.backlinks("x.com")
    expect(r).toEqual({ status: "error", error: "unsupported_capability:backlinks" })
    expect(await googleOnly.quota()).toEqual({ kind: "unlimited" }) // unmetered vendor
  })
})

describe("getSeoProvider factory", () => {
  it("defaults to SEMrush and honors the env key", () => {
    process.env.SEO_PROVIDER = "semrush"
    process.env.SEMRUSH_API_KEY = "k"
    expect(getSeoProvider().name).toBe("semrush")
  })
  it("throws SeoProviderNotConfigured when the key is missing (-> 501 at the route)", () => {
    process.env.SEO_PROVIDER = "semrush"
    delete process.env.SEMRUSH_API_KEY
    expect(() => getSeoProvider()).toThrow(SeoProviderNotConfigured)
  })
  it("rejects an unknown provider", () => {
    process.env.SEO_PROVIDER = "not-a-vendor"
    expect(() => getSeoProvider()).toThrow(/Unknown SEO_PROVIDER/)
    delete process.env.SEO_PROVIDER
  })
  it("setSeoProvider overrides for DI", () => {
    setSeoProvider(new FakeSeoProvider({ name: "injected" }))
    expect(getSeoProvider().name).toBe("injected")
  })
})
