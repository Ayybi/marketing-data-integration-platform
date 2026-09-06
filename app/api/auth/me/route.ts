import { NextResponse } from "next/server"
import { getSession } from "@/lib/tenants"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET /api/auth/me — lightweight auth check for the UI (no secrets).
export async function GET(req: Request) {
  const s = await getSession(req)
  return NextResponse.json({ authenticated: Boolean(s), orgId: s?.orgId ?? null, capabilities: s?.capabilities ?? [] }, { status: 200 })
}
