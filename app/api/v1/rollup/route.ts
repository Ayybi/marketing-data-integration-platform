import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { getSession } from "@/lib/tenants"
import { buildRollupForClient } from "@/lib/rollup/build"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET /api/v1/rollup?client=&from=&to= — unified cross-source per-day rows for a client.
export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!session.capabilities.includes("read")) return NextResponse.json({ error: "forbidden" }, { status: 403 })

  const url = new URL(req.url)
  const client = url.searchParams.get("client")
  if (!client) return NextResponse.json({ error: "client is required" }, { status: 400 })
  const to = url.searchParams.get("to") ?? new Date().toISOString().slice(0, 10)
  const from = url.searchParams.get("from") ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)

  const rows = await buildRollupForClient(repos(session.orgId), client, { startDate: from, endDate: to })
  return NextResponse.json({ data: rows }, { status: 200 })
}
