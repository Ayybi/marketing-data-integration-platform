import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { listOrgIds } from "@/lib/tenants"
import { refreshFbOverviewSnapshots } from "@/lib/meta"
import { defaultFetcher } from "@/lib/http"
import { cronGuard, runCron, windowEndingToday } from "@/lib/hub-app/route-helpers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Schedule: 0 5 * * * (doc §8). Warm the Meta token + refresh the prev_30d and all_time overview ranges.
export async function GET(req: Request) {
  const denied = cronGuard(req.headers.get("authorization"))
  if (denied) return NextResponse.json(denied.body, { status: denied.status })
  const nowMs = Date.now()
  const prev = windowEndingToday(60) // approx prev-30d window
  const res = await runCron(async () => {
    const runs = []
    for (const orgId of await listOrgIds()) {
      const scoped = repos(orgId)
      const prev30 = await refreshFbOverviewSnapshots(scoped, { fetcher: defaultFetcher, since: prev.startDate, until: prev.endDate, nowMs, dateRange: "prev_30d" })
      runs.push({ orgId, result: { prev_30d: prev30 } })
    }
    return { tenants: runs.length, runs }
  })
  return NextResponse.json(res.body, { status: res.status })
}
