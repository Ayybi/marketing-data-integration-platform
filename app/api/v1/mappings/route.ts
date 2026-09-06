import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { getSession } from "@/lib/tenants"
import { createMapping, type MappingSource } from "@/lib/discovery/mapping"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const SOURCES = new Set(["ga4", "gbp", "gsc", "callrail", "lsa", "meta", "semrush"])

// POST /api/v1/mappings { source, clientId, externalId, accountId?, monthlyBudget? } -> create a mapping.
export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!session.capabilities.includes("admin")) return NextResponse.json({ error: "forbidden" }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as { source?: string; clientId?: string; externalId?: string; accountId?: string; monthlyBudget?: number }
  if (!body.source || !SOURCES.has(body.source)) return NextResponse.json({ error: `source must be one of ${[...SOURCES].join(", ")}` }, { status: 400 })
  if (!body.clientId || !body.externalId) return NextResponse.json({ error: "clientId and externalId required" }, { status: 400 })

  try {
    await createMapping(repos(session.orgId), {
      source: body.source as MappingSource,
      clientId: body.clientId,
      externalId: body.externalId,
      accountId: body.accountId,
      monthlyBudget: body.monthlyBudget,
    })
    return NextResponse.json({ ok: true, source: body.source, clientId: body.clientId }, { status: 200 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
  }
}
