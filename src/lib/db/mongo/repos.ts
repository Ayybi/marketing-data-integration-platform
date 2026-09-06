// NEW (your change): Mongo implementation of the org-scoped repos. Tenant isolation = every query is
// filtered by orgId; a caller can only obtain a handle already bound to one org (see ../index.ts).
//
// Three-state DB reads (§12): a genuine not-found is `absent`; a DRIVER error is `error` and never
// masquerades as absent/empty. Every read wraps the driver call in try/catch to honor this.
import type { Db } from "mongodb"
import { COLLECTIONS } from "./client"
import { decryptMaybe, integrationAad } from "../../integrations/vault"
import type {
  Repos,
  ClientRepo,
  CredentialRepo,
  SyncLogRepo,
  CallRailRepo,
  Ga4Repo,
  GbpRepo,
  GscRepo,
  LsaRepo,
  FbRepo,
  SemrushRepo,
  StripeRepo,
  RollupRepo,
  DestinationRepo,
  ClientRow,
  IntegrationRow,
  CallRailMappingRow,
  CallRailSnapshotRow,
  CallRailCallRow,
  Ga4MappingRow,
  Ga4SnapshotRow,
  Ga4PropertyRow,
  GbpMappingRow,
  GbpSnapshotRow,
  GbpReviewSnapshotRow,
  GbpLocationRow,
  GscMappingRow,
  LsaMappingRow,
  LsaSnapshotRow,
  LsaLeadRow,
  FbMappingRow,
  FbOverviewSnapshotRow,
  SeoSiteConfigRow,
  SemrushProjectRow,
  StripeSubscriptionRow,
  StripeOverviewRow,
  CrossSourceRollupRow,
  DestinationRow,
  ReadResult,
} from "../types"
import { normalizeDomain } from "../../helpers"
import type { SyncLogEntry } from "../../sync-log"

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function makeMongoRepos(db: Db, orgId: string): Repos {
  if (!orgId) throw new Error("makeMongoRepos: orgId is required (tenant isolation)")

  const clients: ClientRepo = {
    async activeClientIds() {
      const rows = await db
        .collection<ClientRow>(COLLECTIONS.clients)
        .find({ orgId, status: { $ne: "cancel" }, deletedAt: { $in: [null, undefined] } })
        .project({ clientId: 1 })
        .toArray()
      return rows.map((r) => (r as { clientId: string }).clientId)
    },
    async upsert(row) {
      await db
        .collection<ClientRow>(COLLECTIONS.clients)
        .updateOne({ orgId, clientId: row.clientId }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async get(clientId) {
      try {
        const row = await db.collection<ClientRow>(COLLECTIONS.clients).findOne({ orgId, clientId })
        return row ? { status: "present", value: row } : { status: "absent" }
      } catch (e) {
        return { status: "error", error: errText(e) }
      }
    },
  }

  const credentials: CredentialRepo = {
    async resolve(provider, scope, clientId): Promise<ReadResult<string>> {
      let row: IntegrationRow | null
      try {
        row = await db
          .collection<IntegrationRow>(COLLECTIONS.integrations)
          .findOne(scope === "agency" ? { orgId, scope, provider } : { orgId, scope, provider, clientId: clientId ?? null })
      } catch (e) {
        return { status: "error", error: errText(e) } // driver failure != absent
      }
      if (!row || !row.authPayload) return { status: "absent" }
      // Decrypt at the seam; a tamper/wrong-key failure is ERROR, never absent.
      return decryptMaybe(row.authPayload, integrationAad(scope, provider, clientId))
    },
    async save(row) {
      const filter =
        row.scope === "agency"
          ? { orgId, scope: "agency" as const, provider: row.provider }
          : { orgId, scope: "client" as const, provider: row.provider, clientId: row.clientId ?? null }
      await db.collection<IntegrationRow>(COLLECTIONS.integrations).updateOne(filter, { $set: { ...row, orgId } }, { upsert: true })
    },
    async setStatus(provider, scope, status, lastError, clientId) {
      const filter =
        scope === "agency"
          ? { orgId, scope: "agency" as const, provider }
          : { orgId, scope: "client" as const, provider, clientId: clientId ?? null }
      await db
        .collection<IntegrationRow>(COLLECTIONS.integrations)
        .updateOne(filter, { $set: { status, lastError, orgId } }, { upsert: false })
    },
    async isConfigured(provider, scope, clientId) {
      const r = await this.resolve(provider, scope, clientId)
      return r.status === "present"
    },
    async listProviders() {
      const filter = { orgId, authPayload: { $exists: true, $nin: [null, ""] } } as unknown as Parameters<
        ReturnType<typeof db.collection<IntegrationRow>>["find"]
      >[0]
      const rows = await db.collection<IntegrationRow>(COLLECTIONS.integrations).find(filter).project({ provider: 1 }).toArray()
      return [...new Set(rows.map((r) => (r as { provider: string }).provider))]
    },
  }

  const syncLog: SyncLogRepo = {
    async write(entry: SyncLogEntry) {
      await db.collection<SyncLogEntry & { orgId: string }>(COLLECTIONS.syncLog).insertOne({ ...entry, orgId })
    },
    async recent(source, limit) {
      const rows = await db
        .collection<SyncLogEntry & { orgId: string }>(COLLECTIONS.syncLog)
        .find({ orgId, source })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray()
      return rows.map(({ orgId: _o, _id, ...rest }: any) => rest as SyncLogEntry)
    },
  }

  const callrail: CallRailRepo = {
    async activeMappings() {
      return db
        .collection<CallRailMappingRow>(COLLECTIONS.callrailMappings)
        .find({ orgId, status: "active" })
        .toArray() as Promise<CallRailMappingRow[]>
    },
    async getMappingByClient(clientId) {
      try {
        const row = await db.collection<CallRailMappingRow>(COLLECTIONS.callrailMappings).findOne({ orgId, clientId })
        return row ? { status: "present", value: row } : { status: "absent" }
      } catch (e) {
        return { status: "error", error: errText(e) }
      }
    },
    async upsertMapping(row) {
      await db
        .collection<CallRailMappingRow>(COLLECTIONS.callrailMappings)
        .updateOne({ orgId, clientId: row.clientId }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async upsertSnapshot(row) {
      // Idempotent conflict key (callrailCompanyId, snapshotDate): re-running a day overwrites (§6).
      await db
        .collection<CallRailSnapshotRow>(COLLECTIONS.callrailSnapshots)
        .updateOne(
          { orgId, callrailCompanyId: row.callrailCompanyId, snapshotDate: row.snapshotDate },
          { $set: { ...row, orgId } },
          { upsert: true },
        )
    },
    async snapshotsForClient(clientId, from, to) {
      return db
        .collection<CallRailSnapshotRow>(COLLECTIONS.callrailSnapshots)
        .find({ orgId, clientId, snapshotDate: { $gte: from, $lte: to } })
        .sort({ snapshotDate: 1 })
        .toArray() as Promise<CallRailSnapshotRow[]>
    },
    async upsertCall(row) {
      await db
        .collection<CallRailCallRow>(COLLECTIONS.callrailCalls)
        .updateOne({ orgId, callrailCallId: row.callrailCallId }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async unclassifiedQualifiedCalls(limit) {
      // Qualified calls with a transcription but no AI class yet (best-effort post-sync pass, §4.1).
      const filter = {
        orgId,
        leadStatus: "good_lead",
        aiClass: { $in: [null, undefined] },
        transcription: { $nin: [null, "", undefined] },
      } as unknown as Parameters<ReturnType<typeof db.collection<CallRailCallRow>>["find"]>[0]
      return db.collection<CallRailCallRow>(COLLECTIONS.callrailCalls).find(filter).limit(limit).toArray() as Promise<CallRailCallRow[]>
    },
    async setCallClass(callrailCallId, aiClass) {
      await db
        .collection<CallRailCallRow>(COLLECTIONS.callrailCalls)
        .updateOne({ orgId, callrailCallId }, { $set: { aiClass } })
    },
  }

  const ga4: Ga4Repo = {
    async activeMappings() {
      return db.collection<Ga4MappingRow>(COLLECTIONS.ga4Mappings).find({ orgId, status: "active" }).toArray() as Promise<Ga4MappingRow[]>
    },
    async getMappingByClient(clientId) {
      try {
        const row = await db.collection<Ga4MappingRow>(COLLECTIONS.ga4Mappings).findOne({ orgId, clientId })
        return row ? { status: "present", value: row } : { status: "absent" }
      } catch (e) {
        return { status: "error", error: errText(e) }
      }
    },
    async upsertMapping(row) {
      await db.collection<Ga4MappingRow>(COLLECTIONS.ga4Mappings).updateOne({ orgId, clientId: row.clientId }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async setMappingStatus(clientId, status) {
      await db.collection<Ga4MappingRow>(COLLECTIONS.ga4Mappings).updateOne({ orgId, clientId }, { $set: { status } })
    },
    async upsertSnapshot(row) {
      // Idempotent conflict key (client_id, snapshot_date): re-running a day overwrites (§6).
      await db
        .collection<Ga4SnapshotRow>(COLLECTIONS.ga4Snapshots)
        .updateOne({ orgId, clientId: row.clientId, snapshotDate: row.snapshotDate }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async snapshotsForClient(clientId, from, to) {
      return db
        .collection<Ga4SnapshotRow>(COLLECTIONS.ga4Snapshots)
        .find({ orgId, clientId, snapshotDate: { $gte: from, $lte: to } })
        .sort({ snapshotDate: 1 })
        .toArray() as Promise<Ga4SnapshotRow[]>
    },
    async upsertProperty(row) {
      await db.collection<Ga4PropertyRow>(COLLECTIONS.ga4Properties).updateOne({ orgId, propertyId: row.propertyId }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async listProperties() {
      return db.collection<Ga4PropertyRow>(COLLECTIONS.ga4Properties).find({ orgId }).toArray() as Promise<Ga4PropertyRow[]>
    },
  }

  const gbp: GbpRepo = {
    async activeMappings() {
      return db.collection<GbpMappingRow>(COLLECTIONS.gbpMappings).find({ orgId, status: "active" }).toArray() as Promise<GbpMappingRow[]>
    },
    async mappingsForClient(clientId) {
      return db.collection<GbpMappingRow>(COLLECTIONS.gbpMappings).find({ orgId, clientId }).toArray() as Promise<GbpMappingRow[]>
    },
    async upsertMapping(row) {
      await db
        .collection<GbpMappingRow>(COLLECTIONS.gbpMappings)
        .updateOne({ orgId, clientId: row.clientId, locationId: row.locationId }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async upsertSnapshot(row) {
      await db
        .collection<GbpSnapshotRow>(COLLECTIONS.gbpSnapshots)
        .updateOne({ orgId, clientId: row.clientId, locationId: row.locationId, snapshotDate: row.snapshotDate }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async snapshotsForClient(clientId, from, to) {
      return db
        .collection<GbpSnapshotRow>(COLLECTIONS.gbpSnapshots)
        .find({ orgId, clientId, snapshotDate: { $gte: from, $lte: to } })
        .sort({ snapshotDate: 1 })
        .toArray() as Promise<GbpSnapshotRow[]>
    },
    async upsertReviewSnapshot(row) {
      await db
        .collection<GbpReviewSnapshotRow>(COLLECTIONS.gbpReviewSnapshots)
        .updateOne({ orgId, clientId: row.clientId, locationId: row.locationId, snapshotDate: row.snapshotDate }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async latestReview(clientId, locationId) {
      try {
        const row = await db
          .collection<GbpReviewSnapshotRow>(COLLECTIONS.gbpReviewSnapshots)
          .find({ orgId, clientId, locationId })
          .sort({ snapshotDate: -1 })
          .limit(1)
          .next()
        return row ? { status: "present", value: row } : { status: "absent" }
      } catch (e) {
        return { status: "error", error: errText(e) }
      }
    },
    async upsertLocation(row) {
      await db.collection<GbpLocationRow>(COLLECTIONS.gbpLocations).updateOne({ orgId, locationId: row.locationId }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async listLocations() {
      return db.collection<GbpLocationRow>(COLLECTIONS.gbpLocations).find({ orgId }).toArray() as Promise<GbpLocationRow[]>
    },
  }

  const gsc: GscRepo = {
    async activeMappings() {
      return db.collection<GscMappingRow>(COLLECTIONS.gscMappings).find({ orgId, status: { $ne: "error" } }).toArray() as Promise<GscMappingRow[]>
    },
    async getMappingByClient(clientId) {
      try {
        const row = await db.collection<GscMappingRow>(COLLECTIONS.gscMappings).findOne({ orgId, clientId })
        return row ? { status: "present", value: row } : { status: "absent" }
      } catch (e) {
        return { status: "error", error: errText(e) }
      }
    },
    async upsertMapping(row) {
      await db.collection<GscMappingRow>(COLLECTIONS.gscMappings).updateOne({ orgId, clientId: row.clientId }, { $set: { ...row, orgId } }, { upsert: true })
    },
  }

  const lsa: LsaRepo = {
    async activeMappings() {
      return db
        .collection<LsaMappingRow>(COLLECTIONS.lsaMappings)
        .find({ orgId, status: { $nin: ["error", "suspended"] } })
        .toArray() as Promise<LsaMappingRow[]>
    },
    async upsertMapping(row) {
      await db
        .collection<LsaMappingRow>(COLLECTIONS.lsaMappings)
        .updateOne({ orgId, googleAdsCustomerId: row.googleAdsCustomerId }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async setMappingStatus(googleAdsCustomerId, status) {
      await db.collection<LsaMappingRow>(COLLECTIONS.lsaMappings).updateOne({ orgId, googleAdsCustomerId }, { $set: { status } })
    },
    async upsertSnapshot(row) {
      await db
        .collection<LsaSnapshotRow>(COLLECTIONS.lsaLeadSnapshots)
        .updateOne({ orgId, googleAdsCustomerId: row.googleAdsCustomerId, date: row.date }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async snapshotsForCustomer(googleAdsCustomerId, from, to) {
      return db
        .collection<LsaSnapshotRow>(COLLECTIONS.lsaLeadSnapshots)
        .find({ orgId, googleAdsCustomerId, date: { $gte: from, $lte: to } })
        .sort({ date: 1 })
        .toArray() as Promise<LsaSnapshotRow[]>
    },
    async upsertLead(row) {
      await db
        .collection<LsaLeadRow>(COLLECTIONS.lsaLeads)
        .updateOne({ orgId, googleAdsCustomerId: row.googleAdsCustomerId, leadId: row.leadId }, { $set: { ...row, orgId } }, { upsert: true })
    },
  }

  const fb: FbRepo = {
    async activeMappings() {
      return db.collection<FbMappingRow>(COLLECTIONS.fbMappings).find({ orgId, status: "active" }).toArray() as Promise<FbMappingRow[]>
    },
    async getMappingByClient(clientId) {
      try {
        const row = await db.collection<FbMappingRow>(COLLECTIONS.fbMappings).findOne({ orgId, clientId })
        return row ? { status: "present", value: row } : { status: "absent" }
      } catch (e) {
        return { status: "error", error: errText(e) }
      }
    },
    async upsertMapping(row) {
      await db.collection<FbMappingRow>(COLLECTIONS.fbMappings).updateOne({ orgId, fbAccountId: row.fbAccountId }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async upsertOverview(row) {
      await db
        .collection<FbOverviewSnapshotRow>(COLLECTIONS.fbOverviewSnapshots)
        .updateOne({ orgId, fbAccountId: row.fbAccountId, dateRange: row.dateRange }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async getOverview(fbAccountId, dateRange) {
      try {
        const row = await db.collection<FbOverviewSnapshotRow>(COLLECTIONS.fbOverviewSnapshots).findOne({ orgId, fbAccountId, dateRange })
        return row ? { status: "present", value: row } : { status: "absent" }
      } catch (e) {
        return { status: "error", error: errText(e) }
      }
    },
  }

  const semrush: SemrushRepo = {
    async resolveClientByDomain(domain) {
      try {
        const norm = normalizeDomain(domain)
        const row = await db.collection<SeoSiteConfigRow>(COLLECTIONS.seoSiteConfigs).findOne({ orgId, domain: norm })
        return row ? { status: "present", value: row } : { status: "absent" }
      } catch (e) {
        return { status: "error", error: errText(e) }
      }
    },
    async upsertSiteConfig(row) {
      await db
        .collection<SeoSiteConfigRow>(COLLECTIONS.seoSiteConfigs)
        .updateOne({ orgId, clientId: row.clientId }, { $set: { ...row, domain: normalizeDomain(row.domain), orgId } }, { upsert: true })
    },
    async listSiteConfigs() {
      return db.collection<SeoSiteConfigRow>(COLLECTIONS.seoSiteConfigs).find({ orgId, status: "active" }).toArray() as Promise<SeoSiteConfigRow[]>
    },
    async upsertProject(row) {
      await db.collection<SemrushProjectRow>(COLLECTIONS.semrushProjects).updateOne({ orgId, projectId: row.projectId }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async listProjects() {
      return db.collection<SemrushProjectRow>(COLLECTIONS.semrushProjects).find({ orgId }).toArray() as Promise<SemrushProjectRow[]>
    },
    async pruneProjectsNotIn(projectIds) {
      const res = await db.collection<SemrushProjectRow>(COLLECTIONS.semrushProjects).deleteMany({ orgId, projectId: { $nin: projectIds } })
      return res.deletedCount ?? 0
    },
  }

  const stripe: StripeRepo = {
    async countSubscriptions() {
      return db.collection<StripeSubscriptionRow>(COLLECTIONS.stripeSubscriptions).countDocuments({ orgId })
    },
    async upsertSubscription(row) {
      await db
        .collection<StripeSubscriptionRow>(COLLECTIONS.stripeSubscriptions)
        .updateOne({ orgId, subscriptionId: row.subscriptionId }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async allSubscriptions() {
      return db.collection<StripeSubscriptionRow>(COLLECTIONS.stripeSubscriptions).find({ orgId }).toArray() as Promise<StripeSubscriptionRow[]>
    },
    async saveOverview(row) {
      await db.collection<StripeOverviewRow>(COLLECTIONS.stripeOverviewCache).updateOne({ orgId }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async getOverview() {
      try {
        const row = await db.collection<StripeOverviewRow>(COLLECTIONS.stripeOverviewCache).findOne({ orgId })
        return row ? { status: "present", value: row } : { status: "absent" }
      } catch (e) {
        return { status: "error", error: errText(e) }
      }
    },
  }

  const rollup: RollupRepo = {
    async upsert(row) {
      await db
        .collection<CrossSourceRollupRow>(COLLECTIONS.crossSourceRollups)
        .updateOne({ orgId, clientId: row.clientId, date: row.date }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async forClient(clientId, from, to) {
      return db
        .collection<CrossSourceRollupRow>(COLLECTIONS.crossSourceRollups)
        .find({ orgId, clientId, date: { $gte: from, $lte: to } })
        .sort({ date: 1 })
        .toArray() as Promise<CrossSourceRollupRow[]>
    },
  }

  const destinations: DestinationRepo = {
    async list() {
      return db.collection<DestinationRow>(COLLECTIONS.destinations).find({ orgId }).toArray() as Promise<DestinationRow[]>
    },
    async upsert(row) {
      await db.collection<DestinationRow>(COLLECTIONS.destinations).updateOne({ orgId, destinationId: row.destinationId }, { $set: { ...row, orgId } }, { upsert: true })
    },
    async remove(destinationId) {
      await db.collection<DestinationRow>(COLLECTIONS.destinations).deleteOne({ orgId, destinationId })
    },
  }

  return { orgId, clients, credentials, syncLog, callrail, ga4, gbp, gsc, lsa, fb, semrush, stripe, rollup, destinations }
}
