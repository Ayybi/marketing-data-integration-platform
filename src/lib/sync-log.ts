// Sync observability (doc Part A §3 / §6, B6). summarizeFailures + the bounded error-sample cap are
// COPY-PASTE verbatim; the SyncResult shape and outcome states are WRITE-FROM-SPEC from §6.
//
// Three outcome states are first-class (§6, §12): success | partial | error. The distinction between
// `partial` (some items failed, sample bounded, EXISTING DATA PRESERVED) and `error` (aborted before
// writing) is what stops a flaky read from being recorded as churn or zeros.

export const SYNC_ERROR_SAMPLE_CAP = 5

/** Bound the per-item error sample so a sync_log row never dumps raw errors or credentials. */
export function summarizeFailures(samples: string[], total: number, max = SYNC_ERROR_SAMPLE_CAP): string | null {
  if (samples.length === 0) return null
  const shown = samples.slice(0, max)
  const more = total - shown.length
  return more > 0 ? `${shown.join(" | ")} | (+${more} more)` : shown.join(" | ")
}

export type SyncStatus = "success" | "partial" | "error"

/** Uniform sync return (doc §3): processed/errors/total + a bounded error sample. */
export type SyncResult = {
  processed: number
  errors: number
  total: number
  errorSample: string[]
}

/** Derive the first-class outcome state from a completed SyncResult (§6). */
export function syncStatus(r: Pick<SyncResult, "errors" | "processed">): SyncStatus {
  if (r.errors === 0) return "success"
  if (r.processed > 0) return "partial"
  return "error"
}

/** One sync_log row (doc §6 columns). */
export type SyncLogEntry = {
  source: string
  operation: string
  recordsAffected: number
  status: SyncStatus
  errorMessage: string | null
  metadata?: Record<string, unknown>
  createdAt: string
}

/** Build a sync_log row from a finished SyncResult, applying the bounded error sample. `statusOverride`
 *  forces the outcome state — used by controlled aborts that must log `partial` (existing data
 *  preserved) even though nothing was processed this run (e.g. Stripe BUG-145). */
export function toSyncLogEntry(
  source: string,
  operation: string,
  r: SyncResult,
  metadata?: Record<string, unknown>,
  statusOverride?: SyncStatus,
): SyncLogEntry {
  return {
    source,
    operation,
    recordsAffected: r.processed,
    status: statusOverride ?? syncStatus(r),
    errorMessage: summarizeFailures(r.errorSample, r.errors),
    metadata,
    createdAt: new Date().toISOString(),
  }
}
