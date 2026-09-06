import { NextResponse } from "next/server"
import { getSession } from "@/lib/tenants"
import { readToResponse } from "@/lib/hub-app/handlers"
import { getSeoProvider, SeoProviderNotConfigured, SeoQuotaError, type SeoReadOpts } from "@/lib/seo"
import { enforceMonthlyQuota } from "@/lib/quota/guard"
import type { ReadResult } from "@/lib/result"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET /api/v1/seo/metrics?domain=&type=overview|backlinks|keywords&database=&limit=
// Vendor-agnostic: whichever provider SEO_PROVIDER selects, the caller gets the same normalized output.
export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!session.capabilities.includes("read")) return NextResponse.json({ error: "forbidden" }, { status: 403 })

  const quota = await enforceMonthlyQuota(session.orgId, "seo_reads")
  if (!quota.allowed) return NextResponse.json({ error: "quota_exceeded", meter: "seo_reads", used: quota.used, limit: quota.limit }, { status: 429 })

  const url = new URL(req.url)
  const domain = url.searchParams.get("domain")
  const type = (url.searchParams.get("type") ?? "overview") as "overview" | "backlinks" | "keywords"
  if (!domain) return NextResponse.json({ error: "domain is required" }, { status: 400 })

  const opts: SeoReadOpts = {}
  const database = url.searchParams.get("database")
  if (database) opts.database = database
  const limit = url.searchParams.get("limit")
  if (limit) opts.limit = Number(limit)

  let provider
  try {
    provider = getSeoProvider()
  } catch (e) {
    if (e instanceof SeoProviderNotConfigured) return NextResponse.json({ error: e.message, provider: e.provider }, { status: 501 })
    throw e
  }

  try {
    const result: ReadResult<unknown> =
      type === "backlinks"
        ? await provider.backlinks(domain, opts)
        : type === "keywords"
          ? await provider.organicKeywords(domain, opts)
          : await provider.domainOverview(domain, opts)
    const { status, body } = readToResponse(result)
    return NextResponse.json({ provider: provider.name, ...(body as object) }, { status })
  } catch (e) {
    if (e instanceof SeoQuotaError) return NextResponse.json({ error: "quota_depleted", provider: e.provider }, { status: 429 })
    throw e
  }
}
