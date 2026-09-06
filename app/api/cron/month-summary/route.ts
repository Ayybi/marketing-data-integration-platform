import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { listOrgIds } from "@/lib/tenants"
import { persistAllRollups } from "@/lib/rollup/build"
import { cronGuard, runCron, windowEndingToday } from "@/lib/hub-app/route-helpers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Schedule: 0 2 1 * * (doc §8). Monthly rollup: build + persist the cross-source rollup for every client.
export async function GET(req: Request) {
  const denied = cronGuard(req.headers.get("authorization"))
  if (denied) return NextResponse.json(denied.body, { status: denied.status })
  const bounds = windowEndingToday(31)
  const res = await runCron(async () => {
    const runs = []
    for (const orgId of await listOrgIds()) runs.push({ orgId, result: await persistAllRollups(repos(orgId), bounds) })
    return { tenants: runs.length, runs }
  })
  return NextResponse.json(res.body, { status: res.status })
}
