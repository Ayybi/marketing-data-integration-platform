import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { getSession } from "@/lib/tenants"
import { buildAuthorizeUrl, isOAuthService, ConnectNotConfigured } from "@/lib/connect/oauth"
import { createOAuthState, oauthCallbackUri } from "@/lib/connect/service"
import { resolveOAuthApp } from "@/lib/tenant-creds"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// POST /api/connect/oauth/start { service: google_ads|google_business|meta } -> { authorizeUrl }
export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!session.capabilities.includes("admin")) return NextResponse.json({ error: "forbidden" }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as { service?: string }
  if (!body.service || !isOAuthService(body.service)) return NextResponse.json({ error: "service must be google_ads, google_business, or meta" }, { status: 400 })

  // BYO: resolve this tenant's own OAuth app (vault -> env).
  const app = await resolveOAuthApp(repos(session.orgId), body.service)
  if (app.status === "error") return NextResponse.json({ error: app.error }, { status: 502 })
  if (app.status === "absent") return NextResponse.json({ error: `no OAuth app configured for ${body.service}` }, { status: 501 })

  try {
    const state = await createOAuthState(session.orgId, body.service)
    const authorizeUrl = buildAuthorizeUrl(body.service, state, oauthCallbackUri(), app.value)
    return NextResponse.json({ authorizeUrl }, { status: 200 })
  } catch (e) {
    if (e instanceof ConnectNotConfigured) return NextResponse.json({ error: e.message, service: e.service }, { status: 501 })
    throw e
  }
}
