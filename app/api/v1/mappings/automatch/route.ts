import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { getSession } from "@/lib/tenants"
import { matchByDomain } from "@/lib/discovery/automatch"
import { listDiscovery, createMapping } from "@/lib/discovery/mapping"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// POST /api/v1/mappings/automatch { source: ga4|gbp, apply?: boolean }
// Suggests mappings by matching discovered website_uri to client domains; applies them when apply=true.
export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!session.capabilities.includes("admin")) return NextResponse.json({ error: "forbidden" }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as { source?: "ga4" | "gbp"; apply?: boolean }
  if (body.source !== "ga4" && body.source !== "gbp") return NextResponse.json({ error: "source must be ga4 or gbp" }, { status: 400 })
  const scoped = repos(session.orgId)

  const discovered = (await listDiscovery(scoped, body.source)).map((d) => ({ externalId: d.externalId, websiteUri: d.websiteUri }))
  const clientRows = await scoped.clients.activeClientIds()
  const clients = await Promise.all(clientRows.map(async (id) => (await scoped.clients.get(id)).status === "present" ? (await scoped.clients.get(id)) : null))
  const clientDomains = clients.flatMap((r) => (r && r.status === "present" ? [{ clientId: r.value.clientId, domain: r.value.domain }] : []))

  const suggestions = matchByDomain(discovered, clientDomains)
  if (body.apply) {
    for (const s of suggestions) await createMapping(scoped, { source: body.source, clientId: s.clientId, externalId: s.externalId })
  }
  return NextResponse.json({ suggestions, applied: Boolean(body.apply) }, { status: 200 })
}
