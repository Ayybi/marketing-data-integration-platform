import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { getSession } from "@/lib/tenants"
import { handleSyncLog } from "@/lib/hub-app/handlers"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const url = new URL(req.url)
  const source = url.searchParams.get("source") ?? ""
  if (!source) return NextResponse.json({ error: "source is required" }, { status: 400 })
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 100)

  const ctx = { session, repos: repos(session.orgId) }
  const { status, body } = await handleSyncLog(ctx, source, limit)
  return NextResponse.json(body, { status })
}
