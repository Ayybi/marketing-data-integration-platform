// LIVE WIRING for GA4 (doc §4.2, B4 runReport shape). Turns the GA4 Data API response into the
// connector's Ga4ReportRow[], and maps gRPC failures onto the typed Ga4ApiError codes the connector's
// failure discipline depends on (PERMISSION_DENIED/NOT_FOUND -> deactivate; OTHER -> transient retry).
//
// The low-level runReport call sits behind Ga4RunReportFn so the mapper + error classification test
// with a fake (no live GA4); buildGa4Gateway() supplies the real BetaAnalyticsDataClient.
import { Ga4ApiError, type Ga4Gateway, type Ga4ReportRequest, type Ga4ReportRow, type Ga4Bounds } from "./ga4"

// Minimal shape of the runReport response we read (the SDK object is structurally compatible).
export type Ga4RunReportResponse = {
  rows?: Array<{ dimensionValues?: Array<{ value?: string | null }>; metricValues?: Array<{ value?: string | null }> }> | null
}
// The SDK's client.runReport resolves to a gax tuple [response, rawRequest?, options?].
export type Ga4RunReportFn = (request: Record<string, unknown>) => Promise<[Ga4RunReportResponse, ...unknown[]]>

/** Map a runReport response into flat rows of string dimensions + numeric metrics. */
export function mapGa4Rows(response: Ga4RunReportResponse): Ga4ReportRow[] {
  return (response.rows ?? []).map((r) => ({
    dimensions: (r.dimensionValues ?? []).map((v) => v.value ?? ""),
    metrics: (r.metricValues ?? []).map((v) => Number(v.value ?? 0)),
  }))
}

/** Classify a GA4/gRPC error into a typed Ga4ApiError. gRPC codes: 7=PERMISSION_DENIED, 5=NOT_FOUND. */
export function classifyGa4Error(e: unknown): Ga4ApiError {
  const err = e as { code?: number | string; message?: string }
  const code = err?.code
  const msg = err?.message ?? String(e)
  if (code === 7 || code === "PERMISSION_DENIED" || /permission[_ ]denied/i.test(msg)) return new Ga4ApiError(msg, "PERMISSION_DENIED")
  if (code === 5 || code === "NOT_FOUND" || /not[_ ]found/i.test(msg)) return new Ga4ApiError(msg, "NOT_FOUND")
  return new Ga4ApiError(msg, "OTHER")
}

/** Build a Ga4Gateway over any runReport function (real SDK client or a test fake). */
export function makeGa4Gateway(run: Ga4RunReportFn): Ga4Gateway {
  return {
    async runReport(propertyId: string, req: Ga4ReportRequest, bounds: Ga4Bounds): Promise<Ga4ReportRow[]> {
      const request = {
        property: `properties/${propertyId}`,
        dateRanges: [{ startDate: bounds.startDate, endDate: bounds.endDate }],
        dimensions: req.dimensions.map((name) => ({ name })),
        metrics: req.metrics.map((name) => ({ name })),
        limit: 100000,
      }
      let response: Ga4RunReportResponse
      try {
        ;[response] = await run(request)
      } catch (e) {
        throw classifyGa4Error(e) // gRPC failure -> typed code the connector acts on
      }
      return mapGa4Rows(response)
    },
  }
}
