import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { getSession } from "@/lib/tenants"
import { deliverRollup } from "@/lib/destinations"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// POST /api/v1/destinations/deliver { client, from?, to? } -> deliver the rollup to all destinations.
export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!session.capabilities.includes("write")) return NextResponse.json({ error: "forbidden" }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { client?: string; from?: string; to?: string }
  if (!body.client) return NextResponse.json({ error: "client required" }, { status: 400 })
  const to = body.to ?? new Date().toISOString().slice(0, 10)
  const from = body.from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
  const results = await deliverRollup(repos(session.orgId), body.client, { startDate: from, endDate: to })
  return NextResponse.json({ delivered: results }, { status: 200 })
}
