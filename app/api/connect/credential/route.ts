import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { getSession } from "@/lib/tenants"
import { saveTenantCredential } from "@/lib/connect/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Per-tenant "bring your own" credentials, encrypted into the workspace vault.
//  - connector keys:      { provider: "callrail"|"semrush"|"stripe"|"meta_token", value: "<key>" }
//  - OAuth apps:          { provider: "oauth_app_google_ads"|"oauth_app_google_business"|"oauth_app_meta", value: { client_id, client_secret } }
//  - GCP service account: { provider: "ga4_service_account", value: { ...serviceAccountJson } }
//  - LLM:                 { provider: "llm", value: { apiKey, provider?, model? } }
const ALLOWED = new Set([
  "callrail", "semrush", "stripe", "meta_token",
  "oauth_app_google_ads", "oauth_app_google_business", "oauth_app_meta",
  "ga4_service_account", "llm",
])

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!session.capabilities.includes("admin")) return NextResponse.json({ error: "forbidden" }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as { provider?: string; value?: string | Record<string, unknown> }
  if (!body.provider || !ALLOWED.has(body.provider)) return NextResponse.json({ error: `provider must be one of ${[...ALLOWED].join(", ")}` }, { status: 400 })
  if (body.value === undefined || body.value === null || body.value === "") return NextResponse.json({ error: "value required" }, { status: 400 })

  await saveTenantCredential(repos(session.orgId), body.provider, body.value)
  return NextResponse.json({ ok: true, provider: body.provider }, { status: 200 })
}
