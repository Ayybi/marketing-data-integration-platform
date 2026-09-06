// NEW (§7): discovery syncs. GA4 property discovery is behind an injectable Ga4AdminGateway; GBP location
// discovery uses the built-in Fetcher over the Business Profile REST APIs. Both populate the discovery
// collections (with website_uri) so tenants can auto-match by domain.
import type { Repos } from "../db/types"
import type { Fetcher } from "../http"

// ---- GA4 property discovery ----

export type DiscoveredGa4Property = { propertyId: string; displayName?: string; accountId?: string; websiteUri?: string }
export interface Ga4AdminGateway {
  listProperties(): Promise<DiscoveredGa4Property[]>
}

export async function discoverGa4Properties(repos: Repos, gateway: Ga4AdminGateway): Promise<{ discovered: number }> {
  const props = await gateway.listProperties() // throws on failure -> caller surfaces
  for (const p of props) {
    await repos.ga4.upsertProperty({ propertyId: p.propertyId, displayName: p.displayName, accountId: p.accountId, websiteUri: p.websiteUri })
  }
  return { discovered: props.length }
}

// ---- GBP location discovery (REST via Fetcher) ----

type GbpAccount = { name?: string }
type GbpLocation = { name?: string; title?: string; websiteUri?: string; storefrontAddress?: { addressLines?: string[]; locality?: string; administrativeArea?: string } }

function locationId(name: string | undefined): string {
  // "locations/12345" or "accounts/1/locations/12345" -> keep the full resource path tail.
  return name ?? ""
}
function formatAddress(a: GbpLocation["storefrontAddress"]): string | undefined {
  if (!a) return undefined
  return [...(a.addressLines ?? []), a.locality, a.administrativeArea].filter(Boolean).join(", ") || undefined
}

/** Discover GBP locations across the token's accounts. Throws on any read failure (never a silent []). */
export async function discoverGbpLocations(repos: Repos, token: string, fetcher: Fetcher): Promise<{ discovered: number }> {
  const accRes = await fetcher("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", { headers: { Authorization: `Bearer ${token}` }, timeoutMs: 20000 })
  if (!accRes.ok) throw new Error(`GBP accounts -> ${accRes.status}`)
  const accounts = ((await accRes.json()) as { accounts?: GbpAccount[] }).accounts ?? []

  let discovered = 0
  for (const acc of accounts) {
    if (!acc.name) continue
    const readMask = "name,title,websiteUri,storefrontAddress"
    const locRes = await fetcher(`https://mybusinessbusinessinformation.googleapis.com/v1/${acc.name}/locations?readMask=${encodeURIComponent(readMask)}&pageSize=100`, {
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 20000,
    })
    if (!locRes.ok) throw new Error(`GBP locations for ${acc.name} -> ${locRes.status}`)
    const locations = ((await locRes.json()) as { locations?: GbpLocation[] }).locations ?? []
    for (const l of locations) {
      await repos.gbp.upsertLocation({ locationId: locationId(l.name), accountId: acc.name, title: l.title, websiteUri: l.websiteUri, address: formatAddress(l.storefrontAddress) })
      discovered += 1
    }
  }
  return { discovered }
}
