import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { MongoClient, type Db } from "mongodb"
import { makeMongoRepos } from "../src/lib/db/mongo/repos.js"
import { bootstrapIndexes } from "../src/lib/db/mongo/bootstrap.js"
import type { Repos } from "../src/lib/db/types.js"
import type { Fetcher, HttpResponse } from "../src/lib/http.js"
import { matchByDomain } from "../src/lib/discovery/automatch.js"
import { discoverGa4Properties, discoverGbpLocations, type Ga4AdminGateway } from "../src/lib/discovery/sync.js"
import { createMapping, listDiscovery } from "../src/lib/discovery/mapping.js"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
let client: MongoClient
let db: Db
let repos: Repos

beforeAll(async () => {
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 4000 })
  await client.connect()
  db = client.db("mdh_discovery_test")
  await db.dropDatabase()
  await bootstrapIndexes(db)
})
afterAll(async () => {
  if (db) await db.dropDatabase()
  if (client) await client.close()
})
beforeEach(async () => {
  for (const c of ["ga4_properties", "gbp_locations", "ga4_property_mappings", "gbp_location_mappings", "gsc_property_mappings", "clients"]) await db.collection(c).deleteMany({})
  repos = makeMongoRepos(db, "orgD")
})

describe("matchByDomain (pure auto-match)", () => {
  it("matches discovered website_uri to client domains, ignoring scheme/www", () => {
    const discovered = [{ externalId: "prop-1", websiteUri: "https://www.acme.com/" }, { externalId: "prop-2", websiteUri: "http://beta.io" }, { externalId: "prop-3" }]
    const clients = [{ clientId: "cA", domain: "acme.com" }, { clientId: "cB", domain: "https://beta.io/x" }, { clientId: "cNo", domain: "unknown.com" }, { clientId: "cNil" }]
    expect(matchByDomain(discovered, clients)).toEqual([
      { clientId: "cA", externalId: "prop-1", domain: "acme.com" },
      { clientId: "cB", externalId: "prop-2", domain: "beta.io" },
    ])
  })
})

describe("discoverGa4Properties (injected admin gateway)", () => {
  it("upserts discovered properties into the discovery table", async () => {
    const gateway: Ga4AdminGateway = {
      async listProperties() {
        return [
          { propertyId: "111", displayName: "Acme", accountId: "accounts/1", websiteUri: "https://acme.com" },
          { propertyId: "222", displayName: "Beta" },
        ]
      },
    }
    const res = await discoverGa4Properties(repos, gateway)
    expect(res.discovered).toBe(2)
    const listed = await listDiscovery(repos, "ga4")
    expect(listed.find((p) => p.externalId === "111")?.websiteUri).toBe("https://acme.com")
  })
})

describe("discoverGbpLocations (REST via fetcher)", () => {
  it("walks accounts -> locations and upserts them", async () => {
    const fetcher: Fetcher = async (url): Promise<HttpResponse> => {
      let body: unknown = {}
      if (url.includes("/locations")) body = { locations: [{ name: "locations/5", title: "Store", websiteUri: "https://store.example.com", storefrontAddress: { addressLines: ["1 Main"], locality: "Town" } }] }
      else if (url.includes("mybusinessaccountmanagement")) body = { accounts: [{ name: "accounts/9" }] }
      return { status: 200, ok: true, text: async () => JSON.stringify(body), json: async () => body }
    }
    const res = await discoverGbpLocations(repos, "tok", fetcher)
    expect(res.discovered).toBe(1)
    const listed = await listDiscovery(repos, "gbp")
    expect(listed[0]).toMatchObject({ externalId: "locations/5", label: "Store", websiteUri: "https://store.example.com" })
  })

  // FAILURE-PATH: an accounts read failure THROWS (never a silent empty discovery that could mislead).
  it("throws when the accounts read fails", async () => {
    const fetcher: Fetcher = async () => ({ status: 500, ok: false, text: async () => "", json: async () => ({}) })
    await expect(discoverGbpLocations(repos, "tok", fetcher)).rejects.toThrow(/GBP accounts -> 500/)
  })
})

describe("createMapping (generic)", () => {
  it("creates the right per-source mapping row", async () => {
    await createMapping(repos, { source: "ga4", clientId: "c1", externalId: "prop-1" })
    await createMapping(repos, { source: "gsc", clientId: "c1", externalId: "sc-domain:acme.com" })
    await createMapping(repos, { source: "callrail", clientId: "c1", externalId: "co1", accountId: "acct1" })
    expect((await repos.ga4.getMappingByClient("c1")).status).toBe("present")
    expect((await repos.gsc.getMappingByClient("c1")).status).toBe("present")
    expect((await repos.callrail.getMappingByClient("c1")).status).toBe("present")
  })
  it("callrail mapping requires an accountId", async () => {
    await expect(createMapping(repos, { source: "callrail", clientId: "c1", externalId: "co1" })).rejects.toThrow(/requires accountId/)
  })
})

describe("end-to-end: discover -> automatch -> mapping", () => {
  it("auto-matches a discovered GA4 property to a client by domain", async () => {
    await repos.clients.upsert({ clientId: "cAcme", domain: "acme.com", name: "Acme" })
    await discoverGa4Properties(repos, { async listProperties() { return [{ propertyId: "999", websiteUri: "https://www.acme.com" }] } })
    const discovered = (await listDiscovery(repos, "ga4")).map((d) => ({ externalId: d.externalId, websiteUri: d.websiteUri }))
    const suggestions = matchByDomain(discovered, [{ clientId: "cAcme", domain: "acme.com" }])
    expect(suggestions).toEqual([{ clientId: "cAcme", externalId: "999", domain: "acme.com" }])
    await createMapping(repos, { source: "ga4", clientId: "cAcme", externalId: "999" })
    const m = await repos.ga4.getMappingByClient("cAcme")
    if (m.status === "present") expect(m.value.ga4PropertyId).toBe("999")
  })
})
