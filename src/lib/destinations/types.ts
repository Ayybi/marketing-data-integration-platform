// NEW (§11 packaging): a DESTINATION port — push the normalized rollup to Sheets/BigQuery/a webhook.
// Same ports-&-adapters shape as the data providers: callers depend on Destination, adapters implement it.
export type DeliveryPayload = { orgId: string; clientId: string; rows: Record<string, unknown>[] }
export type DeliveryResult = { ok: true; status?: number; detail?: string } | { ok: false; error: string }

export interface Destination {
  readonly type: string
  deliver(payload: DeliveryPayload): Promise<DeliveryResult>
}

export class DestinationNotConfigured extends Error {
  constructor(readonly destType: string) {
    super(`destination "${destType}" not configured — provide its credentials (see WIRING.md)`)
    this.name = "DestinationNotConfigured"
  }
}
