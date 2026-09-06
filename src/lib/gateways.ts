// NEW: the LIVE-WIRING seam. The SDK-backed connectors (GA4, GSC, LSA, Stripe) call third-party SDKs
// that need real credentials and drift over time, so their gateways are constructed here. Until you
// wire the real SDK, these throw GatewayNotConfigured — the cron/route catches it and returns 501
// rather than silently doing nothing. This keeps the "failure != absence" contract at the seam.
//
// See WIRING.md "Live wiring" for exactly which SDK call each gateway wraps.
import Stripe from "stripe"
import { BetaAnalyticsDataClient } from "@google-analytics/data"
import { AnalyticsAdminServiceClient } from "@google-analytics/admin"
import { searchconsole, auth as gscAuthNs } from "@googleapis/searchconsole"
import { GoogleAdsApi } from "google-ads-api"
import type { Ga4Gateway } from "./ga4"
import { resolveGa4ServiceAccount } from "./ga4"
import type { GscGateway } from "./gsc"
import type { LsaGateway } from "./lsa"
import type { StripeGateway } from "./stripe"
import { makeSemrushProjectSource, type RawSemrushProject } from "./semrush"
import { defaultFetcher } from "./http"
import { makeStripeGateway, type StripeSubListClient } from "./stripe-gateway"
import { makeGa4Gateway, type Ga4RunReportFn } from "./ga4-gateway"
import type { Ga4AdminGateway, DiscoveredGa4Property } from "./discovery/sync"
import { makeGscGateway, type GscQueryFn } from "./gsc-gateway"
import { makeLsaGateway, type LsaQueryFn } from "./lsa-gateway"

export class GatewayNotConfigured extends Error {
  constructor(readonly gateway: string) {
    super(`${gateway} gateway not configured — implement it in src/lib/gateways.ts (see WIRING.md "Live wiring")`)
    this.name = "GatewayNotConfigured"
  }
}

// Each factory returns the injectable gateway the connector expects. Replace the throw with a real SDK
// client. Signatures are fixed so the connectors and crons need no changes when you wire them.

// BYO helper: resolve GA4/GCP service-account credentials. A per-tenant `saJson` (from the vault) wins;
// otherwise fall back to the shared env service account (JSON or key file). Returns null when neither
// is configured so the builder can raise GatewayNotConfigured.
type GoogleCreds = { keyFilename?: string; credentials?: { client_email?: string; private_key?: string; project_id?: string } }
function googleServiceAccount(saJson?: string): GoogleCreds | null {
  if (saJson) {
    try {
      const c = JSON.parse(saJson) as { client_email?: string; private_key?: string; project_id?: string }
      return { credentials: { client_email: c.client_email, private_key: c.private_key, project_id: c.project_id } }
    } catch (e) {
      throw new Error(`service account json unparseable: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const keyFilename = process.env.GA4_SERVICE_ACCOUNT_PATH
  const sa = resolveGa4ServiceAccount()
  if (!keyFilename && sa.status === "absent") return null
  if (sa.status === "error") throw new Error(`service account unparseable: ${sa.error}`)
  const creds = sa.status === "present" ? (sa.value as { client_email?: string; private_key?: string; project_id?: string }) : undefined
  return keyFilename ? { keyFilename } : { credentials: { client_email: creds?.client_email, private_key: creds?.private_key, project_id: creds?.project_id } }
}

export function buildGa4Gateway(saJson?: string): Ga4Gateway {
  const c = googleServiceAccount(saJson)
  if (!c) throw new GatewayNotConfigured("GA4") // no creds -> 501
  const client = c.keyFilename ? new BetaAnalyticsDataClient({ keyFilename: c.keyFilename }) : new BetaAnalyticsDataClient({ credentials: c.credentials })
  // client.runReport resolves to the gax tuple [response, ...]; matches Ga4RunReportFn.
  const run: Ga4RunReportFn = (request) => client.runReport(request as never) as ReturnType<Ga4RunReportFn>
  return makeGa4Gateway(run)
}

/** Live GA4 Admin gateway for property discovery (§7) — lists property summaries and enriches each with
 *  its web stream's URL (best-effort) so tenants can auto-match by domain. */
export function buildGa4AdminGateway(saJson?: string): Ga4AdminGateway {
  const c = googleServiceAccount(saJson)
  if (!c) throw new GatewayNotConfigured("GA4 Admin")
  const client = c.keyFilename ? new AnalyticsAdminServiceClient({ keyFilename: c.keyFilename }) : new AnalyticsAdminServiceClient({ credentials: c.credentials })

  return {
    async listProperties(): Promise<DiscoveredGa4Property[]> {
      const [summaries] = await client.listAccountSummaries({})
      const out: DiscoveredGa4Property[] = []
      for (const acc of summaries ?? []) {
        for (const prop of acc.propertySummaries ?? []) {
          const propertyId = String(prop.property ?? "").replace(/^properties\//, "")
          if (!propertyId) continue
          let websiteUri: string | undefined
          try {
            const [streams] = await client.listDataStreams({ parent: `properties/${propertyId}` })
            websiteUri = (streams ?? []).map((s) => s.webStreamData?.defaultUri ?? undefined).find(Boolean)
          } catch {
            // best-effort: leave websiteUri undefined; manual mapping still works
          }
          out.push({ propertyId, displayName: prop.displayName ?? undefined, accountId: acc.account ?? undefined, websiteUri })
        }
      }
      return out
    },
  }
}

export function buildGscGateway(saJson?: string): GscGateway {
  // Reuses the GA4 service account with a single read-only scope (§4.4).
  const c = googleServiceAccount(saJson)
  if (!c) throw new GatewayNotConfigured("GSC") // no creds -> 501
  const scopes = ["https://www.googleapis.com/auth/webmasters.readonly"]
  const googleAuth = c.keyFilename
    ? new gscAuthNs.GoogleAuth({ keyFile: c.keyFilename, scopes })
    : new gscAuthNs.GoogleAuth({ credentials: { client_email: c.credentials?.client_email, private_key: c.credentials?.private_key }, scopes })
  const client = searchconsole({ version: "v1", auth: googleAuth as never })
  const query: GscQueryFn = (params) => client.searchanalytics.query(params) as unknown as ReturnType<GscQueryFn>
  return makeGscGateway(query)
}

export function buildLsaGateway(): LsaGateway {
  const client_id = process.env.GOOGLE_ADS_CLIENT_ID
  const client_secret = process.env.GOOGLE_ADS_CLIENT_SECRET
  const developer_token = process.env.GOOGLE_ADS_DEVELOPER_TOKEN
  // Agency (MCC) refresh token. For per-tenant tokens, resolve from the vault and build per-org
  // (buildLsaGatewayWithToken) instead of relying on this env default — see WIRING.md.
  const refresh_token = process.env.GOOGLE_ADS_REFRESH_TOKEN
  if (!client_id || !client_secret || !developer_token || !refresh_token) throw new GatewayNotConfigured("LSA")
  return buildLsaGatewayWithToken({ client_id, client_secret, developer_token, refresh_token })
}

/** Build an LSA gateway from explicit credentials (lets a caller supply a per-tenant refresh token). */
export function buildLsaGatewayWithToken(creds: {
  client_id: string
  client_secret: string
  developer_token: string
  refresh_token: string
}): LsaGateway {
  const api = new GoogleAdsApi({ client_id: creds.client_id, client_secret: creds.client_secret, developer_token: creds.developer_token })
  const runQuery: LsaQueryFn = async ({ customerId, loginCustomerId, gaql }) => {
    const customer = api.Customer({ customer_id: customerId, login_customer_id: loginCustomerId, refresh_token: creds.refresh_token })
    return (await customer.query(gaql)) as Array<Record<string, unknown>>
  }
  return makeLsaGateway(runQuery)
}

export function buildStripeGateway(secretKey?: string): StripeGateway {
  const key = secretKey || process.env.STRIPE_SECRET_KEY // BYO: tenant key wins over the shared env key
  if (!key) throw new GatewayNotConfigured("Stripe") // no key -> 501, never a silent empty sync
  // maxNetworkRetries: 3 per doc §4.8 (bounded retry for load-bearing reads).
  const stripe = new Stripe(key, { maxNetworkRetries: 3 })
  return makeStripeGateway(stripe as unknown as StripeSubListClient)
}

/** Fetches the SEMrush project list (management API, JSON). Throws GatewayNotConfigured -> 501 if no key. */
export function buildSemrushProjectSource(): () => Promise<RawSemrushProject[]> {
  const key = process.env.SEMRUSH_API_KEY
  if (!key) throw new GatewayNotConfigured("SEMrush projects")
  return makeSemrushProjectSource(defaultFetcher, key)
}
