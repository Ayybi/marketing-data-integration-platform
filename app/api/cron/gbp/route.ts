import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { listOrgIds } from "@/lib/tenants"
import { runGbpCron } from "@/lib/hub-app/cron"
import { cronGuard, runCron, windowEndingToday } from "@/lib/hub-app/route-helpers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Schedule: 0 5 * * * (doc §8). GBP metrics + reviews. Built-in fetcher; the refresh token is resolved
// and the access token minted per-tenant inside syncAllGbp.
export async function GET(req: Request) {
  const denied = cronGuard(req.headers.get("authorization"))
  if (denied) return NextResponse.json(denied.body, { status: denied.status })
  const bounds = windowEndingToday(7) // 7-day rolling window (§4.3)
  const res = await runCron(async () => runGbpCron({ orgIds: await listOrgIds(), makeRepos: repos }, { bounds }))
  return NextResponse.json(res.body, { status: res.status })
}
