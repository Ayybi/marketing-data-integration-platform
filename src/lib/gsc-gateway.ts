// LIVE WIRING for GSC (doc §4.4, B4 searchanalytics.query shape). Turns the Search Console response
// into the connector's GscRow[], and maps a 403/permission failure onto the typed GscApiError so the
// connector surfaces permission_denied as an ERROR (never a silent zero that reads as "no traffic").
//
// The query call sits behind GscQueryFn so the mapper + error classification test with a fake (no live
// GSC); buildGscGateway() supplies the real @googleapis/searchconsole client (GA4 service account,
// scope webmasters.readonly).
import { GscApiError, type GscGateway, type GscRow, type GscBounds } from "./gsc"

export type GscQueryResponse = {
  data?: { rows?: Array<{ keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }> | null } | null
}
export type GscQueryParams = { siteUrl: string; requestBody: { startDate: string; endDate: string; dimensions: string[]; rowLimit: number } }
export type GscQueryFn = (params: GscQueryParams) => Promise<GscQueryResponse>

/** Map a searchanalytics.query response into the connector's GscRow[]. */
export function mapGscRows(resp: GscQueryResponse): GscRow[] {
  return (resp.data?.rows ?? []).map((r) => ({
    keys: r.keys ?? [],
    clicks: Number(r.clicks ?? 0),
    impressions: Number(r.impressions ?? 0),
    ctr: Number(r.ctr ?? 0),
    position: Number(r.position ?? 0),
  }))
}

/** Classify a Search Console error. A 403/permission failure -> PERMISSION_DENIED, else OTHER. */
export function classifyGscError(e: unknown): GscApiError {
  const err = e as { code?: number | string; status?: number; message?: string }
  const code = err?.code ?? err?.status
  const msg = err?.message ?? String(e)
  if (code === 403 || code === "PERMISSION_DENIED" || /permission|forbidden|\b403\b/i.test(msg)) {
    return new GscApiError(msg, "PERMISSION_DENIED")
  }
  return new GscApiError(msg, "OTHER")
}

/** Build a GscGateway over any query function (real SDK client or a test fake). */
export function makeGscGateway(query: GscQueryFn): GscGateway {
  return {
    async query(siteUrl: string, dimensions: string[], bounds: GscBounds, rowLimit: number): Promise<GscRow[]> {
      let resp: GscQueryResponse
      try {
        resp = await query({ siteUrl, requestBody: { startDate: bounds.startDate, endDate: bounds.endDate, dimensions, rowLimit } })
      } catch (e) {
        throw classifyGscError(e) // permission/other surfaced as a typed error, never empty rows
      }
      return mapGscRows(resp)
    },
  }
}
