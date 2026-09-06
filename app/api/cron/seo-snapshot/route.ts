import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { listOrgIds } from "@/lib/tenants"
import { syncSemrushProjects } from "@/lib/semrush"
import { buildSemrushProjectSource } from "@/lib/gateways"
import { cronGuard, runCron } from "@/lib/hub-app/route-helpers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Schedule: 15 4 * * * (doc §8). SEO metric snapshot: refresh the project list per tenant.
export async function GET(req: Request) {
  const denied = cronGuard(req.headers.get("authorization"))
  if (denied) return NextResponse.json(denied.body, { status: denied.status })
  const res = await runCron(async () => {
    const source = buildSemrushProjectSource() // GatewayNotConfigured -> 501
    const runs = []
    for (const orgId of await listOrgIds()) runs.push({ orgId, result: await syncSemrushProjects(repos(orgId), await source()) })
    return { tenants: runs.length, runs }
  })
  return NextResponse.json(res.body, { status: res.status })
}
