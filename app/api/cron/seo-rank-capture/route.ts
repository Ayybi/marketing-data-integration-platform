import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { listOrgIds } from "@/lib/tenants"
import { getSeoProvider, SeoProviderNotConfigured, SeoQuotaError } from "@/lib/seo"
import { cronGuard, runCron } from "@/lib/hub-app/route-helpers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

// Schedule: 0 5 * * * (doc §8). Keyword rank capture: fetch organic keywords for each configured site.
export async function GET(req: Request) {
  const denied = cronGuard(req.headers.get("authorization"))
  if (denied) return NextResponse.json(denied.body, { status: denied.status })
  const res = await runCron(async () => {
    let provider
    try {
      provider = getSeoProvider()
    } catch (e) {
      if (e instanceof SeoProviderNotConfigured) return { skipped: e.message }
      throw e
    }
    const runs = []
    for (const orgId of await listOrgIds()) {
      const sites = await repos(orgId).semrush.listSiteConfigs()
      let captured = 0
      let depleted = false
      for (const s of sites) {
        try {
          const r = await provider.organicKeywords(s.domain, { database: s.database, throwOnQuota: true })
          if (r.status === "present") captured += r.value.length
        } catch (e) {
          if (e instanceof SeoQuotaError) {
            depleted = true
            break
          }
          throw e
        }
      }
      runs.push({ orgId, result: { sites: sites.length, keywordsCaptured: captured, depleted } })
    }
    return { tenants: runs.length, runs }
  })
  return NextResponse.json(res.body, { status: res.status })
}
