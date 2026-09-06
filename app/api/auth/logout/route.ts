import { NextResponse } from "next/server"
import { identityStore } from "@/lib/identity/store"
import { SESSION_COOKIE } from "@/lib/tenants"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// POST /api/auth/logout -> destroys the server session and clears the cookie.
export async function POST(req: Request) {
  const cookie = req.headers.get("cookie") ?? ""
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))
  if (m) {
    try {
      await identityStore().destroySession(decodeURIComponent(m[1]))
    } catch {
      /* best-effort */
    }
  }
  const res = NextResponse.json({ ok: true }, { status: 200 })
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", expires: new Date(0) })
  return res
}
