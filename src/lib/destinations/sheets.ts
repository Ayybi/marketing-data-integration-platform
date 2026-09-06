// Google Sheets DESTINATION adapter. The row->cells mapping + delivery logic are pure and injectable
// (SheetsAppendFn); the live @googleapis/sheets client is built in sheets-live.ts and passed in, so this
// file — and the tests — never load the SDK.
import type { Destination, DeliveryPayload, DeliveryResult } from "./types"

export type SheetsAppendFn = (opts: { spreadsheetId: string; range: string; values: (string | number)[][] }) => Promise<{ updatedRows?: number }>

/** Turn rollup rows into a 2D value grid: a header row (union of keys, first-seen order) then data rows. */
export function rollupToValues(rows: Record<string, unknown>[]): (string | number)[][] {
  if (rows.length === 0) return []
  const cols: string[] = []
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k)
  const header = cols.slice()
  const body = rows.map((r) => cols.map((c) => cellValue(r[c])))
  return [header, ...body]
}

function cellValue(v: unknown): string | number {
  if (typeof v === "number") return v
  if (v == null) return ""
  if (typeof v === "string") return v
  return JSON.stringify(v)
}

export class SheetsDestination implements Destination {
  readonly type = "sheets"
  constructor(
    private spreadsheetId: string,
    private sheetName: string,
    private append: SheetsAppendFn,
  ) {}

  async deliver(payload: DeliveryPayload): Promise<DeliveryResult> {
    const values = rollupToValues(payload.rows)
    if (values.length === 0) return { ok: true, detail: "no rows to append" }
    try {
      const res = await this.append({ spreadsheetId: this.spreadsheetId, range: `${this.sheetName}!A1`, values })
      return { ok: true, detail: `appended ${res.updatedRows ?? values.length - 1} rows` }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
