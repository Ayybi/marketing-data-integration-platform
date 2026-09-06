import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { listOrgIds } from "@/lib/tenants"
import { classifyUnclassifiedQualifiedCalls } from "@/lib/callrail-classify"
import { getLLMForOrg } from "@/lib/llm"
import { cronGuard, runCron } from "@/lib/hub-app/route-helpers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Schedule: 0 8 * * * (doc §8). Deep pull: AI-classify unclassified qualified calls per tenant, using
// each tenant's OWN LLM key (BYO, vault -> env).
export async function GET(req: Request) {
  const denied = cronGuard(req.headers.get("authorization"))
  if (denied) return NextResponse.json(denied.body, { status: denied.status })
  const res = await runCron(async () => {
    const runs = []
    for (const orgId of await listOrgIds()) {
      const scoped = repos(orgId)
      try {
        const llm = await getLLMForOrg(scoped)
        runs.push({ orgId, result: await classifyUnclassifiedQualifiedCalls(scoped, llm, 15) })
      } catch (e) {
        runs.push({ orgId, result: { skipped: e instanceof Error ? e.message : String(e) } })
      }
    }
    return { tenants: runs.length, runs }
  })
  return NextResponse.json(res.body, { status: res.status })
}
