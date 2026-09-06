import { NextResponse } from "next/server"
import { signup, DEFAULT_CAPABILITIES } from "@/lib/identity/service"
import { identityStore } from "@/lib/identity/store"
import { SESSION_COOKIE } from "@/lib/tenants"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// POST /api/auth/signup { email, password, orgName } -> { orgId, apiKey } (apiKey shown ONCE)
export async function GET() {
  return NextResponse.json({ error: "use POST" }, { status: 405 })
}
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string; orgName?: string }
  if (!body.email || !body.password || !body.orgName) return NextResponse.json({ error: "email, password, orgName required" }, { status: 400 })
  if (body.password.length < 8) return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 })
  try {
    const result = await signup({ email: body.email, password: body.password, orgName: body.orgName })
    // Log the new owner straight in with a session cookie — no API key needed for the dashboard.
    const { token, expiresAt } = await identityStore().createSession(result.orgId, result.userId, DEFAULT_CAPABILITIES)
    const res = NextResponse.json({ ok: true, orgId: result.orgId }, { status: 201 })
    res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", expires: expiresAt })
    return res
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: msg.includes("already registered") ? 409 : 500 })
  }
}
