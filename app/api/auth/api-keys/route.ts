import { NextResponse } from "next/server"
import { getSession } from "@/lib/tenants"
import { identityStore } from "@/lib/identity/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// All operations require an `admin` API key for the org.
async function requireAdmin(req: Request) {
  const session = await getSession(req)
  if (!session) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) }
  if (!session.capabilities.includes("admin")) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) }
  return { session }
}

// GET -> list keys (hashes omitted)
export async function GET(req: Request) {
  const { session, error } = await requireAdmin(req)
  if (error) return error
  return NextResponse.json({ data: await identityStore().listApiKeys(session.orgId) }, { status: 200 })
}

// POST { capabilities?, label? } -> create key (plaintext shown ONCE)
export async function POST(req: Request) {
  const { session, error } = await requireAdmin(req)
  if (error) return error
  const body = (await req.json().catch(() => ({}))) as { capabilities?: string[]; label?: string }
  const caps = Array.isArray(body.capabilities) && body.capabilities.length ? body.capabilities : ["read"]
  const { row, key } = await identityStore().createApiKey(session.orgId, caps, body.label)
  return NextResponse.json({ keyId: row.keyId, apiKey: key, capabilities: caps, note: "store this key now; it is not shown again" }, { status: 201 })
}

// DELETE ?keyId= -> revoke
export async function DELETE(req: Request) {
  const { session, error } = await requireAdmin(req)
  if (error) return error
  const keyId = new URL(req.url).searchParams.get("keyId")
  if (!keyId) return NextResponse.json({ error: "keyId required" }, { status: 400 })
  await identityStore().revokeApiKey(session.orgId, keyId)
  return NextResponse.json({ ok: true }, { status: 200 })
}
