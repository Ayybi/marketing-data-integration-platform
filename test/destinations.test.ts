import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import type { Repos } from "../src/lib/db/types.js"
import type { Fetcher, HttpResponse } from "../src/lib/http.js"
import { WebhookDestination, webhookSignature, buildDestination, deliverRollup, setDestinationFetcher, setSheetsAppender, setBigQueryInserter, rollupToValues, rollupToBigQueryRows, DestinationNotConfigured } from "../src/lib/destinations/index.js"
import { SheetsDestination, type SheetsAppendFn } from "../src/lib/destinations/sheets.js"
import { BigQueryDestination, type BigQueryInsertFn } from "../src/lib/destinations/bigquery.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db
let repos: Repos

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_destinations_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
  setDestinationFetcher(undefined)
})
beforeEach(async () => {
  for (const c of ["destinations", "ga4_snapshots"]) await db.collection(c).deleteMany({})
  repos = makeMongoRepos(db, "orgDest")
})

function capturingFetcher(status = 200): { fetcher: Fetcher; calls: { url: string; body?: string; headers?: Record<string, string> }[] } {
  const calls: { url: string; body?: string; headers?: Record<string, string> }[] = []
  const fetcher: Fetcher = async (url, init): Promise<HttpResponse> => {
    calls.push({ url, body: init?.body, headers: init?.headers })
    return { status, ok: status < 300, text: async () => "", json: async () => ({}) }
  }
  return { fetcher, calls }
}

describe("WebhookDestination", () => {
  it("POSTs the payload and signs it when a secret is set", async () => {
    const { fetcher, calls } = capturingFetcher(200)
    const dest = new WebhookDestination("https://hook.example.com", "shh", fetcher)
    const payload = { orgId: "o", clientId: "c1", rows: [{ date: "2026-01-01", calls: 3 }] }
    const r = await dest.deliver(payload)
    expect(r).toEqual({ ok: true, status: 200 })
    expect(calls[0].url).toBe("https://hook.example.com")
    expect(calls[0].headers?.["X-Signature"]).toBe(webhookSignature("shh", calls[0].body!))
  })
  // FAILURE-PATH: a non-2xx / transport error is surfaced as { ok:false }, never silently dropped.
  it("surfaces a non-2xx response as an error", async () => {
    const { fetcher } = capturingFetcher(500)
    expect(await new WebhookDestination("https://x", undefined, fetcher).deliver({ orgId: "o", clientId: "c", rows: [] })).toEqual({ ok: false, error: "webhook responded 500" })
  })
})

describe("buildDestination (async)", () => {
  it("builds a webhook; rejects NotConfigured for misconfigured webhook/sheets/bigquery", async () => {
    expect((await buildDestination({ type: "webhook", config: { url: "https://x" } })).type).toBe("webhook")
    await expect(buildDestination({ type: "webhook", config: {} })).rejects.toThrow(DestinationNotConfigured)
    await expect(buildDestination({ type: "sheets", config: {} })).rejects.toThrow(/missing spreadsheetId/)
    await expect(buildDestination({ type: "bigquery", config: {} })).rejects.toThrow(/missing datasetId\/tableId/)
  })
  it("builds sheets + bigquery destinations when their writers are injected", async () => {
    setSheetsAppender(async () => ({ updatedRows: 0 }))
    setBigQueryInserter(async () => ({ inserted: 0 }))
    expect((await buildDestination({ type: "sheets", config: { spreadsheetId: "sheet-1" } })).type).toBe("sheets")
    expect((await buildDestination({ type: "bigquery", config: { datasetId: "ds", tableId: "t" } })).type).toBe("bigquery")
    setSheetsAppender(undefined)
    setBigQueryInserter(undefined)
  })
})

describe("BigQuery destination", () => {
  it("rollupToBigQueryRows stamps orgId + clientId onto each row", () => {
    expect(rollupToBigQueryRows({ orgId: "o1", clientId: "c1", rows: [{ date: "2026-01-01", calls: 3 }] })).toEqual([
      { orgId: "o1", clientId: "c1", date: "2026-01-01", calls: 3 },
    ])
  })
  it("inserts stamped rows and reports the count", async () => {
    let seen: Record<string, unknown>[] | null = null
    const insert: BigQueryInsertFn = async (rows) => {
      seen = rows
      return { inserted: rows.length }
    }
    const dest = new BigQueryDestination(insert)
    const r = await dest.deliver({ orgId: "o1", clientId: "c1", rows: [{ date: "2026-01-01", calls: 3 }] })
    expect(r).toEqual({ ok: true, detail: "inserted 1 rows" })
    expect(seen![0]).toMatchObject({ orgId: "o1", clientId: "c1", calls: 3 })
  })
  // FAILURE-PATH: a partial-failure/insert error surfaces as { ok:false }.
  it("surfaces an insert error", async () => {
    const dest = new BigQueryDestination(async () => { throw new Error("partial failure: invalid schema") })
    expect(await dest.deliver({ orgId: "o", clientId: "c", rows: [{ x: 1 }] })).toEqual({ ok: false, error: "partial failure: invalid schema" })
  })
  it("no rows -> ok, nothing inserted", async () => {
    let called = false
    const dest = new BigQueryDestination(async () => { called = true; return { inserted: 0 } })
    expect(await dest.deliver({ orgId: "o", clientId: "c", rows: [] })).toEqual({ ok: true, detail: "no rows to insert" })
    expect(called).toBe(false)
  })
})

describe("Google Sheets destination", () => {
  it("rollupToValues builds a header + data grid", () => {
    expect(rollupToValues([{ date: "2026-01-01", calls: 3 }, { date: "2026-01-02", calls: 5 }])).toEqual([
      ["date", "calls"],
      ["2026-01-01", 3],
      ["2026-01-02", 5],
    ])
    expect(rollupToValues([])).toEqual([])
  })
  it("appends the value grid to the spreadsheet range", async () => {
    let seen: { spreadsheetId: string; range: string; values: (string | number)[][] } | null = null
    const append: SheetsAppendFn = async (opts) => {
      seen = opts
      return { updatedRows: opts.values.length - 1 }
    }
    const dest = new SheetsDestination("sheet-1", "Rollup", append)
    const r = await dest.deliver({ orgId: "o", clientId: "c1", rows: [{ date: "2026-01-01", calls: 3 }] })
    expect(r).toEqual({ ok: true, detail: "appended 1 rows" })
    expect(seen!.spreadsheetId).toBe("sheet-1")
    expect(seen!.range).toBe("Rollup!A1")
    expect(seen!.values[0]).toEqual(["date", "calls"])
  })
  // FAILURE-PATH: an append error surfaces as { ok:false }, never silently dropped.
  it("surfaces an append error", async () => {
    const dest = new SheetsDestination("sheet-1", "Rollup", async () => { throw new Error("403 not shared") })
    expect(await dest.deliver({ orgId: "o", clientId: "c", rows: [{ x: 1 }] })).toEqual({ ok: false, error: "403 not shared" })
  })
  it("no rows -> ok, nothing appended", async () => {
    let called = false
    const dest = new SheetsDestination("s", "Rollup", async () => { called = true; return {} })
    expect(await dest.deliver({ orgId: "o", clientId: "c", rows: [] })).toEqual({ ok: true, detail: "no rows to append" })
    expect(called).toBe(false)
  })
})

describe("deliverRollup (build rollup -> push to destinations)", () => {
  it("delivers the client's rollup to every configured destination", async () => {
    const { fetcher, calls } = capturingFetcher(200)
    setDestinationFetcher(fetcher)
    await repos.ga4.upsertSnapshot({ clientId: "c1", ga4PropertyId: "p1", snapshotDate: "2026-01-05", sessions: 42, totalUsers: 40, newUsers: 10, conversions: 3, engagedSessions: 30, channels: [], topPages: [] })
    await repos.destinations.upsert({ destinationId: "d1", type: "webhook", config: { url: "https://hook.example.com" }, createdAt: "t" })

    const summary = await deliverRollup(repos, "c1", { startDate: "2026-01-01", endDate: "2026-01-31" })
    expect(summary).toHaveLength(1)
    expect(summary[0].result.ok).toBe(true)
    const sent = JSON.parse(calls[0].body!)
    expect(sent.clientId).toBe("c1")
    expect(sent.rows[0].sessions).toBe(42)
  })

  it("reports a per-destination error without failing the others (sheets missing spreadsheetId)", async () => {
    setDestinationFetcher(capturingFetcher().fetcher)
    await repos.destinations.upsert({ destinationId: "d2", type: "sheets", config: {}, createdAt: "t" })
    const summary = await deliverRollup(repos, "c1", { startDate: "2026-01-01", endDate: "2026-01-31" })
    expect(summary[0].result.ok).toBe(false)
  })

  it("delivers the rollup to a Google Sheets destination (injected appender)", async () => {
    const appended: (string | number)[][][] = []
    setSheetsAppender(async ({ values }) => {
      appended.push(values)
      return { updatedRows: values.length - 1 }
    })
    await repos.ga4.upsertSnapshot({ clientId: "c1", ga4PropertyId: "p1", snapshotDate: "2026-01-08", sessions: 7, totalUsers: 5, newUsers: 2, conversions: 1, engagedSessions: 4, channels: [], topPages: [] })
    await repos.destinations.upsert({ destinationId: "dS", type: "sheets", config: { spreadsheetId: "sheet-xyz", sheetName: "Data" }, createdAt: "t" })
    const summary = await deliverRollup(repos, "c1", { startDate: "2026-01-01", endDate: "2026-01-31" })
    expect(summary[0]).toMatchObject({ type: "sheets", result: { ok: true } })
    expect(appended[0][0]).toContain("sessions") // header row includes the sessions column
    setSheetsAppender(undefined)
  })
})
