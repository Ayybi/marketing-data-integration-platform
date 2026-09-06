import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { getSession } from "@/lib/tenants"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET /api/connect/status — which providers have a stored credential for this workspace (no secrets).
export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  return NextResponse.json({ configured: await repos(session.orgId).credentials.listProviders() }, { status: 200 })
}
