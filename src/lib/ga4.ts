// GA4 connector (doc §4.2, B4 runReport shape). WRITE-FROM-SPEC bodies.
//
// Auth: Google service-account JSON (GA4_SERVICE_ACCOUNT_JSON / _PATH). The real @google-analytics/data
// client is built from that credential in production; here the runReport call is behind an injectable
// Ga4Gateway so the normalization + failure discipline are tested with a fake (no live API).
//
// Failure discipline (§4.2, §12): on PERMISSION_DENIED or NOT_FOUND during sync we DEACTIVATE the
// mapping (status='error') and report {deactivated:true} so the cron distinguishes lost access from a
// transient blip. A transient error is COUNTED and retried next run — never written as zeros.
import type { Repos, Ga4SnapshotRow, Ga4Channel, Ga4Page } from "./db/types"
import type { ReadResult } from "./result"
import { type SyncResult, toSyncLogEntry } from "./sync-log"

export type Ga4Bounds = { startDate: string; endDate: string } // YYYY-MM-DD

// ---- External call seam ----

export type Ga4ErrorCode = "PERMISSION_DENIED" | "NOT_FOUND" | "OTHER"
export class Ga4ApiError extends Error {
  constructor(
    message: string,
    readonly code: Ga4ErrorCode,
  ) {
    super(message)
    this.name = "Ga4ApiError"
  }
}

export type Ga4ReportRequest = { dimensions: string[]; metrics: string[] }
export type Ga4ReportRow = { dimensions: string[]; metrics: number[] }
export interface Ga4Gateway {
  // Mirrors the B4 runReport shape; throws Ga4ApiError with a code on failure.
  runReport(propertyId: string, req: Ga4ReportRequest, bounds: Ga4Bounds): Promise<Ga4ReportRow[]>
}

// ---- Auth ----

/** Three-state resolve of the service-account JSON: present -> parsed, absent -> unset, error -> unparseable. */
export function resolveGa4ServiceAccount(): ReadResult<{ client_email?: string }> {
  const raw = process.env.GA4_SERVICE_ACCOUNT_JSON
  if (!raw) return { status: "absent" } // GA4_SERVICE_ACCOUNT_PATH handled by the real client loader
  try {
    // Accept base64 or raw JSON.
    const json = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")
    return { status: "present", value: JSON.parse(json) }
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) }
  }
}

export function isGa4Configured(): boolean {
  return Boolean(process.env.GA4_SERVICE_ACCOUNT_JSON || process.env.GA4_SERVICE_ACCOUNT_PATH)
}

export function getGa4ServiceAccountEmail(): string | null {
  const sa = resolveGa4ServiceAccount()
  return sa.status === "present" ? (sa.value.client_email ?? null) : null
}

// ---- Normalize ----

const CORE_REQ: Ga4ReportRequest = {
  dimensions: ["date", "sessionDefaultChannelGroup"],
  metrics: ["sessions", "totalUsers", "newUsers", "conversions", "engagedSessions"],
}
const PAGES_REQ: Ga4ReportRequest = { dimensions: ["pagePath"], metrics: ["screenPageViews"] }

function ymd(ga4Date: string): string {
  // GA4 "date" dimension is YYYYMMDD.
  return /^\d{8}$/.test(ga4Date) ? `${ga4Date.slice(0, 4)}-${ga4Date.slice(4, 6)}-${ga4Date.slice(6, 8)}` : ga4Date
}

/** Build daily snapshots from a core (date x channel) report and a pages report. */
export function normalizeGa4Snapshots(
  clientId: string,
  ga4PropertyId: string,
  coreRows: Ga4ReportRow[],
  pageRows: Ga4ReportRow[],
): Array<Omit<Ga4SnapshotRow, "orgId">> {
  const topPages: Ga4Page[] = pageRows
    .map((r) => ({ path: r.dimensions[0] ?? "", views: r.metrics[0] ?? 0 }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 20)

  const byDate = new Map<string, Omit<Ga4SnapshotRow, "orgId">>()
  for (const r of coreRows) {
    const date = ymd(r.dimensions[0] ?? "")
    const channel = r.dimensions[1] ?? "(other)"
    const [sessions = 0, totalUsers = 0, newUsers = 0, conversions = 0, engagedSessions = 0] = r.metrics
    let row = byDate.get(date)
    if (!row) {
      row = { clientId, ga4PropertyId, snapshotDate: date, sessions: 0, totalUsers: 0, newUsers: 0, conversions: 0, engagedSessions: 0, channels: [], topPages }
      byDate.set(date, row)
    }
    row.sessions += sessions
    row.totalUsers += totalUsers
    row.newUsers += newUsers
    row.conversions += conversions
    row.engagedSessions += engagedSessions
    row.channels.push({ channel, sessions, conversions } satisfies Ga4Channel)
  }
  return [...byDate.values()]
}

// ---- Sync ----

export type Ga4ClientSyncOutcome =
  | { kind: "processed"; days: number }
  | { kind: "deactivated"; reason: Ga4ErrorCode } // lost access (permanent-ish): mapping set to 'error'
  | { kind: "transient"; error: string } // counted + retried next run

/** Sync one client's GA4 snapshots. Deactivates on lost access; counts transient errors. */
export async function syncGa4ForClient(
  repos: Repos,
  clientId: string,
  gateway: Ga4Gateway,
  bounds: Ga4Bounds,
): Promise<Ga4ClientSyncOutcome> {
  const mapping = await repos.ga4.getMappingByClient(clientId)
  if (mapping.status !== "present") {
    return { kind: "transient", error: `mapping ${mapping.status}` }
  }
  const propertyId = mapping.value.ga4PropertyId
  try {
    const [coreRows, pageRows] = await Promise.all([
      gateway.runReport(propertyId, CORE_REQ, bounds),
      gateway.runReport(propertyId, PAGES_REQ, bounds),
    ])
    const snapshots = normalizeGa4Snapshots(clientId, propertyId, coreRows, pageRows)
    for (const s of snapshots) await repos.ga4.upsertSnapshot(s)
    return { kind: "processed", days: snapshots.length }
  } catch (e) {
    if (e instanceof Ga4ApiError && (e.code === "PERMISSION_DENIED" || e.code === "NOT_FOUND")) {
      await repos.ga4.setMappingStatus(clientId, "error") // deactivate: distinguish lost access from a blip
      return { kind: "deactivated", reason: e.code }
    }
    return { kind: "transient", error: e instanceof Error ? e.message : String(e) }
  }
}

/** Sweep all active GA4 mappings; write one sync_log row. Deactivations are tracked separately from
 *  transient errors so a permanent access loss is not confused with a retryable blip. */
export async function syncAllGa4(repos: Repos, gateway: Ga4Gateway, bounds: Ga4Bounds): Promise<SyncResult & { deactivated: number }> {
  const mappings = await repos.ga4.activeMappings()
  const errorSample: string[] = []
  let processed = 0
  let errors = 0
  let deactivated = 0
  for (const m of mappings) {
    const out = await syncGa4ForClient(repos, m.clientId, gateway, bounds)
    if (out.kind === "processed") processed += 1
    else if (out.kind === "deactivated") {
      deactivated += 1
      if (errorSample.length < 5) errorSample.push(`${m.clientId}: deactivated (${out.reason})`)
    } else {
      errors += 1
      if (errorSample.length < 5) errorSample.push(`${m.clientId}: ${out.error}`)
    }
  }
  const result: SyncResult = { processed, errors, total: mappings.length, errorSample }
  await repos.syncLog.write(toSyncLogEntry("ga4", "snapshot", result, { deactivated }))
  return { ...result, deactivated }
}

// ---- Reads ----

export type Ga4Metrics = {
  sessions: number
  totalUsers: number
  newUsers: number
  conversions: number
  engagedSessions: number
  channels: Ga4Channel[]
  topPages: Ga4Page[]
}

/** Three-state read: absent = no mapping, error = mapping lookup failed, present = aggregated metrics. */
export async function getGa4Analytics(repos: Repos, clientId: string, bounds: Ga4Bounds): Promise<ReadResult<Ga4Metrics>> {
  const mapping = await repos.ga4.getMappingByClient(clientId)
  if (mapping.status === "absent") return { status: "absent" }
  if (mapping.status === "error") return { status: "error", error: mapping.error }

  const rows = await repos.ga4.snapshotsForClient(clientId, bounds.startDate, bounds.endDate)
  const acc: Ga4Metrics = { sessions: 0, totalUsers: 0, newUsers: 0, conversions: 0, engagedSessions: 0, channels: [], topPages: [] }
  const channelTotals = new Map<string, Ga4Channel>()
  const pageTotals = new Map<string, number>()
  for (const r of rows) {
    acc.sessions += r.sessions
    acc.totalUsers += r.totalUsers
    acc.newUsers += r.newUsers
    acc.conversions += r.conversions
    acc.engagedSessions += r.engagedSessions
    for (const c of r.channels) {
      const t = channelTotals.get(c.channel) ?? { channel: c.channel, sessions: 0, conversions: 0 }
      t.sessions += c.sessions
      t.conversions += c.conversions
      channelTotals.set(c.channel, t)
    }
    for (const p of r.topPages) pageTotals.set(p.path, Math.max(pageTotals.get(p.path) ?? 0, p.views))
  }
  acc.channels = [...channelTotals.values()].sort((a, b) => b.sessions - a.sessions)
  acc.topPages = [...pageTotals.entries()].map(([path, views]) => ({ path, views })).sort((a, b) => b.views - a.views).slice(0, 20)
  return { status: "present", value: acc }
}

// ---- Lead events (§4.2) ----

export type LeadEventKind = "form" | "call" | "email" | "other"

/** Bucket a GA4 key-event name into a lead type by regex (§4.2). */
export function classifyLeadEvent(name: string): LeadEventKind {
  const n = (name ?? "").toLowerCase()
  if (/(form|submit|contact|quote|estimate|lead|signup|sign_up)/.test(n)) return "form"
  if (/(call|phone|tel|click_to_call)/.test(n)) return "call"
  if (/(email|mailto)/.test(n)) return "email"
  return "other"
}

export type Ga4LeadEvents = { form: number; call: number; email: number; other: number; total: number }

/** Fetch and bucket lead events for a client's property (live via the gateway). Three-state read. */
export async function getGa4LeadEvents(repos: Repos, clientId: string, gateway: Ga4Gateway, bounds: Ga4Bounds): Promise<ReadResult<Ga4LeadEvents>> {
  const mapping = await repos.ga4.getMappingByClient(clientId)
  if (mapping.status === "absent") return { status: "absent" }
  if (mapping.status === "error") return { status: "error", error: mapping.error }
  try {
    const rows = await gateway.runReport(mapping.value.ga4PropertyId, { dimensions: ["eventName"], metrics: ["eventCount"] }, bounds)
    const out: Ga4LeadEvents = { form: 0, call: 0, email: 0, other: 0, total: 0 }
    for (const r of rows) {
      const kind = classifyLeadEvent(r.dimensions[0] ?? "")
      const count = r.metrics[0] ?? 0
      out[kind] += count
      out.total += count
    }
    return { status: "present", value: out }
  } catch (e) {
    if (e instanceof Ga4ApiError && (e.code === "PERMISSION_DENIED" || e.code === "NOT_FOUND")) return { status: "error", error: e.code }
    return { status: "error", error: e instanceof Error ? e.message : String(e) }
  }
}
