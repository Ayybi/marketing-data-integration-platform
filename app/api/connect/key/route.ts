import { NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { getSession } from "@/lib/tenants"
import { saveKeyCredential } from "@/lib/connect/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const KEY_PROVIDERS = new Set(["callrail", "semrush", "stripe"])

// POST /api/connect/key { provider, apiKey, scope?, clientId? } -> encrypts into the vault.
export async function POST(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (!session.capabilities.includes("admin")) return NextResponse.json({ error: "forbidden" }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as { provider?: string; apiKey?: string; scope?: "agency" | "client"; clientId?: string }
  if (!body.provider || !KEY_PROVIDERS.has(body.provider)) return NextResponse.json({ error: `provider must be one of ${[...KEY_PROVIDERS].join(", ")}` }, { status: 400 })
  if (!body.apiKey) return NextResponse.json({ error: "apiKey required" }, { status: 400 })
  const scope = body.scope ?? "agency"
  if (scope === "client" && !body.clientId) return NextResponse.json({ error: "clientId required for client scope" }, { status: 400 })

  await saveKeyCredential(repos(session.orgId), { provider: body.provider, apiKey: body.apiKey, scope, clientId: body.clientId })
  return NextResponse.json({ ok: true, provider: body.provider, scope }, { status: 200 })
}
