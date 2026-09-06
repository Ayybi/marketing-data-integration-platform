import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { listOrgIds } from "@/lib/tenants"
import { discoverGa4Properties } from "@/lib/discovery/sync"
import { buildGa4AdminGateway, GatewayNotConfigured } from "@/lib/gateways"
import { resolveServiceAccountJson } from "@/lib/tenant-creds"
import { cronGuard, runCron } from "@/lib/hub-app/route-helpers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Schedule: 0 4 * * * (doc §8). Discover GA4 properties per tenant, using each tenant's OWN GCP service
// account (BYO, vault -> env).
export async function GET(req: Request) {
  const denied = cronGuard(req.headers.get("authorization"))
  if (denied) return NextResponse.json(denied.body, { status: denied.status })
  const res = await runCron(async () => {
    const runs = []
    for (const orgId of await listOrgIds()) {
      const scoped = repos(orgId)
      try {
        const sa = await resolveServiceAccountJson(scoped)
        const gateway = buildGa4AdminGateway(sa.status === "present" ? sa.value : undefined)
        runs.push({ orgId, result: await discoverGa4Properties(scoped, gateway) })
      } catch (e) {
        runs.push({ orgId, result: { skipped: e instanceof GatewayNotConfigured ? e.message : e instanceof Error ? e.message : String(e) } })
      }
    }
    return { tenants: runs.length, runs }
  })
  return NextResponse.json(res.body, { status: res.status })
}
