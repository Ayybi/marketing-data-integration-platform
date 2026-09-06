import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import { FakeLLM } from "../src/lib/llm/adapters/fake.js"
import { classifyTranscription, classifyUnclassifiedQualifiedCalls } from "../src/lib/callrail-classify.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_classify_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  await db.collection("callrail_calls").deleteMany({})
})

describe("classifyTranscription (three-state)", () => {
  it("present when the model returns a valid label", async () => {
    const llm = new FakeLLM().onStructured(FakeLLM.ok({ label: "new_estimate" }))
    expect(await classifyTranscription(llm, "hi I need a quote for a new roof")).toEqual({ status: "present", value: "new_estimate" })
  })
  it("absent when there is no transcription to classify", async () => {
    const llm = new FakeLLM()
    expect(await classifyTranscription(llm, "   ")).toEqual({ status: "absent" })
  })
  // FAILURE-PATH: a model refusal/transport error is ERROR — the call is NOT defaulted to "junk".
  it("error on a model failure (never a silent junk default)", async () => {
    const llm = new FakeLLM().onStructured(FakeLLM.err("refusal", "no"))
    const r = await classifyTranscription(llm, "some text")
    expect(r.status).toBe("error")
  })
  // FAILURE-PATH: an unrecognized label is ERROR, not accepted as a fabricated class.
  it("error when the model returns an unknown label", async () => {
    const llm = new FakeLLM().onStructured(FakeLLM.ok({ label: "totally_made_up" }))
    const r = await classifyTranscription(llm, "some text")
    expect(r.status).toBe("error")
  })
})

describe("classifyUnclassifiedQualifiedCalls (bounded best-effort pass)", () => {
  it("labels qualified calls with a transcription, leaves failed ones unclassified for retry", async () => {
    const repos = makeMongoRepos(db, "orgCls")
    await repos.callrail.upsertCall({ callrailCallId: "1", callrailCompanyId: "co1", clientId: "c1", leadStatus: "good_lead", transcription: "need an estimate" })
    await repos.callrail.upsertCall({ callrailCallId: "2", callrailCompanyId: "co1", clientId: "c1", leadStatus: "good_lead", transcription: "existing job question" })
    // Not eligible: no transcription.
    await repos.callrail.upsertCall({ callrailCallId: "3", callrailCompanyId: "co1", clientId: "c1", leadStatus: "good_lead" })

    // Call 1 classified ok; call 2's model call errors (stays unclassified).
    const llm = new FakeLLM()
      .onStructured(FakeLLM.ok({ label: "new_estimate" }))
      .onStructured(FakeLLM.err("timeout"))
    const out = await classifyUnclassifiedQualifiedCalls(repos, llm, 15)
    expect(out.classified).toBe(1)
    expect(out.errors).toBe(1)

    const c1 = await db.collection("callrail_calls").findOne({ orgId: "orgCls", callrailCallId: "1" })
    const c2 = await db.collection("callrail_calls").findOne({ orgId: "orgCls", callrailCallId: "2" })
    expect(c1?.aiClass).toBe("new_estimate")
    expect(c2?.aiClass ?? null).toBeNull() // failure left it unclassified, NOT mislabeled
  })
})
