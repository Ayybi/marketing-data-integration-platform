import { NextResponse } from "next/server"
import { getSession } from "@/lib/tenants"
import { usageMeter, monthWindow } from "@/lib/quota/meter"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// GET /api/v1/usage — this tenant's metered usage for the current month.
export async function GET(req: Request) {
  const session = await getSession(req)
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const window = monthWindow()
  return NextResponse.json({ window, usage: await usageMeter().usageForOrg(session.orgId, window) }, { status: 200 })
}
