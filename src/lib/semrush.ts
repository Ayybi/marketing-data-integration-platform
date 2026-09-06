// SEMrush connector (doc §4.7, B4 CSV shapes).
//
// Auth: SEMRUSH_API_KEY (query param), env first then vault. No expiry. API units are monitored via a
// free endpoint (countapiunits.html); depletion raises SemrushUnitsError.
//
// Failure discipline (§4.7, §12):
//  - readApiUnitsBalance returns UnitsRead three-state (ok/unconfigured/unreadable) — a transport failure
//    is UNREADABLE, never a fake balance; depletion reads as an authoritative balance 0.
//  - Data fetches return ReadResult three-state. With throwOnUnits, depletion raises SemrushUnitsError so
//    a caller can mark a client depleted (used by snapshot refresh). [DEVIATION: the doc's "degrade to
//    null/[]" is strengthened to explicit present/absent/error per the non-negotiable §12 invariant.]
//  - LANDMINE guard: each fetch binds its export_columns to the SAME column list used to parse, so the
//    request and the positional parse can never drift.
import type { Fetcher } from "./http"
import { defaultFetcher } from "./http"
import type { Repos } from "./db/types"
import type { ReadResult } from "./result"
import { classifyUnitsRead, isSemrushUnitsError, type UnitsRead } from "./helpers"
import { resolveConnectorKey } from "./tenant-creds"

const BASE = "https://api.semrush.com/"

export class SemrushUnitsError extends Error {
  constructor(message = "SEMrush API units depleted") {
    super(message)
    this.name = "SemrushUnitsError"
  }
}

/** Resolve the API key. BYO: the tenant's own vault entry FIRST, then SEMRUSH_API_KEY env (three-state). */
export async function resolveSemrushKey(repos: Repos): Promise<ReadResult<string>> {
  return resolveConnectorKey(repos, "semrush", "SEMRUSH_API_KEY")
}

export async function isSemrushConfigured(repos: Repos): Promise<boolean> {
  return (await resolveSemrushKey(repos)).status === "present"
}

// ---- Units (three-state, B2 classifyUnitsRead verbatim) ----

export async function readApiUnitsBalance(fetcher: Fetcher, apiKey: string | null): Promise<UnitsRead> {
  if (!apiKey) return { kind: "unconfigured" }
  let res
  try {
    res = await fetcher(`${BASE}analytics/api_units_check?key=${encodeURIComponent(apiKey)}`, { timeoutMs: 15000 })
  } catch (e) {
    return { kind: "unreadable", detail: e instanceof Error ? e.message : String(e) }
  }
  const body = await res.text()
  return classifyUnitsRead(res.ok, res.status, body)
}

// ---- CSV request + positional parse (columns bound together) ----

type Descriptor = { type: string; columns: string[]; params: Record<string, string> }

function buildUrl(apiKey: string, d: Descriptor): string {
  const url = new URL(BASE)
  url.search = new URLSearchParams({ ...d.params, type: d.type, export_columns: d.columns.join(","), key: apiKey }).toString()
  return url.toString()
}

/** Parse SEMrush CSV: header line then ';'-separated rows. Values are mapped BY THE SAME `columns` used
 *  in the request, so positional parsing cannot drift from what was requested. */
export function parseSemrushCsv(body: string, columns: string[]): Array<Record<string, string>> {
  const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length <= 1) return []
  return lines.slice(1).map((line) => {
    const cells = line.split(";")
    const row: Record<string, string> = {}
    columns.forEach((col, i) => (row[col] = cells[i] ?? ""))
    return row
  })
}

async function fetchCsv<T>(
  fetcher: Fetcher,
  apiKey: string,
  d: Descriptor,
  map: (rows: Array<Record<string, string>>) => T,
  throwOnUnits: boolean,
): Promise<ReadResult<T>> {
  let res
  try {
    res = await fetcher(buildUrl(apiKey, d), { timeoutMs: 15000 })
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) }
  }
  const body = await res.text()
  if (isSemrushUnitsError(body)) {
    if (throwOnUnits) throw new SemrushUnitsError()
    return { status: "error", error: "SEMrush units depleted" }
  }
  if (!res.ok) return { status: "error", error: `HTTP ${res.status}` }
  // "ERROR nn :: NOTHING FOUND" is a genuine absence for a domain SEMrush has no data on.
  if (/ERROR\s+\d+\s*::\s*NOTHING FOUND/i.test(body)) return { status: "absent" }
  const rows = parseSemrushCsv(body, d.columns)
  if (rows.length === 0) return { status: "absent" }
  return { status: "present", value: map(rows) }
}

// ---- Typed fetches ----

export type DomainOverview = { organicTraffic: number; organicKeywords: number; rank: number }
const OVERVIEW: Omit<Descriptor, "params"> = { type: "domain_ranks", columns: ["Db", "Dn", "Rk", "Or", "Ot", "Oc"] }

export async function fetchDomainOverview(fetcher: Fetcher, apiKey: string, domain: string, database = "us", throwOnUnits = false): Promise<ReadResult<DomainOverview>> {
  return fetchCsv(
    fetcher,
    apiKey,
    { ...OVERVIEW, params: { domain, database } },
    (rows) => ({ organicKeywords: Number(rows[0].Or || 0), organicTraffic: Number(rows[0].Ot || 0), rank: Number(rows[0].Rk || 0) }),
    throwOnUnits,
  )
}

export type DomainBacklinks = { authorityScore: number; totalBacklinks: number; referringDomains: number }
const BACKLINKS: Omit<Descriptor, "params"> = { type: "backlinks_overview", columns: ["ascore", "total", "domains_num"] }

export async function fetchDomainBacklinks(fetcher: Fetcher, apiKey: string, domain: string, throwOnUnits = false): Promise<ReadResult<DomainBacklinks>> {
  return fetchCsv(
    fetcher,
    apiKey,
    { ...BACKLINKS, params: { target: domain, target_type: "root_domain" } },
    (rows) => ({ authorityScore: Number(rows[0].ascore || 0), totalBacklinks: Number(rows[0].total || 0), referringDomains: Number(rows[0].domains_num || 0) }),
    throwOnUnits,
  )
}

export type OrganicKeyword = { phrase: string; position: number; volume: number }
const ORGANIC: Omit<Descriptor, "params"> = { type: "domain_organic", columns: ["Ph", "Po", "Nq"] }

export async function fetchDomainOrganicKeywords(fetcher: Fetcher, apiKey: string, domain: string, database = "us", limit = 100, throwOnUnits = false): Promise<ReadResult<OrganicKeyword[]>> {
  return fetchCsv(
    fetcher,
    apiKey,
    { ...ORGANIC, params: { domain, database, display_limit: String(limit) } },
    (rows) => rows.map((r) => ({ phrase: r.Ph, position: Number(r.Po || 0), volume: Number(r.Nq || 0) })),
    throwOnUnits,
  )
}

export type SearchVolume = { phrase: string; volume: number }
const VOLUMES: Omit<Descriptor, "params"> = { type: "phrase_these", columns: ["Ph", "Nq"] }

/** Batched search volumes for phrases (phrase_these). Three-state; honors depletion like the others. */
export async function fetchSearchVolumes(fetcher: Fetcher, apiKey: string, phrases: string[], database = "us", throwOnUnits = false): Promise<ReadResult<SearchVolume[]>> {
  if (phrases.length === 0) return { status: "present", value: [] }
  return fetchCsv(
    fetcher,
    apiKey,
    { ...VOLUMES, params: { phrase: phrases.slice(0, 100).join(";"), database } },
    (rows) => rows.map((r) => ({ phrase: r.Ph, volume: Number(r.Nq || 0) })),
    throwOnUnits,
  )
}

// ---- Project list sync (§4.7) ----

export type RawSemrushProject = { project_id: string | number; project_name?: string; url?: string; domain_unicode?: string }

/**
 * A project-list source over the SEMrush management API (JSON). CRITICAL (§12): it THROWS on any fetch
 * failure and never returns [] on error — because syncSemrushProjects prunes projects not in the list,
 * so a transport error returning [] would wipe every stored project. Only an authoritative 200 with no
 * projects yields [].
 */
export function makeSemrushProjectSource(fetcher: Fetcher, apiKey: string): () => Promise<RawSemrushProject[]> {
  return async () => {
    let res
    try {
      res = await fetcher(`https://api.semrush.com/management/v1/projects/?key=${encodeURIComponent(apiKey)}`, { timeoutMs: 15000 })
    } catch (e) {
      throw new Error(`SEMrush projects fetch failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    const body = await res.text()
    if (!res.ok) throw new Error(`SEMrush projects -> ${res.status}`) // never prune-to-empty on error
    if (/^ERROR/i.test(body.trim())) throw new Error(`SEMrush projects: ${body.trim().slice(0, 80)}`)
    let json: unknown
    try {
      json = JSON.parse(body)
    } catch {
      throw new Error("SEMrush projects: non-JSON body")
    }
    const arr = Array.isArray(json)
      ? json
      : (json as { data?: unknown; projects?: unknown }).data ?? (json as { projects?: unknown }).projects ?? null
    if (!Array.isArray(arr)) throw new Error("SEMrush projects: unexpected response shape")
    return arr.map((p) => {
      const r = p as Record<string, unknown>
      return {
        project_id: r.project_id as string | number,
        project_name: r.project_name as string | undefined,
        url: r.url as string | undefined,
        domain_unicode: r.domain_unicode as string | undefined,
      }
    })
  }
}

/** Sync the SEMrush project list, pruning projects no longer present. */
export async function syncSemrushProjects(repos: Repos, projects: RawSemrushProject[]): Promise<{ upserted: number; pruned: number }> {
  const ids: string[] = []
  for (const p of projects) {
    const projectId = String(p.project_id)
    ids.push(projectId)
    await repos.semrush.upsertProject({ projectId, projectName: p.project_name, url: p.url, domainUnicode: p.domain_unicode })
  }
  const pruned = await repos.semrush.pruneProjectsNotIn(ids)
  return { upserted: ids.length, pruned }
}
