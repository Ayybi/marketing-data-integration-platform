// CallRail ADAPTER for the CallTrackingProvider port (doc §4.1, B4 request shapes, B5 auth/retry
// verbatim). Owns the CallRail-specific low-level fetch + the raw->normalized mapping. Adding another
// vendor means writing a sibling file like this; aggregation/sync/storage never change.
import type { Fetcher } from "../http"
import type { Repos } from "../db/types"
import type { ReadResult } from "../result"
import { resolveConnectorKey } from "../tenant-creds"
import type { CallTrackingProvider, CallTrackingBounds, TrackedCall, TrackedCompany } from "./types"

const BASE = "https://api.callrail.com/v3"
const PER_PAGE = 250

// ---- Auth (B5, verbatim logic) ----

function callRailHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Token token="${apiKey}"`, "Content-Type": "application/json" }
}

/**
 * One-retry GET (B5). A 429 retries once; any other non-ok THROWS so an ERROR surfaces and is never
 * silently reported as an empty result.
 */
export async function callRailGet(fetcher: Fetcher, apiKey: string, path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetcher(`${BASE}${path}`, { headers: callRailHeaders(apiKey), timeoutMs: 20000 })
    if (res.status === 429 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }
    if (!res.ok) throw new Error(`CallRail ${path} -> ${res.status}`) // ERROR surfaces; never a silent []
    return (await res.json()) as Record<string, unknown>
  }
  throw new Error(`CallRail ${path} -> 429 (rate limited)`)
}

/**
 * Resolve the API key. BYO: the tenant's own vault entry FIRST, then CALLRAIL_API_KEY env as a shared
 * default. Three-state: present -> key, absent -> not configured, error -> a stored blob failed to decrypt.
 */
export async function resolveCallRailKey(repos: Repos): Promise<ReadResult<string>> {
  return resolveConnectorKey(repos, "callrail", "CALLRAIL_API_KEY")
}

// ---- Fetches (B4 request shapes) ----

export async function getAgencyAccountId(fetcher: Fetcher, apiKey: string): Promise<string> {
  const data = await callRailGet(fetcher, apiKey, `/a.json?page=1&per_page=100`)
  const accounts = (data.accounts as Array<{ id: string | number }> | undefined) ?? []
  if (accounts.length === 0) throw new Error("CallRail: no agency account found")
  return String(accounts[0].id)
}

export type CallRailCompany = { id: string; name: string }

export async function fetchCompanies(fetcher: Fetcher, apiKey: string, accountId: string): Promise<CallRailCompany[]> {
  const data = await callRailGet(fetcher, apiKey, `/a/${accountId}/companies.json?page=1&per_page=100`)
  const companies = (data.companies as Array<{ id: string | number; name?: string }> | undefined) ?? []
  return companies.map((c) => ({ id: String(c.id), name: c.name ?? "" }))
}

export type RawCall = {
  id: string | number
  start_time?: string
  duration?: number
  answered?: boolean
  first_call?: boolean
  lead_status?: string
  customer_name?: string
  customer_phone_number?: string
  recording?: string
  transcription?: string
}

const CALL_FIELDS = "id,start_time,duration,answered,first_call,lead_status,customer_name,customer_phone_number,recording,transcription"

/** Fetch all calls for a company in a window, following pagination. THROWS on any page failure (§4.1). */
export async function fetchCallsForCompany(
  fetcher: Fetcher,
  apiKey: string,
  accountId: string,
  companyId: string,
  bounds: CallTrackingBounds,
): Promise<RawCall[]> {
  const calls: RawCall[] = []
  let page = 1
  for (let guard = 0; guard < 1000; guard++) {
    const path =
      `/a/${accountId}/calls.json?company_id=${encodeURIComponent(companyId)}` +
      `&start_date=${bounds.startDate}&end_date=${bounds.endDate}&fields=${CALL_FIELDS}&per_page=${PER_PAGE}&page=${page}`
    const data = await callRailGet(fetcher, apiKey, path) // throws on failure -> caller counts it
    const batch = (data.calls as RawCall[] | undefined) ?? []
    calls.push(...batch)
    const totalPages = Number(data.total_pages ?? 1)
    if (page >= totalPages || batch.length === 0) break
    page += 1
  }
  return calls
}

/** Map a CallRail raw call into the normalized TrackedCall (qualified = lead_status 'good_lead', §4.1). */
export function mapRawCallToTracked(c: RawCall): TrackedCall {
  return {
    callId: String(c.id),
    startTime: c.start_time,
    durationSeconds: c.duration,
    answered: c.answered,
    firstTimeCaller: c.first_call,
    qualifiedLead: c.lead_status === "good_lead",
    leadStatus: c.lead_status,
    customerName: c.customer_name,
    customerPhone: c.customer_phone_number,
    recordingUrl: c.recording,
    transcription: c.transcription,
  }
}

/** The CallRail adapter. Constructed by the factory with a resolved API key. */
export class CallRailProvider implements CallTrackingProvider {
  readonly name = "callrail"
  constructor(
    private fetcher: Fetcher,
    private apiKey: string,
  ) {}

  resolveAccountId(): Promise<string> {
    return getAgencyAccountId(this.fetcher, this.apiKey)
  }
  async listCompanies(accountId: string): Promise<TrackedCompany[]> {
    return (await fetchCompanies(this.fetcher, this.apiKey, accountId)).map((c) => ({ companyId: c.id, name: c.name }))
  }
  async fetchCalls(accountId: string, companyId: string, bounds: CallTrackingBounds): Promise<TrackedCall[]> {
    const raw = await fetchCallsForCompany(this.fetcher, this.apiKey, accountId, companyId, bounds)
    return raw.map(mapRawCallToTracked)
  }
}
