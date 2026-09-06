import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { getSession } from "@/lib/tenants"
import { readToResponse } from "@/lib/hub-app/handlers"
import { getGscAnalytics } from "@/lib/gsc"
import { buildGscGateway, GatewayNotConfigured } from "@/lib/gateways"
import { resolveServiceAccountJson } from "@/lib/tenant-creds"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GSC is read LIVE (§4.4, no snapshot table) so it has its own endpoint that constructs a credentialed
// gateway. Three-state -> HTTP (200/404/502); a missing service account -> 501 via GatewayNotConfigured.
export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!session.capabilities.includes("read")) return NextResponse.json({ error: "forbidden" }, { status: 403 })

  const url = new URL(req.url)
  const clientId = url.searchParams.get("client") ?? ""
  const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10)
  const from = url.searchParams.get("from") ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)

  const scoped = repos(session.orgId)
  const sa = await resolveServiceAccountJson(scoped) // BYO: this tenant's own GCP service account
  let gateway
  try {
    gateway = buildGscGateway(sa.status === "present" ? sa.value : undefined)
  } catch (e) {
    if (e instanceof GatewayNotConfigured) return NextResponse.json({ error: e.message, gateway: e.gateway }, { status: 501 })
    throw e
  }
  const { status, body } = readToResponse(await getGscAnalytics(scoped, clientId, gateway, { startDate: from, endDate: to }))
  return NextResponse.json(body, { status })
}
