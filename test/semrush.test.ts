import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import type { Repos } from "../src/lib/db/types.js"
import type { Fetcher, HttpResponse } from "../src/lib/http.js"
import {
  parseSemrushCsv,
  readApiUnitsBalance,
  fetchDomainOverview,
  fetchDomainBacklinks,
  syncSemrushProjects,
  SemrushUnitsError,
} from "../src/lib/semrush.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db
let repos: Repos

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_semrush_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  await db.collection("semrush_projects").deleteMany({})
  repos = makeMongoRepos(db, "orgSem")
})

const text = (body: string, status = 200): HttpResponse => ({ status, ok: status < 300, text: async () => body, json: async () => ({}) })
function route(fn: (url: string) => HttpResponse | "throw"): Fetcher {
  return async (url) => {
    const r = fn(url)
    if (r === "throw") throw new Error("transport")
    return r
  }
}

describe("parseSemrushCsv (positional by bound columns)", () => {
  it("maps ;-separated rows to the requested column codes", () => {
    const body = "Domain;Organic Keywords\nexample.com;1234"
    expect(parseSemrushCsv(body, ["Dn", "Or"])).toEqual([{ Dn: "example.com", Or: "1234" }])
  })
  it("empty on header-only body", () => {
    expect(parseSemrushCsv("Header row\n", ["Dn"])).toEqual([])
  })
})

describe("readApiUnitsBalance (three-state, B2)", () => {
  it("ok balance on a numeric body", async () => {
    expect(await readApiUnitsBalance(route(() => text("50000")), "k")).toEqual({ kind: "ok", balance: 50000 })
  })
  it("unconfigured when no key", async () => {
    expect(await readApiUnitsBalance(route(() => text("x")), null)).toEqual({ kind: "unconfigured" })
  })
  // FAILURE-PATH: a transport failure is UNREADABLE, never a fabricated balance.
  it("unreadable on transport throw", async () => {
    expect(await readApiUnitsBalance(route(() => "throw"), "k")).toMatchObject({ kind: "unreadable" })
  })
  it("depletion reads as an authoritative balance 0", async () => {
    expect(await readApiUnitsBalance(route(() => text("ERROR 130 :: API UNITS BALANCE IS TOO LOW")), "k")).toEqual({ kind: "ok", balance: 0 })
  })
})

describe("fetchDomainOverview / backlinks (three-state)", () => {
  it("present with parsed metrics", async () => {
    const body = "Database;Domain;Rank;Organic Keywords;Organic Traffic;Organic Cost\nus;example.com;1500;3200;54000;12000"
    const r = await fetchDomainOverview(route(() => text(body)), "k", "example.com")
    expect(r.status).toBe("present")
    if (r.status === "present") expect(r.value).toEqual({ organicKeywords: 3200, organicTraffic: 54000, rank: 1500 })
  })
  it("absent on NOTHING FOUND (genuine no-data)", async () => {
    const r = await fetchDomainOverview(route(() => text("ERROR 50 :: NOTHING FOUND")), "k", "unknown.com")
    expect(r.status).toBe("absent")
  })
  // FAILURE-PATH: an HTTP error is ERROR, never absent/empty.
  it("error on HTTP failure", async () => {
    const r = await fetchDomainBacklinks(route(() => text("", 503)), "k", "example.com")
    expect(r.status).toBe("error")
  })
  // INVARIANT: with throwOnUnits, depletion raises SemrushUnitsError (caller marks client depleted).
  it("throws SemrushUnitsError on depletion when throwOnUnits", async () => {
    await expect(fetchDomainOverview(route(() => text("ERROR 120 :: NOT ENOUGH API UNITS")), "k", "x.com", "us", true)).rejects.toBeInstanceOf(SemrushUnitsError)
  })
  it("without throwOnUnits, depletion is a surfaced error (not a silent empty)", async () => {
    const r = await fetchDomainOverview(route(() => text("ERROR 120 :: NOT ENOUGH API UNITS")), "k", "x.com")
    expect(r.status).toBe("error")
  })
})

describe("syncSemrushProjects (prune on delete)", () => {
  it("upserts current projects and prunes the rest", async () => {
    await repos.semrush.upsertProject({ projectId: "old", projectName: "gone" })
    const res = await syncSemrushProjects(repos, [
      { project_id: "1", project_name: "A" },
      { project_id: "2", project_name: "B" },
    ])
    expect(res).toEqual({ upserted: 2, pruned: 1 })
    const ids = (await repos.semrush.listProjects()).map((p) => p.projectId).sort()
    expect(ids).toEqual(["1", "2"])
  })
})
