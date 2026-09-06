// Destination registry + delivery orchestration. Webhook, Google Sheets, and BigQuery are all wired
// (the two Google adapters build their live SDK client lazily, via dynamic import).
import type { Repos, DestinationRow } from "../db/types"
import type { Fetcher } from "../http"
import { buildRollupForClient } from "../rollup/build"
import { WebhookDestination } from "./webhook"
import { SheetsDestination, type SheetsAppendFn } from "./sheets"
import { BigQueryDestination, type BigQueryInsertFn } from "./bigquery"
import { type Destination, type DeliveryResult, DestinationNotConfigured } from "./types"

export * from "./types"
export { WebhookDestination, webhookSignature } from "./webhook"
export { SheetsDestination, rollupToValues } from "./sheets"
export { BigQueryDestination, rollupToBigQueryRows } from "./bigquery"

export const DESTINATION_TYPES = ["webhook", "sheets", "bigquery"] as const
export function isDestinationType(t: string): t is (typeof DESTINATION_TYPES)[number] {
  return (DESTINATION_TYPES as readonly string[]).includes(t)
}

let webhookFetcher: Fetcher | undefined
let sheetsAppenderOverride: SheetsAppendFn | undefined
let bigQueryInserterOverride: BigQueryInsertFn | undefined

/** Test/DI hook: inject the fetcher used by webhook destinations. */
export function setDestinationFetcher(f: Fetcher | undefined): void {
  webhookFetcher = f
}
/** Test/DI hook: inject the Sheets append function (bypasses the live SDK builder). */
export function setSheetsAppender(fn: SheetsAppendFn | undefined): void {
  sheetsAppenderOverride = fn
}
/** Test/DI hook: inject the BigQuery insert function (bypasses the live SDK builder). */
export function setBigQueryInserter(fn: BigQueryInsertFn | undefined): void {
  bigQueryInserterOverride = fn
}

/**
 * Build a Destination from its stored config. Async because the Google adapters dynamic-import their SDK
 * only when needed. Throws DestinationNotConfigured for un-wired/misconfigured types.
 */
export async function buildDestination(row: Pick<DestinationRow, "type" | "config">): Promise<Destination> {
  switch (row.type) {
    case "webhook": {
      if (!row.config.url) throw new DestinationNotConfigured("webhook (missing url)")
      return new WebhookDestination(row.config.url, row.config.secret, webhookFetcher)
    }
    case "sheets": {
      if (!row.config.spreadsheetId) throw new DestinationNotConfigured("sheets (missing spreadsheetId)")
      const append = sheetsAppenderOverride ?? (await import("./sheets-live")).buildSheetsAppender()
      return new SheetsDestination(row.config.spreadsheetId, row.config.sheetName ?? "Rollup", append)
    }
    case "bigquery": {
      if (!row.config.datasetId || !row.config.tableId) throw new DestinationNotConfigured("bigquery (missing datasetId/tableId)")
      const insert = bigQueryInserterOverride ?? (await import("./bigquery-live")).buildBigQueryInserter(row.config)
      return new BigQueryDestination(insert)
    }
    default:
      throw new DestinationNotConfigured(row.type)
  }
}

export type DeliverySummary = { destinationId: string; type: string; result: DeliveryResult | { ok: false; error: string } }

/** Build the rollup for a client and deliver it to every configured destination. */
export async function deliverRollup(repos: Repos, clientId: string, bounds: { startDate: string; endDate: string }): Promise<DeliverySummary[]> {
  const rows = await buildRollupForClient(repos, clientId, bounds)
  const dests = await repos.destinations.list()
  const out: DeliverySummary[] = []
  for (const d of dests) {
    try {
      const dest = await buildDestination(d)
      out.push({ destinationId: d.destinationId, type: d.type, result: await dest.deliver({ orgId: repos.orgId, clientId, rows }) })
    } catch (e) {
      out.push({ destinationId: d.destinationId, type: d.type, result: { ok: false, error: e instanceof Error ? e.message : String(e) } })
    }
  }
  return out
}
