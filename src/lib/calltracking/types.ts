// NEW (architecture): the CALL-TRACKING provider PORT. Call tracking (enumerate companies, pull calls)
// is vendor-agnostic; CallRail is one ADAPTER behind this interface. Our domain logic — daily-snapshot
// aggregation, storage, the LLM lead classifier, the three-state reads — sits ON TOP of the port and
// works over ANY provider. Switching vendors (CallTrackingMetrics, Twilio, etc.) is "add an adapter +
// set CALL_TRACKING_PROVIDER" with zero changes to aggregation/sync/storage.

export type CallTrackingBounds = { startDate: string; endDate: string } // YYYY-MM-DD inclusive

export type TrackedCompany = { companyId: string; name: string }

/**
 * Normalized call — the shape every adapter maps its vendor calls into. Vendor-specific lead concepts
 * are normalized to booleans (`qualifiedLead`, `firstTimeCaller`) so aggregation is provider-agnostic;
 * the raw `leadStatus` string is kept for detail/classification.
 */
export type TrackedCall = {
  callId: string
  startTime?: string // ISO8601
  durationSeconds?: number
  answered?: boolean
  firstTimeCaller?: boolean
  qualifiedLead?: boolean
  leadStatus?: string
  customerName?: string
  customerPhone?: string
  recordingUrl?: string
  transcription?: string
}

export interface CallTrackingProvider {
  readonly name: string
  /** Resolve the account/agency id that holds companies (Model A: one agency account, many companies). */
  resolveAccountId(): Promise<string>
  /** List tracked companies under an account. */
  listCompanies(accountId: string): Promise<TrackedCompany[]>
  /**
   * Fetch ALL calls for a company in a window, following pagination. MUST THROW on any read failure
   * (§4.1/§12) — never return a partial/[] that looks like "no calls".
   */
  fetchCalls(accountId: string, companyId: string, bounds: CallTrackingBounds): Promise<TrackedCall[]>
}

/** Thrown by the factory when the selected provider has no credentials -> caller writes an error sync_log. */
export class CallTrackingNotConfigured extends Error {
  constructor(readonly provider: string) {
    super(`Call-tracking provider "${provider}" not configured — set its API key (see WIRING.md)`)
    this.name = "CallTrackingNotConfigured"
  }
}
