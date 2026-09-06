import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import { makeSemrushProjectSource, syncSemrushProjects } from "../src/lib/semrush.js"
import type { Fetcher, HttpResponse } from "../src/lib/http.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_semrush_src_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  await db.collection("semrush_projects").deleteMany({})
})

const resp = (body: string, status = 200): HttpResponse => ({ status, ok: status < 300, text: async () => body, json: async () => JSON.parse(body) })
function route(fn: (url: string) => HttpResponse | "throw"): Fetcher {
  return async (url) => {
    const r = fn(url)
    if (r === "throw") throw new Error("transport")
    return r
  }
}

describe("makeSemrushProjectSource", () => {
  it("parses a JSON array of projects", async () => {
    const src = makeSemrushProjectSource(route(() => resp(JSON.stringify([{ project_id: 1, project_name: "A", url: "a.com" }, { project_id: 2, project_name: "B" }]))), "k")
    const projects = await src()
    expect(projects).toEqual([
      { project_id: 1, project_name: "A", url: "a.com", domain_unicode: undefined },
      { project_id: 2, project_name: "B", url: undefined, domain_unicode: undefined },
    ])
  })
  it("unwraps a { data: [...] } envelope", async () => {
    const src = makeSemrushProjectSource(route(() => resp(JSON.stringify({ data: [{ project_id: 9 }] }))), "k")
    expect((await src())[0].project_id).toBe(9)
  })
  it("an authoritative empty list is [] (genuinely no projects)", async () => {
    const src = makeSemrushProjectSource(route(() => resp("[]")), "k")
    expect(await src()).toEqual([])
  })

  // FAILURE-PATH (critical): a fetch failure THROWS — it must never return [] (which would prune/wipe
  // every stored project). Covers non-ok, transport throw, SEMrush ERROR body, and non-JSON.
  it("throws on a non-ok status (never [] )", async () => {
    await expect(makeSemrushProjectSource(route(() => resp("", 503)), "k")()).rejects.toThrow(/-> 503/)
  })
  it("throws on a transport error", async () => {
    await expect(makeSemrushProjectSource(route(() => "throw"), "k")()).rejects.toThrow(/fetch failed/)
  })
  it("throws on a SEMrush ERROR body", async () => {
    await expect(makeSemrushProjectSource(route(() => resp("ERROR 120 :: NOT ENOUGH API UNITS")), "k")()).rejects.toThrow(/SEMrush projects/)
  })
  it("throws on a non-JSON body", async () => {
    await expect(makeSemrushProjectSource(route(() => resp("not json")), "k")()).rejects.toThrow(/non-JSON|unexpected/)
  })
})

describe("end-to-end: source -> syncSemrushProjects", () => {
  it("upserts fetched projects and prunes the rest", async () => {
    const repos = makeMongoRepos(db, "orgSrc")
    await repos.semrush.upsertProject({ projectId: "stale", projectName: "gone" })
    const src = makeSemrushProjectSource(route(() => resp(JSON.stringify([{ project_id: "1", project_name: "A" }, { project_id: "2", project_name: "B" }]))), "k")
    const res = await syncSemrushProjects(repos, await src())
    expect(res).toEqual({ upserted: 2, pruned: 1 })
    const ids = (await repos.semrush.listProjects()).map((p) => p.projectId).sort()
    expect(ids).toEqual(["1", "2"])
  })

  // The failure path never reaches syncSemrushProjects with [] — so stored projects are safe on error.
  it("a source error is thrown BEFORE any prune, leaving stored projects intact", async () => {
    const repos = makeMongoRepos(db, "orgSrc2")
    await repos.semrush.upsertProject({ projectId: "keep", projectName: "safe" })
    const src = makeSemrushProjectSource(route(() => resp("", 500)), "k")
    await expect(src()).rejects.toThrow() // throws -> caller never calls syncSemrushProjects([])
    expect((await repos.semrush.listProjects()).map((p) => p.projectId)).toEqual(["keep"])
  })
})
