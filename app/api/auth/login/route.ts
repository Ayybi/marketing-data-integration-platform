import { NextResponse } from "next/server"
import { login, DEFAULT_CAPABILITIES } from "@/lib/identity/service"
import { identityStore } from "@/lib/identity/store"
import { SESSION_COOKIE } from "@/lib/tenants"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// POST /api/auth/login { email, password } -> verifies the password and sets an httpOnly session cookie.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string }
  if (!body.email || !body.password) return NextResponse.json({ error: "email and password required" }, { status: 400 })

  const who = await login({ email: body.email, password: body.password })
  if (!who) return NextResponse.json({ error: "invalid email or password" }, { status: 401 })

  // Owner sessions get full capabilities. The cookie carries only an opaque token; the session lives server-side.
  const { token, expiresAt } = await identityStore().createSession(who.orgId, who.userId, DEFAULT_CAPABILITIES)
  const res = NextResponse.json({ ok: true, orgId: who.orgId }, { status: 200 })
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  })
  return res
}
