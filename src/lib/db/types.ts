// NEW (your change): storage abstraction. Connectors depend on these interfaces, never on `mongodb`.
// Replaces the doc's Postgres DDL (B3) + RLS: tenant isolation is enforced by orgId-scoped repos.
import type { ReadResult } from "../result"
import type { SyncLogEntry } from "../sync-log"

export type { ReadResult }

// ---- Row shapes. Every org-scoped row carries orgId. ----

/** Tenant identity — the doc's `clients` prerequisite (§9 / B3). */
export type ClientRow = {
  orgId: string
  clientId: string
  name?: string
  domain?: string // primary site domain; used to auto-match discovered accounts (§7)
  status?: string // 'cancel' => churned; filtered out of syncs (§2)
  deletedAt?: string | null // soft-delete; filtered out of syncs (§2)
}

/** Discovered GA4 property (§7 discovery table). Carries website_uri for domain auto-matching. */
export type Ga4PropertyRow = {
  orgId: string
  propertyId: string
  accountId?: string
  displayName?: string
  websiteUri?: string
}

/** Discovered GBP location (§7 discovery table). */
export type GbpLocationRow = {
  orgId: string
  locationId: string
  accountId?: string
  title?: string
  websiteUri?: string
  address?: string
}

/** Encrypted credential store (doc §5). auth_payload is a vault blob, never plaintext. */
export type IntegrationRow = {
  orgId: string
  scope: "agency" | "client"
  clientId?: string | null
  provider: string
  status: "active" | "expired" | "revoked" | "error" | "pending"
  authPayload?: string // AES-256-GCM vault blob
  metadata?: Record<string, unknown>
  lastSyncAt?: string
  lastError?: string
}

/** CallRail mapping (§4.1, Model A: one agency account, many companies -> one client each). */
export type CallRailMappingRow = {
  orgId: string
  clientId: string
  callrailAccountId: string
  callrailCompanyId: string
  accountName?: string
  status: "active" | "paused" | "error"
}

/** CallRail daily snapshot, keyed (callrailCompanyId, snapshotDate) (§4.1). */
export type CallRailSnapshotRow = {
  orgId: string
  clientId?: string | null
  callrailAccountId: string
  callrailCompanyId: string
  companyName?: string
  snapshotDate: string // YYYY-MM-DD
  totalCalls: number
  answeredCalls: number
  missedCalls: number
  firstTimeCallers: number
  qualifiedLeads: number
  totalDurationSeconds: number
}

/** CallRail per-call detail, keyed callrailCallId (§4.1). AI class attached by the classifier (§4.4). */
export type CallRailCallRow = {
  orgId: string
  callrailCallId: string
  callrailCompanyId: string
  clientId?: string | null
  startTime?: string
  duration?: number
  answered?: boolean
  leadStatus?: string
  customerName?: string
  customerPhone?: string
  recordingUrl?: string
  transcription?: string
  aiClass?: "new_estimate" | "active_job_followup" | "service_inquiry" | "junk"
}

/** GA4 property mapping (§4.2), UNIQUE(client_id). */
export type Ga4MappingRow = {
  orgId: string
  clientId: string
  ga4PropertyId: string
  propertyName?: string
  status: "active" | "paused" | "error"
}

export type Ga4Channel = { channel: string; sessions: number; conversions: number }
export type Ga4Page = { path: string; views: number }

/** GA4 daily snapshot keyed (client_id, snapshot_date) (§4.2). */
export type Ga4SnapshotRow = {
  orgId: string
  clientId: string
  ga4PropertyId: string
  snapshotDate: string // YYYY-MM-DD
  sessions: number
  totalUsers: number
  newUsers: number
  conversions: number
  engagedSessions: number
  channels: Ga4Channel[]
  topPages: Ga4Page[]
}

/** GBP location mapping (§4.3), UNIQUE(client_id, location_id) — multi-location per client. */
export type GbpMappingRow = {
  orgId: string
  clientId: string
  locationId: string
  locationName?: string
  status: "active" | "paused" | "error"
}

/** GBP daily snapshot keyed (client_id, location_id, snapshot_date) (§4.3). */
export type GbpSnapshotRow = {
  orgId: string
  clientId: string
  locationId: string
  snapshotDate: string
  views: number // search + maps
  searchViews: number
  mapsViews: number
  actions: number // calls + directions + website + conversations
  calls: number
  directions: number
  websiteClicks: number
  conversations: number
}

/** GBP review snapshot keyed the same (§4.3). Written ONLY from an authoritative reviews read. */
export type GbpReviewSnapshotRow = {
  orgId: string
  clientId: string
  locationId: string
  snapshotDate: string
  totalCount: number
  averageRating: number
}

/** GSC property mapping (§4.4), UNIQUE(client_id), keyed on the exact site_url. Live reads only. */
export type GscMappingRow = {
  orgId: string
  clientId: string
  siteUrl: string // e.g. "sc-domain:example.com"
  status: "active" | "paused" | "error"
}

/** LSA account mapping (§4.5), UNIQUE(customer_id) and UNIQUE(client_id, customer_id). */
export type LsaMappingRow = {
  orgId: string
  clientId: string
  googleAdsCustomerId: string
  accountName?: string
  monthlyBudget: number
  loginCustomerId?: string // MCC manager for this account
  status: "active" | "paused" | "suspended" | "pending_review" | "error"
  statusOverride?: "active" | "paused" | null // manual pin
}

/** LSA daily snapshot keyed (google_ads_customer_id, date) — account-keyed (NEW-35). */
export type LsaSnapshotRow = {
  orgId: string
  clientId?: string | null
  googleAdsCustomerId: string
  date: string // YYYY-MM-DD
  totalLeads: number
  phoneCalls: number
  messages: number
  bookings: number
  impressions: number
  adSpend: number
  costPerLead: number
  budgetUtilization: number
}

/** LSA per-lead detail keyed (google_ads_customer_id, lead_id) (§4.5). */
export type LsaLeadRow = {
  orgId: string
  googleAdsCustomerId: string
  leadId: string
  clientId?: string | null
  leadType: "PHONE_CALL" | "MESSAGE" | "BOOKING"
  chargeBucket: "charged" | "credited" | "in_review" | "not_charged"
  creationDateTime?: string
  categoryId?: string
}

/** Meta account mapping (§4.6), fb_account_id UNIQUE, UNIQUE(client_id). */
export type FbMappingRow = {
  orgId: string
  clientId: string
  fbAccountId: string
  fbAccountName?: string
  status: "active" | "paused" | "disabled" | "error"
}

export type FbOverview = {
  spend: number
  impressions: number
  clicks: number
  ctr: number
  cpc: number
  leads: number // grouped 'lead' action (BUG-07), NOT the double-counting sum
  cpl: number
}

/** Meta overview snapshot keyed (fb_account_id, date_range) (§4.6). The stored snapshot is the source of truth. */
export type FbOverviewSnapshotRow = {
  orgId: string
  fbAccountId: string
  clientId?: string | null
  dateRange: "30d" | "prev_30d" | "all_time"
  overview: FbOverview
  status: "ok" | "error" // a failed account is isolated as an error row, not blended into totals
  error?: string
  syncedAt: string
}

/** SEMrush SEO site config (§4.7): domain-based mapping to a client, UNIQUE(client_id). */
export type SeoSiteConfigRow = {
  orgId: string
  clientId: string
  domain: string
  database: string // e.g. "us"
  status: "active" | "paused" | "error"
}

/** SEMrush project (§4.7), discovery keyed project_id. */
export type SemrushProjectRow = {
  orgId: string
  projectId: string
  projectName?: string
  url?: string
  domainUnicode?: string
}

/** Stripe subscription (§4.8), one row per subscription (upserted). */
export type StripeSubscriptionRow = {
  orgId: string
  subscriptionId: string
  clientId?: string | null
  customerId: string
  status: string
  productName?: string
  monthlyMrrCents: number
  collectionPaused?: boolean
}

/** Stripe overview singleton (§4.8) — agency totals. */
export type StripeOverviewRow = {
  orgId: string
  mrrCents: number
  activeSubscribers: number
  computedAt: string
}

/** A configured export destination (§11 packaging: push to Sheets/BigQuery/webhook). */
export type DestinationRow = {
  orgId: string
  destinationId: string
  type: "webhook" | "sheets" | "bigquery"
  config: Record<string, string>
  createdAt: string
}

/** Unified cross-source daily rollup — one row per (client, day) across all connected sources (§11). */
export type CrossSourceRollupRow = {
  orgId: string
  clientId: string
  date: string // YYYY-MM-DD
  calls: number
  qualifiedLeads: number
  sessions: number
  conversions: number
  gbpViews: number
  gbpActions: number
  adLeads: number
  adSpend: number
}

// ---- Repositories (all scoped to a single org via the factory). ----

export interface ClientRepo {
  /** Active client ids for the org: excludes soft-deleted (deletedAt) and churned (status='cancel'). */
  activeClientIds(): Promise<string[]>
  upsert(row: Omit<ClientRow, "orgId">): Promise<void>
  get(clientId: string): Promise<ReadResult<ClientRow>>
}

export interface CredentialRepo {
  /**
   * Three-state credential resolution (§3 step 2, §12): present -> decrypted secret,
   * absent -> no such integration row, error -> a row exists but its blob failed to decrypt.
   * NEVER conflates a decrypt failure with an absent credential.
   */
  resolve(provider: string, scope: "agency" | "client", clientId?: string): Promise<ReadResult<string>>
  /** Persist an encrypted credential (handler/connect flow encrypts before calling). */
  save(row: Omit<IntegrationRow, "orgId">): Promise<void>
  setStatus(provider: string, scope: "agency" | "client", status: IntegrationRow["status"], lastError?: string, clientId?: string): Promise<void>
  isConfigured(provider: string, scope: "agency" | "client", clientId?: string): Promise<boolean>
  /** Distinct providers that have a stored credential for this org (existence only — no decrypt). */
  listProviders(): Promise<string[]>
}

export interface SyncLogRepo {
  write(entry: SyncLogEntry): Promise<void>
  recent(source: string, limit: number): Promise<SyncLogEntry[]>
}

export interface CallRailRepo {
  activeMappings(): Promise<CallRailMappingRow[]>
  getMappingByClient(clientId: string): Promise<ReadResult<CallRailMappingRow>>
  upsertMapping(row: Omit<CallRailMappingRow, "orgId">): Promise<void>
  /** Idempotent upsert on (callrailCompanyId, snapshotDate) — re-running a day overwrites. */
  upsertSnapshot(row: Omit<CallRailSnapshotRow, "orgId">): Promise<void>
  snapshotsForClient(clientId: string, from: string, to: string): Promise<CallRailSnapshotRow[]>
  /** Idempotent upsert on callrailCallId. */
  upsertCall(row: Omit<CallRailCallRow, "orgId">): Promise<void>
  unclassifiedQualifiedCalls(limit: number): Promise<CallRailCallRow[]>
  setCallClass(callrailCallId: string, aiClass: NonNullable<CallRailCallRow["aiClass"]>): Promise<void>
}

export interface Ga4Repo {
  activeMappings(): Promise<Ga4MappingRow[]>
  getMappingByClient(clientId: string): Promise<ReadResult<Ga4MappingRow>>
  upsertMapping(row: Omit<Ga4MappingRow, "orgId">): Promise<void>
  /** Set a mapping's status (used to deactivate on PERMISSION_DENIED/NOT_FOUND, §4.2). */
  setMappingStatus(clientId: string, status: Ga4MappingRow["status"]): Promise<void>
  /** Idempotent upsert on (client_id, snapshot_date). */
  upsertSnapshot(row: Omit<Ga4SnapshotRow, "orgId">): Promise<void>
  snapshotsForClient(clientId: string, from: string, to: string): Promise<Ga4SnapshotRow[]>
  // Discovery (§7)
  upsertProperty(row: Omit<Ga4PropertyRow, "orgId">): Promise<void>
  listProperties(): Promise<Ga4PropertyRow[]>
}

export interface GbpRepo {
  activeMappings(): Promise<GbpMappingRow[]>
  mappingsForClient(clientId: string): Promise<GbpMappingRow[]>
  upsertMapping(row: Omit<GbpMappingRow, "orgId">): Promise<void>
  upsertSnapshot(row: Omit<GbpSnapshotRow, "orgId">): Promise<void>
  snapshotsForClient(clientId: string, from: string, to: string): Promise<GbpSnapshotRow[]>
  /** Upsert on (client_id, location_id, snapshot_date) — written only from an authoritative read. */
  upsertReviewSnapshot(row: Omit<GbpReviewSnapshotRow, "orgId">): Promise<void>
  latestReview(clientId: string, locationId: string): Promise<ReadResult<GbpReviewSnapshotRow>>
  // Discovery (§7)
  upsertLocation(row: Omit<GbpLocationRow, "orgId">): Promise<void>
  listLocations(): Promise<GbpLocationRow[]>
}

export interface GscRepo {
  activeMappings(): Promise<GscMappingRow[]>
  getMappingByClient(clientId: string): Promise<ReadResult<GscMappingRow>>
  upsertMapping(row: Omit<GscMappingRow, "orgId">): Promise<void>
}

export interface LsaRepo {
  activeMappings(): Promise<LsaMappingRow[]>
  upsertMapping(row: Omit<LsaMappingRow, "orgId">): Promise<void>
  /** Set status (LSA-02: sync NEVER calls this on a transient failure). */
  setMappingStatus(googleAdsCustomerId: string, status: LsaMappingRow["status"]): Promise<void>
  /** Idempotent upsert on (google_ads_customer_id, date). */
  upsertSnapshot(row: Omit<LsaSnapshotRow, "orgId">): Promise<void>
  snapshotsForCustomer(googleAdsCustomerId: string, from: string, to: string): Promise<LsaSnapshotRow[]>
  /** Idempotent upsert on (google_ads_customer_id, lead_id) so pending->credited self-corrects. */
  upsertLead(row: Omit<LsaLeadRow, "orgId">): Promise<void>
}

export interface FbRepo {
  activeMappings(): Promise<FbMappingRow[]>
  getMappingByClient(clientId: string): Promise<ReadResult<FbMappingRow>>
  upsertMapping(row: Omit<FbMappingRow, "orgId">): Promise<void>
  /** Upsert on (fb_account_id, date_range). The stored snapshot is the source of truth. */
  upsertOverview(row: Omit<FbOverviewSnapshotRow, "orgId">): Promise<void>
  getOverview(fbAccountId: string, dateRange: FbOverviewSnapshotRow["dateRange"]): Promise<ReadResult<FbOverviewSnapshotRow>>
}

export interface SemrushRepo {
  resolveClientByDomain(domain: string): Promise<ReadResult<SeoSiteConfigRow>>
  upsertSiteConfig(row: Omit<SeoSiteConfigRow, "orgId">): Promise<void>
  listSiteConfigs(): Promise<SeoSiteConfigRow[]>
  upsertProject(row: Omit<SemrushProjectRow, "orgId">): Promise<void>
  listProjects(): Promise<SemrushProjectRow[]>
  pruneProjectsNotIn(projectIds: string[]): Promise<number>
}

export interface StripeRepo {
  countSubscriptions(): Promise<number>
  upsertSubscription(row: Omit<StripeSubscriptionRow, "orgId">): Promise<void>
  allSubscriptions(): Promise<StripeSubscriptionRow[]>
  saveOverview(row: Omit<StripeOverviewRow, "orgId">): Promise<void>
  getOverview(): Promise<ReadResult<StripeOverviewRow>>
}

export interface RollupRepo {
  upsert(row: Omit<CrossSourceRollupRow, "orgId">): Promise<void>
  forClient(clientId: string, from: string, to: string): Promise<CrossSourceRollupRow[]>
}

export interface DestinationRepo {
  list(): Promise<DestinationRow[]>
  upsert(row: Omit<DestinationRow, "orgId">): Promise<void>
  remove(destinationId: string): Promise<void>
}

export interface Repos {
  readonly orgId: string
  clients: ClientRepo
  credentials: CredentialRepo
  syncLog: SyncLogRepo
  callrail: CallRailRepo
  ga4: Ga4Repo
  gbp: GbpRepo
  gsc: GscRepo
  lsa: LsaRepo
  fb: FbRepo
  semrush: SemrushRepo
  stripe: StripeRepo
  rollup: RollupRepo
  destinations: DestinationRepo
}
