import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { listOrgIds } from "@/lib/tenants"
import { runGa4Cron } from "@/lib/hub-app/cron"
import { buildGa4Gateway } from "@/lib/gateways"
import { cronGuard, runCron, windowEndingToday } from "@/lib/hub-app/route-helpers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Schedule: */10 * * * * (doc §8). Incremental GA4 client snapshot sync.
export async function GET(req: Request) {
  const denied = cronGuard(req.headers.get("authorization"))
  if (denied) return NextResponse.json(denied.body, { status: denied.status })
  const bounds = windowEndingToday(2)
  const res = await runCron(async () => {
    const gateway = buildGa4Gateway() // GatewayNotConfigured -> 501
    return runGa4Cron({ orgIds: await listOrgIds(), makeRepos: repos }, { gateway, bounds })
  })
  return NextResponse.json(res.body, { status: res.status })
}
