import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { listOrgIds } from "@/lib/tenants"
import { syncSemrushProjects } from "@/lib/semrush"
import { buildSemrushProjectSource } from "@/lib/gateways"
import { cronGuard, runCron } from "@/lib/hub-app/route-helpers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Schedule: 0 4 * * * (doc §8). Sync the SEMrush project list (pruned on delete). Needs a live project
// source (SEMrush CSV) — returns 501 until wired (see WIRING.md).
export async function GET(req: Request) {
  const denied = cronGuard(req.headers.get("authorization"))
  if (denied) return NextResponse.json(denied.body, { status: denied.status })
  const res = await runCron(async () => {
    const source = buildSemrushProjectSource() // throws GatewayNotConfigured -> 501
    const orgIds = await listOrgIds()
    const runs = []
    for (const orgId of orgIds) {
      const projects = await source()
      runs.push({ orgId, result: await syncSemrushProjects(repos(orgId), projects) })
    }
    return { tenants: orgIds.length, runs }
  })
  return NextResponse.json(res.body, { status: res.status })
}
