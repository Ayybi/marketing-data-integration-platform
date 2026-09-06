import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { getSession } from "@/lib/tenants"
import { handleMetricsRead } from "@/lib/hub-app/handlers"

export const runtime = "nodejs" // mongodb + node:crypto — never Edge
export const dynamic = "force-dynamic"

export async function GET(req: Request, { params }: { params: Promise<{ source: string }> }) {
  const { source } = await params
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const url = new URL(req.url)
  const ctx = { session, repos: repos(session.orgId) } // tenant isolation (RLS replacement)
  const { status, body } = await handleMetricsRead(ctx, {
    source,
    clientId: url.searchParams.get("client") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  })
  return NextResponse.json(body, { status })
}
