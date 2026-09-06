import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { listOrgIds } from "@/lib/tenants"
import { cronGuard, runCron } from "@/lib/hub-app/route-helpers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Schedule: 0 6 1 * * (doc §8). Monthly LSA account verification: summarize account mappings by status.
export async function GET(req: Request) {
  const denied = cronGuard(req.headers.get("authorization"))
  if (denied) return NextResponse.json(denied.body, { status: denied.status })
  const res = await runCron(async () => {
    const runs = []
    for (const orgId of await listOrgIds()) {
      const mappings = await repos(orgId).lsa.activeMappings()
      const byStatus: Record<string, number> = {}
      for (const m of mappings) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1
      runs.push({ orgId, result: { accounts: mappings.length, byStatus } })
    }
    return { tenants: runs.length, runs }
  })
  return NextResponse.json(res.body, { status: res.status })
}
