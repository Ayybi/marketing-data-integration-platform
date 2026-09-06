// NEW (§7): generic mapping creation across all sources + discovery listing. One place that turns a
// (source, clientId, externalId) into the right per-source mapping row.
import type { Repos } from "../db/types"

export type MappingSource = "ga4" | "gbp" | "gsc" | "callrail" | "lsa" | "meta" | "semrush"

export type CreateMappingInput = {
  source: MappingSource
  clientId: string
  externalId: string // property id / location id / site_url / company id / customer id / fb account / domain
  accountId?: string // required for callrail (agency account id)
  monthlyBudget?: number // optional for lsa
}

export async function createMapping(repos: Repos, input: CreateMappingInput): Promise<void> {
  switch (input.source) {
    case "ga4":
      return repos.ga4.upsertMapping({ clientId: input.clientId, ga4PropertyId: input.externalId, status: "active" })
    case "gbp":
      return repos.gbp.upsertMapping({ clientId: input.clientId, locationId: input.externalId, status: "active" })
    case "gsc":
      return repos.gsc.upsertMapping({ clientId: input.clientId, siteUrl: input.externalId, status: "active" })
    case "lsa":
      return repos.lsa.upsertMapping({ clientId: input.clientId, googleAdsCustomerId: input.externalId, monthlyBudget: input.monthlyBudget ?? 0, status: "active" })
    case "meta":
      return repos.fb.upsertMapping({ clientId: input.clientId, fbAccountId: input.externalId, status: "active" })
    case "semrush":
      return repos.semrush.upsertSiteConfig({ clientId: input.clientId, domain: input.externalId, database: "us", status: "active" })
    case "callrail": {
      if (!input.accountId) throw new Error("callrail mapping requires accountId (agency account)")
      return repos.callrail.upsertMapping({ clientId: input.clientId, callrailAccountId: input.accountId, callrailCompanyId: input.externalId, status: "active" })
    }
  }
}

/** List discovered accounts for a source (only ga4/gbp have discovery tables today). */
export async function listDiscovery(repos: Repos, source: "ga4" | "gbp"): Promise<Array<{ externalId: string; label?: string; websiteUri?: string }>> {
  if (source === "ga4") {
    return (await repos.ga4.listProperties()).map((p) => ({ externalId: p.propertyId, label: p.displayName, websiteUri: p.websiteUri }))
  }
  return (await repos.gbp.listLocations()).map((l) => ({ externalId: l.locationId, label: l.title, websiteUri: l.websiteUri }))
}
