import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { listOrgIds } from "@/lib/tenants"
import { runStripeCron } from "@/lib/hub-app/cron"
import { buildStripeGateway } from "@/lib/gateways"
import { cronGuard, runCron } from "@/lib/hub-app/route-helpers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Schedule: 0 7 * * * (doc §8). Full Stripe sync. Needs a live StripeGateway (stripe SDK) — returns 501
// until wired (see WIRING.md). A per-tenant BUG-145 abort is swallowed by the runner (logged partial).
export async function GET(req: Request) {
  const denied = cronGuard(req.headers.get("authorization"))
  if (denied) return NextResponse.json(denied.body, { status: denied.status })
  const res = await runCron(async () => {
    const gateway = buildStripeGateway()
    return runStripeCron({ orgIds: await listOrgIds(), makeRepos: repos }, { gateway })
  })
  return NextResponse.json(res.body, { status: res.status })
}
