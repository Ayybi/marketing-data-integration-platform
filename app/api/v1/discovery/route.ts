import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { getSession } from "@/lib/tenants"
import { listDiscovery } from "@/lib/discovery/mapping"
import { discoverGa4Properties, discoverGbpLocations } from "@/lib/discovery/sync"
import { buildGa4AdminGateway, GatewayNotConfigured } from "@/lib/gateways"
import { getAccessToken as gbpAccessToken, gbpOAuthCreds, resolveGbpRefreshToken } from "@/lib/gbp"
import { resolveServiceAccountJson } from "@/lib/tenant-creds"
import { defaultFetcher } from "@/lib/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET  /api/v1/discovery?source=ga4|gbp -> list discovered accounts
// POST /api/v1/discovery { source } -> run discovery sync (populates the discovery table)
export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const source = new URL(req.url).searchParams.get("source")
  if (source !== "ga4" && source !== "gbp") return NextResponse.json({ error: "source must be ga4 or gbp" }, { status: 400 })
  return NextResponse.json({ data: await listDiscovery(repos(session.orgId), source) }, { status: 200 })
}

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!session.capabilities.includes("admin")) return NextResponse.json({ error: "forbidden" }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { source?: string }
  const scoped = repos(session.orgId)

  try {
    if (body.source === "ga4") {
      const sa = await resolveServiceAccountJson(scoped) // BYO: this tenant's own GCP service account
      return NextResponse.json(await discoverGa4Properties(scoped, buildGa4AdminGateway(sa.status === "present" ? sa.value : undefined)), { status: 200 })
    }
    if (body.source === "gbp") {
      const refresh = await resolveGbpRefreshToken(scoped)
      if (refresh.status !== "present") return NextResponse.json({ error: `gbp refresh token ${refresh.status}` }, { status: 501 })
      const token = await gbpAccessToken(defaultFetcher, refresh.value, gbpOAuthCreds())
      return NextResponse.json(await discoverGbpLocations(scoped, token, defaultFetcher), { status: 200 })
    }
    return NextResponse.json({ error: "source must be ga4 or gbp" }, { status: 400 })
  } catch (e) {
    if (e instanceof GatewayNotConfigured) return NextResponse.json({ error: e.message, gateway: e.gateway }, { status: 501 })
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
