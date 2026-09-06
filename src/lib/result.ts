// Shared three-state read result (doc Section 12 / Part A §12 invariant): present / absent / error,
// never conflated. Only "absent" may mean "nothing here"; an "error" surfaces or is counted, and is
// NEVER allowed to look like a real zero/empty value.
export type ReadResult<T> =
  | { status: "present"; value: T }
  | { status: "absent" }
  | { status: "error"; error: string }
