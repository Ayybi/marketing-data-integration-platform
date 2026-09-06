import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { listOrgIds } from "@/lib/tenants"
import { discoverGbpLocations } from "@/lib/discovery/sync"
import { getAccessToken as gbpAccessToken, gbpOAuthCreds, resolveGbpRefreshToken } from "@/lib/gbp"
import { defaultFetcher } from "@/lib/http"
import { cronGuard, runCron } from "@/lib/hub-app/route-helpers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Schedule: 0 4 * * * (doc §8). Discover GBP locations per tenant.
export async function GET(req: Request) {
  const denied = cronGuard(req.headers.get("authorization"))
  if (denied) return NextResponse.json(denied.body, { status: denied.status })
  const res = await runCron(async () => {
    const runs = []
    for (const orgId of await listOrgIds()) {
      const scoped = repos(orgId)
      const refresh = await resolveGbpRefreshToken(scoped)
      if (refresh.status !== "present") {
        runs.push({ orgId, result: { skipped: `gbp refresh token ${refresh.status}` } })
        continue
      }
      const token = await gbpAccessToken(defaultFetcher, refresh.value, gbpOAuthCreds())
      runs.push({ orgId, result: await discoverGbpLocations(scoped, token, defaultFetcher) })
    }
    return { tenants: runs.length, runs }
  })
  return NextResponse.json(res.body, { status: res.status })
}
