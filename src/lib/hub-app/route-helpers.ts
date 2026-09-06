// NEW: thin helpers shared by the cron route handlers (framework-agnostic; no `next` import).
import { verifyCronSecret } from "../auth/cron"
import { GatewayNotConfigured } from "../gateways"

/** Returns null when the cron secret is valid, or a 403 payload to return otherwise. */
export function cronGuard(authHeader: string | null | undefined): { status: number; body: unknown } | null {
  if (!verifyCronSecret(authHeader)) return { status: 403, body: { error: "forbidden" } }
  return null
}

/** A window ending today, `days` back (YYYY-MM-DD). */
export function windowEndingToday(days: number): { startDate: string; endDate: string } {
  const end = new Date()
  const start = new Date(Date.now() - days * 86400_000)
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) }
}

/** Run a cron body, translating the live-wiring seam into a clean 501 instead of a 500. */
export async function runCron(body: () => Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    return { status: 200, body: await body() }
  } catch (e) {
    if (e instanceof GatewayNotConfigured) {
      return { status: 501, body: { error: e.message, gateway: e.gateway } }
    }
    return { status: 500, body: { error: e instanceof Error ? e.message : String(e) } }
  }
}
