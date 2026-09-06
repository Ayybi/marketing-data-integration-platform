import { NextResponse } from "next/server"
import { randomBytes } from "node:crypto"
import { repos } from "@/lib/db"
import { getSession } from "@/lib/tenants"
import { isDestinationType } from "@/lib/destinations"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET -> list destinations; POST { type, config } -> register; DELETE ?destinationId= -> remove.
export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  return NextResponse.json({ data: await repos(session.orgId).destinations.list() }, { status: 200 })
}

export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!session.capabilities.includes("admin")) return NextResponse.json({ error: "forbidden" }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { type?: string; config?: Record<string, string> }
  if (!body.type || !isDestinationType(body.type)) return NextResponse.json({ error: "type must be webhook, sheets, or bigquery" }, { status: 400 })
  const destinationId = "dst_" + randomBytes(8).toString("base64url")
  await repos(session.orgId).destinations.upsert({ destinationId, type: body.type, config: body.config ?? {}, createdAt: new Date().toISOString() })
  return NextResponse.json({ destinationId, type: body.type }, { status: 201 })
}

export async function DELETE(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!session.capabilities.includes("admin")) return NextResponse.json({ error: "forbidden" }, { status: 403 })
  const destinationId = new URL(req.url).searchParams.get("destinationId")
  if (!destinationId) return NextResponse.json({ error: "destinationId required" }, { status: 400 })
  await repos(session.orgId).destinations.remove(destinationId)
  return NextResponse.json({ ok: true }, { status: 200 })
}
