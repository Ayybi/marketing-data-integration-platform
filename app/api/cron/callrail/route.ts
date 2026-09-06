import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { listOrgIds } from "@/lib/tenants"
import { runCallRailCron } from "@/lib/hub-app/cron"
import { cronGuard, runCron } from "@/lib/hub-app/route-helpers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Schedule: */30 * * * * (doc §8). Snapshot calls per company. Uses the built-in fetcher; the API key
// is resolved per-tenant from env/vault inside syncCallRail.
export async function GET(req: Request) {
  const denied = cronGuard(req.headers.get("authorization"))
  if (denied) return NextResponse.json(denied.body, { status: denied.status })
  const res = await runCron(async () => runCallRailCron({ orgIds: await listOrgIds(), makeRepos: repos }))
  return NextResponse.json(res.body, { status: res.status })
}
