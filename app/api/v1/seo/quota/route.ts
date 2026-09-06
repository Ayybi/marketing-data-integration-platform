import { NextResponse } from "next/server"
import { getSession } from "@/lib/tenants"
import { getSeoProvider, SeoProviderNotConfigured } from "@/lib/seo"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET /api/v1/seo/quota — the configured provider's metering (ok/unlimited/unconfigured/unreadable).
export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!session.capabilities.includes("read")) return NextResponse.json({ error: "forbidden" }, { status: 403 })

  let provider
  try {
    provider = getSeoProvider()
  } catch (e) {
    if (e instanceof SeoProviderNotConfigured) return NextResponse.json({ error: e.message, provider: e.provider }, { status: 501 })
    throw e
  }
  return NextResponse.json({ provider: provider.name, quota: await provider.quota() }, { status: 200 })
}
