# Wiring the Marketing Data Hub into a host app

The connector core is a portable TypeScript library. The `hub-app/*` layer is framework-agnostic:
handlers return `{ status, body }`, cron runners return summaries. Mount them in thin Next route
handlers (doc B1 stack). Nothing in the core imports `next`.

## Pluggable SEO provider (ports & adapters)

SEO intelligence is behind a vendor-agnostic PORT (`src/lib/seo/types.ts` `SeoProvider`) so the data
service is swappable. SEMrush is one ADAPTER (`seo/semrush-provider.ts`); callers depend only on the
port and get NORMALIZED output regardless of vendor.

- Select the vendor with `SEO_PROVIDER` (default `semrush`). The factory `getSeoProvider()` builds the
  adapter and throws `SeoProviderNotConfigured` (→ 501) if its key is missing.
- Add a vendor: write `seo/<vendor>-provider.ts` implementing `SeoProvider` (map its fields into
  `SeoDomainOverview` / `SeoBacklinks` / `SeoKeyword`, its metering into `quota()`), then add a `case`
  in `seo/index.ts`. Nothing else changes — routes, callers, and tests are untouched.
- Capabilities are explicit: a vendor without, say, backlinks declares reduced `capabilities` and that
  call returns `unsupported_capability:backlinks` (a config signal), never a fake zero.
- Metering is generic: `quota()` returns ok/unlimited/unconfigured/unreadable; `throwOnQuota` surfaces
  depletion as a normalized `SeoQuotaError`.
- Routes: `GET /api/v1/seo/metrics?domain=&type=overview|backlinks|keywords`, `GET /api/v1/seo/quota`.
- Note: SEMrush *projects/site-audit* stay vendor-specific (`semrush.ts`, `/api/cron/semrush-projects`)
  — they're a SEMrush account concept, not a cross-vendor SEO primitive, so they're outside the port.

## Pluggable call-tracking provider (ports & adapters)

Same pattern as SEO, applied to CallRail. The vendor-specific part (enumerate companies, pull calls)
is behind a PORT (`src/lib/calltracking/types.ts` `CallTrackingProvider`); CallRail is one ADAPTER
(`calltracking/callrail-provider.ts`). The aggregation (`aggregate.ts`), sync loop (`sync.ts`), storage,
the LLM lead classifier, and the three-state reads sit ON TOP of the port and are vendor-neutral.

- Select the vendor with `CALL_TRACKING_PROVIDER` (default `callrail`). Factory `getCallTrackingProvider(repos)`
  resolves the key and builds the adapter, throwing `CallTrackingNotConfigured` when unconfigured.
- Adapters map their calls into the normalized `TrackedCall` (vendor lead concepts → `qualifiedLead`/
  `firstTimeCaller` booleans; raw `leadStatus` kept for detail), so aggregation is provider-agnostic.
- `callrail.ts` is now a thin backward-compatible FACADE — existing routes/crons/tests are unchanged;
  `syncCallRail` honors `CALL_TRACKING_PROVIDER` and delegates to the generic `syncCallTracking`.
- Add a vendor (CallTrackingMetrics, Twilio, …): write `calltracking/<vendor>-provider.ts` implementing
  `CallTrackingProvider`, add a `case` in `calltracking/index.ts`. Nothing above the port changes.
- Storage keeps its `callrail_*` collection names (a legacy label for the vendor-neutral call store,
  like `seo_site_configs` for SEO) — the swap happens at the fetch boundary, not in storage.

## Pluggable paid-ads platforms (multi-platform port)

Meta and Google Ads are DIFFERENT platforms you run together (not interchangeable vendors), so this is a
MULTI-PLATFORM port (`src/lib/ads/types.ts` `PaidAdsProvider`) — a registry of adapters, not a single
swap. Each platform implements the port at the level they share, returning a normalized `AdInsights`
(spend/impressions/leads/cpl common; clicks/ctr/cpc optional — undefined when a platform, e.g. LSA,
doesn't measure them, never a fake 0).

- Adapters: `ads/meta-provider.ts` (reuses meta.ts + BUG-07), `ads/google-ads-provider.ts` (reads via
  the LsaGateway). Registry: `getAdsProvider(platform, repos)`; `listAdPlatforms()`.
- `combineAdInsights([...])` rolls platforms into one cross-platform total — the unified-schema payoff.
- Route: `GET /api/v1/ads/insights?account=&from=&to=[&platform=]`. With `platform`: that platform's
  insights (501 if its creds are missing). Without: a rollup across all platforms (per-platform account
  from `account_<platform>` params), reporting per-platform errors distinctly.
- Platform-specific richness (LSA lead types/charge buckets, Meta campaigns) stays in the concrete
  connectors, OUTSIDE the shared port. The heavy google-ads-api SDK is dynamic-imported only when the
  google_ads platform is actually built.

## Deviations from the doc (your changes)

- **MongoDB** replaces the doc's Supabase/Postgres DDL (B3). Tenant isolation is enforced by
  `orgId`-scoped repos (`repos(orgId)`), not Postgres RLS. The doc's idempotent conflict keys and
  partial-unique constraints are Mongo unique indexes in `src/lib/db/mongo/bootstrap.ts`.
- **Provider-agnostic LLM** (`src/lib/llm/*`) replaces the Anthropic-only CallRail classifier.
- **Vault** uses a versioned `v1/v2` AAD-bound blob (§5 semantics preserved: AES-256-GCM, server-side
  decrypt only) instead of the doc's raw `[IV|tag|ct]` layout.
- **SEMrush reads** return explicit `present/absent/error` instead of the doc's "degrade to null/[]",
  to honor the non-negotiable §12 invariant. `throwOnUnits` still raises `SemrushUnitsError`.

## Per-request setup (read API)

```ts
// app/api/v1/[source]/metrics/route.ts
import { NextRequest, NextResponse } from "next/server"
import { repos } from "@/lib/db"
import { tokenAccessControl } from "@/lib/hub-app/adapters"
import { handleMetricsRead } from "@/lib/hub-app/handlers"

export async function GET(req: NextRequest, { params }: { params: { source: string } }) {
  const access = tokenAccessControl(/* your session/JWT layer */ {})
  const session = await access.authenticate(req.headers.get("authorization"))
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  const url = new URL(req.url)
  const ctx = { session, repos: repos(session.orgId) } // <-- tenant isolation (RLS replacement)
  const { status, body } = await handleMetricsRead(ctx, {
    source: params.source,
    clientId: url.searchParams.get("client") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  })
  return NextResponse.json(body, { status })
}
```

Three-state -> HTTP: `present` 200 `{data}`, `absent` 404 `{error:"not_connected"}`, `error` 502
`{error}`. A read failure is NEVER a 200 with fake zeros.

Snapshot-backed sources served by `handleMetricsRead`: `callrail`, `ga4`, `gbp`, `lsa`, `meta`,
`stripe`. Live sources (`gsc`, `semrush`) read through their own endpoints that construct a
credentialed gateway (see "Live wiring" below).

## Crons (doc §8 / B7 schedule)

```ts
// app/api/cron/callrail/route.ts
import { verifyCronSecret, runCallRailCron } from "@/lib/hub-app/cron"
import { repos } from "@/lib/db"
import { listOrgIds } from "@/lib/tenants" // your tenant lister

export async function GET(req: Request) {
  if (!verifyCronSecret(req.headers.get("authorization"))) return new Response("forbidden", { status: 403 })
  const summary = await runCallRailCron({ orgIds: await listOrgIds(), makeRepos: repos })
  return Response.json(summary)
}
```

| Path | Schedule | Runner |
|---|---|---|
| `/api/cron/callrail` | `*/30 * * * *` | `runCallRailCron` |
| `/api/cron/ga4` | `0 4 * * *` | `runGa4Cron` (needs a GA4 gateway) |
| `/api/cron/gbp` | `0 5 * * *` | `runGbpCron` (needs a fetcher) |
| `/api/cron/lsa` | `0 6 * * *` | `runLsaCron` (needs a Google Ads gateway) |
| `/api/cron/fb-ads` | `0 * * * *` | `runMetaCron` (needs a fetcher) |
| `/api/cron/semrush-projects` | `0 4 * * *` | `syncSemrushProjects` (needs the project list) |
| `/api/cron/stripe-sync` | `0 7 * * *` | `runStripeCron` (needs a Stripe gateway) |

Every cron route is guarded by `CRON_SECRET`. Each runner sweeps tenants; a per-tenant failure is
counted (`partial`) and never wipes stored data.

## Live wiring (needs real credentials — not built here)

The external SDK clients are behind injectable seams (`Fetcher`, `Ga4Gateway`, `LsaGateway`,
`StripeGateway`) so the deterministic logic is fully tested with fakes. Production entrypoints build
the real clients:

- **GA4**: ✅ WIRED. `src/lib/ga4-gateway.ts` implements `makeGa4Gateway` over `@google-analytics/data`
  `BetaAnalyticsDataClient.runReport`; `mapGa4Rows` flattens the response and `classifyGa4Error` maps
  gRPC codes (7→PERMISSION_DENIED, 5→NOT_FOUND) onto the typed `Ga4ApiError` the connector's
  deactivate-vs-retry discipline acts on. `buildGa4Gateway()` builds it from `GA4_SERVICE_ACCOUNT_JSON`
  or `GA4_SERVICE_ACCOUNT_PATH` (throws `GatewayNotConfigured` → 501 if neither is set). `/api/cron/ga4`
  is live given the service account.
- **GSC**: ✅ WIRED. `src/lib/gsc-gateway.ts` implements `makeGscGateway` over
  `@googleapis/searchconsole` `searchanalytics.query`; `mapGscRows` maps rows and `classifyGscError`
  maps 403/permission onto `GscApiError("PERMISSION_DENIED")` (surfaced as an error, never a fake zero).
  `buildGscGateway()` reuses the GA4 service account with scope `webmasters.readonly` (throws
  `GatewayNotConfigured` → 501 if unset). GSC is read live via its own route `GET /api/v1/gsc/metrics`
  (no cron — §4.4).
- **LSA**: ✅ WIRED. `src/lib/lsa-gateway.ts` implements `makeLsaGateway` over `google-ads-api`
  `Customer.query`; `leadsGaql`/`dailyMetricsGaql` build the B4 GAQL and `mapLead`/`mapDailyMetric`
  normalize rows. `buildLsaGateway()` uses `GOOGLE_ADS_CLIENT_ID/SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`,
  and `GOOGLE_ADS_REFRESH_TOKEN` (agency/MCC). For per-tenant refresh tokens, resolve from the vault and
  call `buildLsaGatewayWithToken({...})` per org instead. A gateway query failure is thrown → the
  connector treats it as transient (LSA-02: keeps prior status, self-heals), never a deactivation.
  `/api/cron/lsa` is live given the credentials.
- **Meta / GBP**: the `Fetcher` default already hits Graph/Business-Profile REST; supply the resolved
  access token (GBP mints it via `getAccessToken`; Meta via `getMetaAccessToken`).
- **Stripe**: ✅ WIRED. `src/lib/stripe-gateway.ts` implements `makeStripeGateway` over the `stripe`
  SDK (`subscriptions.list({status:"all", limit:100, expand:["data.customer","data.items.data.price",
  "data.discounts"]})`, pagination resolved, `maxNetworkRetries:3`). `buildStripeGateway()` builds it
  from `STRIPE_SECRET_KEY` (throws `GatewayNotConfigured` → 501 if unset). The `/api/cron/stripe-sync`
  route is live given the key.
- **Google Sheets destination**: ✅ WIRED. `src/lib/destinations/sheets.ts` maps rollup rows → a cell
  grid (`rollupToValues`) and appends via an injectable `SheetsAppendFn`; `sheets-live.ts` builds the
  real `@googleapis/sheets` client from the GA4 service account (scope `spreadsheets`) — the target
  sheet must be shared with the service-account email. `buildDestination` dynamic-imports the live
  builder only when a `sheets` destination is used (or a `setSheetsAppender` DI override is present).
- **BigQuery destination**: ✅ WIRED. `src/lib/destinations/bigquery.ts` stamps each rollup row with
  `orgId`+`clientId` (`rollupToBigQueryRows`) and streams via an injectable `BigQueryInsertFn`;
  `bigquery-live.ts` builds the real `@google-cloud/bigquery` client from the GA4 service account and
  inserts into `projectId.datasetId.tableId`. Config: `{ datasetId, tableId, projectId? }`. Dynamic-
  imported only when a `bigquery` destination is used (or `setBigQueryInserter` is set). All three
  destinations (webhook, Sheets, BigQuery) are now live.
- **CallRail / SEMrush**: ✅ pure REST via the built-in `Fetcher` — no SDK needed. The SEMrush data
  reads (overview/backlinks/keywords/units) and the project-list source (`makeSemrushProjectSource`,
  wired via `buildSemrushProjectSource()` from `SEMRUSH_API_KEY`) are fully live. The project source
  THROWS on any fetch failure so `syncSemrushProjects` never prunes to empty on a transient error.

Verify each request/response against current API docs before shipping (these APIs drift, per the doc).
