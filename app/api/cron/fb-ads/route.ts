import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { listOrgIds } from "@/lib/tenants"
import { runMetaCron } from "@/lib/hub-app/cron"
import { cronGuard, runCron, windowEndingToday } from "@/lib/hub-app/route-helpers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Schedule: 0 * * * * (doc §8, hourly). Meta overview refresh. Built-in fetcher; the token is resolved
// per-tenant inside refreshFbOverviewSnapshots (5-min cache, oauth->env fallback).
export async function GET(req: Request) {
  const denied = cronGuard(req.headers.get("authorization"))
  if (denied) return NextResponse.json(denied.body, { status: denied.status })
  const { startDate: since, endDate: until } = windowEndingToday(30)
  const res = await runCron(async () => runMetaCron({ orgIds: await listOrgIds(), makeRepos: repos }, { since, until, nowMs: Date.now() }))
  return NextResponse.json(res.body, { status: res.status })
}
