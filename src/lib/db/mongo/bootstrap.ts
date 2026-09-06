// NEW (your change): index bootstrap. The doc's idempotent conflict keys and partial-unique
// constraints (B3 DDL) become Mongo unique indexes here. Scoped by orgId so tenant isolation holds.
// Run: npm run db:init
import type { Db } from "mongodb"
import { COLLECTIONS, getDb } from "./client"

export async function bootstrapIndexes(db: Db): Promise<void> {
  // Identity backbone (not org-scoped)
  await db.collection(COLLECTIONS.orgs).createIndex({ orgId: 1 }, { unique: true })
  await db.collection(COLLECTIONS.users).createIndex({ email: 1 }, { unique: true })
  await db.collection(COLLECTIONS.users).createIndex({ userId: 1 }, { unique: true })
  await db.collection(COLLECTIONS.apiKeys).createIndex({ keyHash: 1 }, { unique: true })
  await db.collection(COLLECTIONS.apiKeys).createIndex({ orgId: 1 })
  await db.collection(COLLECTIONS.sessions).createIndex({ tokenHash: 1 }, { unique: true })
  await db.collection(COLLECTIONS.sessions).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
  await db.collection(COLLECTIONS.oauthStates).createIndex({ state: 1 }, { unique: true })
  await db.collection(COLLECTIONS.oauthStates).createIndex({ createdAt: 1 }, { expireAfterSeconds: 900 })
  await db.collection(COLLECTIONS.usageCounters).createIndex({ orgId: 1, provider: 1, window: 1 }, { unique: true })
  await db.collection(COLLECTIONS.destinations).createIndex({ orgId: 1, destinationId: 1 }, { unique: true })
  await db.collection(COLLECTIONS.crossSourceRollups).createIndex({ orgId: 1, clientId: 1, date: 1 }, { unique: true })

  // Tenant identity
  await db.collection(COLLECTIONS.clients).createIndex({ orgId: 1, clientId: 1 }, { unique: true })

  // Credential vault — mirrors the doc's partial unique indexes:
  //   UNIQUE(provider) where scope='agency'; UNIQUE(client_id, provider) where scope='client'.
  await db
    .collection(COLLECTIONS.integrations)
    .createIndex({ orgId: 1, provider: 1 }, { unique: true, partialFilterExpression: { scope: "agency" } })
  await db
    .collection(COLLECTIONS.integrations)
    .createIndex({ orgId: 1, clientId: 1, provider: 1 }, { unique: true, partialFilterExpression: { scope: "client" } })

  await db.collection(COLLECTIONS.syncLog).createIndex({ orgId: 1, source: 1, createdAt: -1 })

  // CallRail: UNIQUE(client_id) and UNIQUE(callrail_company_id); snapshot key (company, date); call id.
  await db.collection(COLLECTIONS.callrailMappings).createIndex({ orgId: 1, clientId: 1 }, { unique: true })
  await db.collection(COLLECTIONS.callrailMappings).createIndex({ orgId: 1, callrailCompanyId: 1 }, { unique: true })
  await db
    .collection(COLLECTIONS.callrailSnapshots)
    .createIndex({ orgId: 1, callrailCompanyId: 1, snapshotDate: 1 }, { unique: true })
  await db.collection(COLLECTIONS.callrailCalls).createIndex({ orgId: 1, callrailCallId: 1 }, { unique: true })

  // GA4: UNIQUE(client_id) mapping; snapshot key (client_id, snapshot_date); property snapshot key
  // (ga4_property_id, snapshot_date) with a nullable client_id; discovery keyed property_id.
  await db.collection(COLLECTIONS.ga4Mappings).createIndex({ orgId: 1, clientId: 1 }, { unique: true })
  await db.collection(COLLECTIONS.ga4Snapshots).createIndex({ orgId: 1, clientId: 1, snapshotDate: 1 }, { unique: true })
  await db.collection(COLLECTIONS.ga4PropertySnapshots).createIndex({ orgId: 1, ga4PropertyId: 1, snapshotDate: 1 }, { unique: true })
  await db.collection(COLLECTIONS.ga4Properties).createIndex({ orgId: 1, propertyId: 1 }, { unique: true })

  // GBP: UNIQUE(client_id, location_id) mapping (multi-location); snapshot + review keys the same;
  // discovery keyed location_id.
  await db.collection(COLLECTIONS.gbpMappings).createIndex({ orgId: 1, clientId: 1, locationId: 1 }, { unique: true })
  await db.collection(COLLECTIONS.gbpSnapshots).createIndex({ orgId: 1, clientId: 1, locationId: 1, snapshotDate: 1 }, { unique: true })
  await db.collection(COLLECTIONS.gbpReviewSnapshots).createIndex({ orgId: 1, clientId: 1, locationId: 1, snapshotDate: 1 }, { unique: true })
  await db.collection(COLLECTIONS.gbpLocations).createIndex({ orgId: 1, locationId: 1 }, { unique: true })

  // GSC: UNIQUE(client_id) mapping. No snapshot table (live reads).
  await db.collection(COLLECTIONS.gscMappings).createIndex({ orgId: 1, clientId: 1 }, { unique: true })

  // LSA: UNIQUE(customer_id) and UNIQUE(client_id, customer_id); snapshot key (customer_id, date);
  // per-lead key (customer_id, lead_id).
  await db.collection(COLLECTIONS.lsaMappings).createIndex({ orgId: 1, googleAdsCustomerId: 1 }, { unique: true })
  await db.collection(COLLECTIONS.lsaMappings).createIndex({ orgId: 1, clientId: 1, googleAdsCustomerId: 1 }, { unique: true })
  await db.collection(COLLECTIONS.lsaLeadSnapshots).createIndex({ orgId: 1, googleAdsCustomerId: 1, date: 1 }, { unique: true })
  await db.collection(COLLECTIONS.lsaLeads).createIndex({ orgId: 1, googleAdsCustomerId: 1, leadId: 1 }, { unique: true })

  // Meta: fb_account_id UNIQUE and UNIQUE(client_id); overview key (fb_account_id, date_range).
  await db.collection(COLLECTIONS.fbMappings).createIndex({ orgId: 1, fbAccountId: 1 }, { unique: true })
  await db.collection(COLLECTIONS.fbMappings).createIndex({ orgId: 1, clientId: 1 }, { unique: true })
  await db.collection(COLLECTIONS.fbOverviewSnapshots).createIndex({ orgId: 1, fbAccountId: 1, dateRange: 1 }, { unique: true })
  await db.collection(COLLECTIONS.fbAccountTargets).createIndex({ orgId: 1, fbAccountId: 1 }, { unique: true })

  // SEMrush: domain-based mapping UNIQUE(client_id); discovery keyed project_id.
  await db.collection(COLLECTIONS.seoSiteConfigs).createIndex({ orgId: 1, clientId: 1 }, { unique: true })
  await db.collection(COLLECTIONS.seoSiteConfigs).createIndex({ orgId: 1, domain: 1 })
  await db.collection(COLLECTIONS.semrushProjects).createIndex({ orgId: 1, projectId: 1 }, { unique: true })

  // Stripe: subscription id; singleton overview cache; client override mapping.
  await db.collection(COLLECTIONS.stripeSubscriptions).createIndex({ orgId: 1, subscriptionId: 1 }, { unique: true })
  await db.collection(COLLECTIONS.stripeOverviewCache).createIndex({ orgId: 1 }, { unique: true })
  await db.collection(COLLECTIONS.clientStripeMappings).createIndex({ orgId: 1, clientId: 1 }, { unique: true })
}

// Allow `npm run db:init` to run this directly.
if (process.argv[1] && process.argv[1].endsWith("bootstrap.ts")) {
  bootstrapIndexes(getDb())
    .then(() => {
      console.log("indexes bootstrapped")
      process.exit(0)
    })
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
