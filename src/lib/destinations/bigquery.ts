// BigQuery DESTINATION adapter. The row shaping + delivery logic are pure and injectable
// (BigQueryInsertFn); the live @google-cloud/bigquery client is built in bigquery-live.ts and passed
// in, so this file — and the tests — never load the SDK.
import type { Destination, DeliveryPayload, DeliveryResult } from "./types"

export type BigQueryInsertFn = (rows: Record<string, unknown>[]) => Promise<{ inserted: number }>

/** Shape rollup rows into BigQuery table rows: stamp org + client so the table is a flat multi-tenant fact. */
export function rollupToBigQueryRows(payload: DeliveryPayload): Record<string, unknown>[] {
  return payload.rows.map((r) => ({ orgId: payload.orgId, clientId: payload.clientId, ...r }))
}

export class BigQueryDestination implements Destination {
  readonly type = "bigquery"
  constructor(private insert: BigQueryInsertFn) {}

  async deliver(payload: DeliveryPayload): Promise<DeliveryResult> {
    const rows = rollupToBigQueryRows(payload)
    if (rows.length === 0) return { ok: true, detail: "no rows to insert" }
    try {
      const res = await this.insert(rows)
      return { ok: true, detail: `inserted ${res.inserted} rows` }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
