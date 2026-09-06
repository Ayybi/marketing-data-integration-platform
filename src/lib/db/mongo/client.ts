// NEW (your change): MongoDB connection, replacing the Supabase/Postgres client. The official driver
// has no WebSocket dependency, so the doc's "Node 20 gotcha" (@supabase/supabase-js) does not apply.
import { MongoClient, type Db } from "mongodb"

let client: MongoClient | null = null
let db: Db | null = null

export function getDb(): Db {
  if (db) return db
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error("MONGODB_URI is not set")
  client = new MongoClient(uri)
  db = client.db(process.env.MONGODB_DB ?? "marketing_data_hub")
  return db
}

// Test/DI hook: inject a Db (e.g. a local mongod).
export function setDb(injected: Db | null): void {
  db = injected
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close()
    client = null
    db = null
  }
}

// Collection names. Per-connector mapping/snapshot tables from the doc's data model (§9) become
// collections; every org-scoped doc carries `orgId` for tenant isolation (RLS replacement).
export const COLLECTIONS = {
  // Identity backbone (NOT org-scoped — this is the auth layer).
  orgs: "orgs",
  users: "users",
  apiKeys: "api_keys",
  sessions: "auth_sessions",
  oauthStates: "oauth_states",
  usageCounters: "usage_counters",
  destinations: "destinations",
  crossSourceRollups: "cross_source_rollups",
  // Tenant identity (the doc's `clients` prerequisite) + shared infra.
  clients: "clients",
  integrations: "integrations", // encrypted credential vault store (§5)
  syncLog: "sync_log", // run status + bounded error sample (§6)
  // CallRail (§4.1)
  callrailMappings: "callrail_account_mappings",
  callrailSnapshots: "callrail_snapshots",
  callrailCalls: "callrail_calls",
  callrailNumberLabels: "callrail_number_labels",
  // GA4 (§4.2)
  ga4Mappings: "ga4_property_mappings",
  ga4Snapshots: "ga4_snapshots",
  ga4PropertySnapshots: "ga4_property_snapshots",
  ga4Properties: "ga4_properties",
  // GBP (§4.3)
  gbpMappings: "gbp_location_mappings",
  gbpSnapshots: "gbp_snapshots",
  gbpReviewSnapshots: "gbp_review_snapshots",
  gbpLocations: "gbp_locations",
  // GSC (§4.4) — live reads, no snapshot table
  gscMappings: "gsc_property_mappings",
  // LSA / Google Ads (§4.5)
  lsaMappings: "lsa_account_mappings",
  lsaLeadSnapshots: "lsa_lead_snapshots",
  lsaLeads: "lsa_leads",
  // Meta / Facebook (§4.6)
  fbMappings: "fb_account_mappings",
  fbOverviewSnapshots: "fb_overview_snapshots",
  fbAccountTargets: "fb_account_targets",
  // SEMrush (§4.7)
  semrushProjects: "semrush_projects",
  seoSiteConfigs: "seo_site_configs",
  // Stripe (§4.8)
  stripeSubscriptions: "stripe_subscriptions",
  stripeOverviewCache: "stripe_overview_cache",
  clientStripeMappings: "client_stripe_mappings",
} as const
