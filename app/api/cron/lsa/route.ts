import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { listOrgIds } from "@/lib/tenants"
import { runLsaCron } from "@/lib/hub-app/cron"
import { buildLsaGateway } from "@/lib/gateways"
import { cronGuard, runCron, windowEndingToday } from "@/lib/hub-app/route-helpers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Schedule: 0 6 * * * (doc §8). LSA lead + spend snapshots. Needs a live LsaGateway (google-ads-api) —
// returns 501 until wired (see WIRING.md).
export async function GET(req: Request) {
  const denied = cronGuard(req.headers.get("authorization"))
  if (denied) return NextResponse.json(denied.body, { status: denied.status })
  const bounds = windowEndingToday(30)
  const res = await runCron(async () => {
    const gateway = buildLsaGateway()
    return runLsaCron({ orgIds: await listOrgIds(), makeRepos: repos }, { gateway, bounds })
  })
  return NextResponse.json(res.body, { status: res.status })
}
