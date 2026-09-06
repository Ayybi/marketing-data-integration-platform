// Webhook DESTINATION adapter — POSTs the payload as JSON, optionally HMAC-signed so the receiver can
// verify authenticity. Three-state-ish result: ok with status, or a surfaced error (never silent).
import { createHmac } from "node:crypto"
import type { Fetcher } from "../http"
import { defaultFetcher } from "../http"
import type { Destination, DeliveryPayload, DeliveryResult } from "./types"

export class WebhookDestination implements Destination {
  readonly type = "webhook"
  constructor(
    private url: string,
    private secret?: string,
    private fetcher: Fetcher = defaultFetcher,
  ) {}

  async deliver(payload: DeliveryPayload): Promise<DeliveryResult> {
    const body = JSON.stringify(payload)
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (this.secret) headers["X-Signature"] = "sha256=" + createHmac("sha256", this.secret).update(body).digest("hex")
    try {
      const res = await this.fetcher(this.url, { method: "POST", headers, body, timeoutMs: 15000 })
      if (!res.ok) return { ok: false, error: `webhook responded ${res.status}` }
      return { ok: true, status: res.status }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}

/** Compute the signature a receiver should expect (exposed for receiver-side verification/tests). */
export function webhookSignature(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex")
}
