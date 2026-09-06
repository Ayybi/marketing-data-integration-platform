import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { getSession } from "@/lib/tenants"
import { readToResponse } from "@/lib/hub-app/handlers"
import { getAdsProvider, listAdPlatforms, isAdPlatform, combineAdInsights, AdsProviderNotConfigured, type AdInsights } from "@/lib/ads"
import { enforceMonthlyQuota } from "@/lib/quota/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET /api/v1/ads/insights?account=&from=&to=[&platform=meta|google_ads]
// With `platform`: that platform's normalized insights. Without: a rollup across ALL platforms (the
// unified cross-source wedge) — each platform's account id comes from account_<platform> params.
export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!session.capabilities.includes("read")) return NextResponse.json({ error: "forbidden" }, { status: 403 })

  const quota = await enforceMonthlyQuota(session.orgId, "ads_reads")
  if (!quota.allowed) return NextResponse.json({ error: "quota_exceeded", meter: "ads_reads", used: quota.used, limit: quota.limit }, { status: 429 })

  const url = new URL(req.url)
  const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10)
  const from = url.searchParams.get("from") ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
  const bounds = { startDate: from, endDate: to }
  const scoped = repos(session.orgId)

  const platform = url.searchParams.get("platform")

  // Single platform.
  if (platform) {
    if (!isAdPlatform(platform)) return NextResponse.json({ error: `unknown platform: ${platform}`, platforms: listAdPlatforms() }, { status: 400 })
    const account = url.searchParams.get("account")
    if (!account) return NextResponse.json({ error: "account is required" }, { status: 400 })
    let provider
    try {
      provider = await getAdsProvider(platform, scoped)
    } catch (e) {
      if (e instanceof AdsProviderNotConfigured) return NextResponse.json({ error: e.message, platform: e.platform }, { status: 501 })
      throw e
    }
    const { status, body } = readToResponse(await provider.accountInsights(account, bounds))
    return NextResponse.json(body, { status })
  }

  // Rollup across all platforms. Per-platform account id from account_<platform>; skip absent/errored.
  const collected: AdInsights[] = []
  const errors: Record<string, string> = {}
  for (const p of listAdPlatforms()) {
    const account = url.searchParams.get(`account_${p}`)
    if (!account) continue
    try {
      const provider = await getAdsProvider(p, scoped)
      const r = await provider.accountInsights(account, bounds)
      if (r.status === "present") collected.push(r.value)
      else if (r.status === "error") errors[p] = r.error
    } catch (e) {
      errors[p] = e instanceof AdsProviderNotConfigured ? "not_configured" : e instanceof Error ? e.message : String(e)
    }
  }
  return NextResponse.json({ data: combineAdInsights(collected), errors }, { status: 200 })
}
