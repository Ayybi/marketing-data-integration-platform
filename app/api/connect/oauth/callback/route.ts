import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { defaultFetcher } from "@/lib/http"
import { exchangeCode } from "@/lib/connect/oauth"
import { consumeOAuthState, oauthCallbackUri, saveOAuthCredential } from "@/lib/connect/service"
import { resolveOAuthApp } from "@/lib/tenant-creds"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET /api/connect/oauth/callback?code=&state= — provider redirect target. Exchanges the code, stores the
// token encrypted, and returns a simple confirmation.
export async function GET(req: Request) {
  const url = new URL(req.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")
  if (error) return NextResponse.json({ error: `provider denied: ${error}` }, { status: 400 })
  if (!code || !state) return NextResponse.json({ error: "code and state required" }, { status: 400 })

  const resolved = await consumeOAuthState(state)
  if (!resolved) return NextResponse.json({ error: "invalid or expired state" }, { status: 400 })

  const scoped = repos(resolved.orgId)
  const app = await resolveOAuthApp(scoped, resolved.service)
  if (app.status !== "present") return NextResponse.json({ error: `no OAuth app configured for ${resolved.service}` }, { status: 501 })

  try {
    const exchanged = await exchangeCode(resolved.service, code, oauthCallbackUri(), defaultFetcher, app.value)
    await saveOAuthCredential(scoped, exchanged.credentialProvider, exchanged.token, exchanged.expiresAt)
    return NextResponse.json({ ok: true, service: resolved.service, provider: exchanged.credentialProvider, note: "connected" }, { status: 200 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}
