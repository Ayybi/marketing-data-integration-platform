// Stripe connector (doc §4.8, B4 subscriptions.list shape).
//
// Auth: STRIPE_SECRET_KEY (required). The list operations are behind an injectable StripeGateway so the
// MRR math + the roster-sanity guard test without live Stripe.
//
// Failure discipline (BUG-145, §12): the full sync raises a controlled StripeSyncAbortError if a
// load-bearing read fails or the fetched roster is implausibly small (stored >= 10 and fetched < 50% of
// stored). The run logs `partial`; existing MRR and mappings STAY INTACT rather than being wiped. A
// clean re-run recovers.
import type { Repos, StripeSubscriptionRow } from "./db/types"
import type { ReadResult } from "./result"
import { type SyncResult, toSyncLogEntry } from "./sync-log"

export class StripeSyncAbortError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StripeSyncAbortError"
  }
}

// ---- External call seam ----

export type RawStripeItem = { priceAmountCents: number; interval: "day" | "week" | "month" | "year"; intervalCount: number; quantity: number }
export type RawStripeSub = {
  id: string
  status: string // active | trialing | past_due | canceled | ...
  customerId: string
  customerEmail?: string
  customerName?: string
  productName?: string
  collectionPaused?: boolean
  discountPercentOff?: number // subscription-level discount
  items: RawStripeItem[]
}

export interface StripeGateway {
  /** All subscriptions (status: "all"), pagination already resolved. Throws on a load-bearing failure. */
  listSubscriptions(): Promise<RawStripeSub[]>
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY)
}

// ---- MRR normalization (pure) ----

const MRR_STATUSES = new Set(["active", "trialing", "past_due"])

/** Normalize one item's recurring amount to monthly cents. */
function itemMonthlyCents(item: RawStripeItem): number {
  const perInterval = item.priceAmountCents * (item.quantity || 1)
  const count = item.intervalCount || 1
  const base = perInterval / count
  switch (item.interval) {
    case "month":
      return base
    case "year":
      return base / 12
    case "week":
      return (base * 52) / 12
    case "day":
      return (base * 365) / 12
    default:
      return base
  }
}

/**
 * MRR for one subscription in monthly cents. Only active/trialing/past_due count; a collection-paused
 * sub is 0; a subscription-level discount is applied.
 */
export function normalizeSubscriptionMrr(sub: RawStripeSub): number {
  if (!MRR_STATUSES.has(sub.status)) return 0
  if (sub.collectionPaused) return 0
  const gross = sub.items.reduce((sum, it) => sum + itemMonthlyCents(it), 0)
  const discount = sub.discountPercentOff ? gross * (sub.discountPercentOff / 100) : 0
  return Math.round(gross - discount)
}

export function computeMrrCents(subs: RawStripeSub[]): number {
  return subs.reduce((sum, s) => sum + normalizeSubscriptionMrr(s), 0)
}

function toRow(sub: RawStripeSub): Omit<StripeSubscriptionRow, "orgId"> {
  return {
    subscriptionId: sub.id,
    customerId: sub.customerId,
    status: sub.status,
    productName: sub.productName,
    monthlyMrrCents: normalizeSubscriptionMrr(sub),
    collectionPaused: sub.collectionPaused,
  }
}

// ---- Sync ----

export type StripeSyncResult = SyncResult & { aborted: boolean; mrrCents: number }

/**
 * Full Stripe sync with the BUG-145 roster-sanity guard. Aborts (partial, no wipe) when the fetched
 * roster is implausibly small relative to what is stored, or when the load-bearing list read fails.
 */
export async function runFullStripeSync(repos: Repos, gateway: StripeGateway): Promise<StripeSyncResult> {
  const storedCount = await repos.stripe.countSubscriptions()

  let fetched: RawStripeSub[]
  try {
    fetched = await gateway.listSubscriptions()
  } catch (e) {
    // Load-bearing read failed -> abort controlled, preserve existing data.
    const result: StripeSyncResult = { processed: 0, errors: 1, total: storedCount, errorSample: [`abort: ${e instanceof Error ? e.message : String(e)}`], aborted: true, mrrCents: 0 }
    // Logged `partial`, not `error`: existing MRR/mappings are preserved (BUG-145).
    await repos.syncLog.write(toSyncLogEntry("stripe", "full_sync", result, { aborted: true }, "partial"))
    return result
  }

  // Roster sanity: a big stored roster suddenly returning <50% is implausible -> do NOT wipe MRR.
  if (storedCount >= 10 && fetched.length < storedCount * 0.5) {
    const result: StripeSyncResult = {
      processed: 0,
      errors: 1,
      total: storedCount,
      errorSample: [`abort: roster implausibly small (stored ${storedCount}, fetched ${fetched.length})`],
      aborted: true,
      mrrCents: 0,
    }
    await repos.syncLog.write(toSyncLogEntry("stripe", "full_sync", result, { aborted: true }, "partial"))
    // Existing MRR + mappings stay intact; surface a controlled abort for the caller.
    throw new StripeSyncAbortError(`roster implausibly small (stored ${storedCount}, fetched ${fetched.length})`)
  }

  let processed = 0
  for (const sub of fetched) {
    await repos.stripe.upsertSubscription(toRow(sub))
    processed += 1
  }
  const mrrCents = computeMrrCents(fetched)
  const activeSubscribers = fetched.filter((s) => MRR_STATUSES.has(s.status) && !s.collectionPaused).length
  await repos.stripe.saveOverview({ mrrCents, activeSubscribers, computedAt: new Date().toISOString() })

  const result: StripeSyncResult = { processed, errors: 0, total: fetched.length, errorSample: [], aborted: false, mrrCents }
  await repos.syncLog.write(toSyncLogEntry("stripe", "full_sync", result, { mrrCents, activeSubscribers }))
  return result
}

// ---- Reads ----

export type StripeOverview = { mrrCents: number; activeSubscribers: number; computedAt: string }

/** Read the agency overview. Three-state: absent = never synced, error = read failed, present = totals. */
export async function getStripeOverviewStats(repos: Repos): Promise<ReadResult<StripeOverview>> {
  const r = await repos.stripe.getOverview()
  if (r.status !== "present") return r
  return { status: "present", value: { mrrCents: r.value.mrrCents, activeSubscribers: r.value.activeSubscribers, computedAt: r.value.computedAt } }
}

// ---- Mapping chain (§4.8) + MRR breakdown ----

function normalizeName(s: string | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

export type StripeClientCandidate = { clientId: string; name?: string; email?: string; stripeCustomerId?: string }
export type StripeMatch = { clientId: string; via: "manual" | "customer_id" | "email" | "name" } | { clientId: null; via: "none" | "ambiguous" }

/**
 * Resolve a subscription to a client via the priority chain (§4.8): manual mapping -> stored
 * stripe_customer_id -> email -> normalized-name (with an AMBIGUITY GUARD: two clients with the same
 * name do NOT auto-link). No match leaves client_id null.
 */
export function matchStripeClient(
  sub: { customerId: string; customerEmail?: string; customerName?: string },
  candidates: StripeClientCandidate[],
  manualMap: Record<string, string> = {},
): StripeMatch {
  if (manualMap[sub.customerId]) return { clientId: manualMap[sub.customerId], via: "manual" }
  const byCustomer = candidates.find((c) => c.stripeCustomerId && c.stripeCustomerId === sub.customerId)
  if (byCustomer) return { clientId: byCustomer.clientId, via: "customer_id" }
  if (sub.customerEmail) {
    const email = sub.customerEmail.toLowerCase()
    const byEmail = candidates.filter((c) => c.email && c.email.toLowerCase() === email)
    if (byEmail.length === 1) return { clientId: byEmail[0].clientId, via: "email" }
    if (byEmail.length > 1) return { clientId: null, via: "ambiguous" }
  }
  if (sub.customerName) {
    const name = normalizeName(sub.customerName)
    if (name) {
      const byName = candidates.filter((c) => normalizeName(c.name) === name)
      if (byName.length === 1) return { clientId: byName[0].clientId, via: "name" }
      if (byName.length > 1) return { clientId: null, via: "ambiguous" } // two clients same name -> no auto-link
    }
  }
  return { clientId: null, via: "none" }
}

export type MrrBreakdown = { mrrCents: number; activeSubscribers: number; byStatus: Record<string, { count: number; mrrCents: number }> }

/** Compute an MRR breakdown by subscription status from STORED subscriptions (no live call). */
export async function getMrrBreakdown(repos: Repos): Promise<MrrBreakdown> {
  const subs = await repos.stripe.allSubscriptions()
  const byStatus: Record<string, { count: number; mrrCents: number }> = {}
  let mrrCents = 0
  let activeSubscribers = 0
  for (const s of subs) {
    const bucket = (byStatus[s.status] ??= { count: 0, mrrCents: 0 })
    bucket.count += 1
    bucket.mrrCents += s.monthlyMrrCents
    if (["active", "trialing", "past_due"].includes(s.status) && !s.collectionPaused) {
      mrrCents += s.monthlyMrrCents
      activeSubscribers += 1
    }
  }
  return { mrrCents, activeSubscribers, byStatus }
}
