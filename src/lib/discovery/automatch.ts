// NEW (§7): auto-match discovered external accounts to tenant clients by domain. Pure + highly testable.
import { normalizeDomain } from "../helpers"

export type Discovered = { externalId: string; websiteUri?: string }
export type ClientDomain = { clientId: string; domain?: string }
export type Suggestion = { clientId: string; externalId: string; domain: string }

/** Match discovered accounts (with a website_uri) to clients (with a domain), by normalized domain. */
export function matchByDomain(discovered: Discovered[], clients: ClientDomain[]): Suggestion[] {
  const byDomain = new Map<string, string>()
  for (const d of discovered) {
    if (!d.websiteUri) continue
    const dom = normalizeDomain(d.websiteUri)
    if (!byDomain.has(dom)) byDomain.set(dom, d.externalId) // first wins; ambiguity left unmatched
  }
  const out: Suggestion[] = []
  for (const c of clients) {
    if (!c.domain) continue
    const dom = normalizeDomain(c.domain)
    const ext = byDomain.get(dom)
    if (ext) out.push({ clientId: c.clientId, externalId: ext, domain: dom })
  }
  return out
}
