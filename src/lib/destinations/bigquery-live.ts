// LIVE WIRING for the BigQuery destination — builds a BigQueryInsertFn over @google-cloud/bigquery using
// the GA4 service account. Streams rows into projectId.datasetId.tableId. This is the only module that
// imports the BigQuery SDK; it is dynamic-imported by the registry so tests never load it.
import { BigQuery } from "@google-cloud/bigquery"
import { resolveGa4ServiceAccount } from "../ga4"
import { DestinationNotConfigured } from "./types"
import type { BigQueryInsertFn } from "./bigquery"

export function buildBigQueryInserter(config: Record<string, string>): BigQueryInsertFn {
  const { datasetId, tableId } = config
  if (!datasetId || !tableId) throw new DestinationNotConfigured("bigquery (missing datasetId/tableId)")

  const keyFilename = process.env.GA4_SERVICE_ACCOUNT_PATH
  const sa = resolveGa4ServiceAccount()
  if (!keyFilename && sa.status === "absent") throw new DestinationNotConfigured("bigquery (no service account)")
  if (sa.status === "error") throw new Error(`bigquery service account unparseable: ${sa.error}`)
  const creds = sa.status === "present" ? (sa.value as { client_email?: string; private_key?: string; project_id?: string }) : undefined
  const projectId = config.projectId || creds?.project_id || process.env.GOOGLE_CLOUD_PROJECT

  const bq = keyFilename
    ? new BigQuery({ keyFilename, ...(projectId ? { projectId } : {}) })
    : new BigQuery({ credentials: { client_email: creds?.client_email, private_key: creds?.private_key }, ...(projectId ? { projectId } : {}) })

  return async (rows) => {
    // Streaming insert; throws PartialFailureError (with .errors) on any row failure -> surfaced by the adapter.
    await bq.dataset(datasetId).table(tableId).insert(rows)
    return { inserted: rows.length }
  }
}
