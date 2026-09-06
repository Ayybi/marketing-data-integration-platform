// COPY-PASTE (doc B2, verbatim): shared helpers every connector needs.
// normalizeDomain, withTimeout, and the two three-state classifiers (HTTP status + SEMrush units).

export function normalizeDomain(input: string): string {
  let d = (input || "").trim().toLowerCase()
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]
  return d || "example.com"
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ])
}

// THE invariant: three-state read. Only "absent" may claim "nothing here"; "error" surfaces/counts.
export type ReadOutcome = "absent" | "present" | "error"
export function classifyReadStatus(status: number): ReadOutcome {
  if (status === 200) return "present"
  if (status === 404) return "absent"
  return "error"
}

// SEMrush units three-state (doc B2, verbatim). Depletion (a units error) reads as balance 0 — a real,
// authoritative "you have no units" — while an unreachable/garbled endpoint reads as "unreadable" so a
// transport failure never masquerades as a real balance.
export type UnitsRead =
  | { kind: "ok"; balance: number }
  | { kind: "unconfigured" }
  | { kind: "unreadable"; detail: string }
export function classifyUnitsRead(ok: boolean, status: number, body: string): UnitsRead {
  const n = parseInt((body ?? "").trim(), 10)
  if (ok && Number.isFinite(n)) return { kind: "ok", balance: n }
  if (isSemrushUnitsError(body)) return { kind: "ok", balance: 0 }
  if (!ok) return { kind: "unreadable", detail: `HTTP ${status}` }
  return { kind: "unreadable", detail: "non-numeric body" }
}

// SEMrush signals unit depletion in the CSV/text body (e.g. "ERROR 120 :: NOTHING FOUND" family and
// the units-specific "API units balance is too low"). Detecting it lets depletion read as an
// authoritative balance of 0 rather than an unreadable transport error.
export function isSemrushUnitsError(body: string): boolean {
  const b = String(body ?? "").toUpperCase()
  return b.includes("API UNITS BALANCE") || b.includes("NOT ENOUGH API UNITS") || /ERROR\s+1\d\d\b/.test(b)
}
