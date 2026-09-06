// LIVE WIRING for Stripe (doc §4.8, B4 subscriptions.list shape). Turns Stripe subscription objects
// into the connector's RawStripeSub. The SDK call sits behind StripeSubListClient so the mapper +
// pagination test with a fake client (no live Stripe); buildStripeGateway() supplies the real SDK.
import type { StripeGateway, RawStripeSub, RawStripeItem } from "./stripe"

// ---- Minimal shapes of the Stripe objects we actually read (keeps the mapper decoupled from the
// enormous Stripe.* types; the real SDK objects are structurally compatible with these). ----

export type StripeRawPrice = {
  unit_amount?: number | null
  nickname?: string | null
  recurring?: { interval?: "day" | "week" | "month" | "year"; interval_count?: number } | null
}
export type StripeRawItem = { price?: StripeRawPrice | null; quantity?: number | null }
export type StripeRawDiscount = { coupon?: { percent_off?: number | null } | null } | null
export type StripeRawSubscription = {
  id: string
  status: string
  customer?: string | { id: string; email?: string | null; name?: string | null } | null
  pause_collection?: unknown | null
  discounts?: StripeRawDiscount[] | null
  discount?: StripeRawDiscount | null // legacy single-discount field
  items?: { data?: StripeRawItem[] } | null
}

export type StripeApiList = { data: StripeRawSubscription[]; has_more: boolean }
export type StripeSubListParams = { status: "all"; limit: number; starting_after?: string; expand?: string[] }
export interface StripeSubListClient {
  subscriptions: { list(params: StripeSubListParams): Promise<StripeApiList> }
}

// ---- Pure mapping ----

function customerId(c: StripeRawSubscription["customer"]): string {
  if (!c) return ""
  return typeof c === "string" ? c : c.id
}
function customerEmail(c: StripeRawSubscription["customer"]): string | undefined {
  return c && typeof c !== "string" ? (c.email ?? undefined) : undefined
}
function customerName(c: StripeRawSubscription["customer"]): string | undefined {
  return c && typeof c !== "string" ? (c.name ?? undefined) : undefined
}
function discountPercent(sub: StripeRawSubscription): number | undefined {
  const list = sub.discounts ?? (sub.discount ? [sub.discount] : [])
  for (const d of list) {
    const pct = d?.coupon?.percent_off
    if (pct != null) return pct
  }
  return undefined
}
function mapItem(it: StripeRawItem): RawStripeItem {
  const price = it.price ?? {}
  return {
    priceAmountCents: Number(price.unit_amount ?? 0),
    interval: price.recurring?.interval ?? "month", // subscription items are recurring; default defensively
    intervalCount: Number(price.recurring?.interval_count ?? 1),
    quantity: Number(it.quantity ?? 1),
  }
}

/** Map one Stripe subscription object into the connector's RawStripeSub. */
export function mapStripeSubscription(sub: StripeRawSubscription): RawStripeSub {
  const items = (sub.items?.data ?? []).map(mapItem)
  return {
    id: sub.id,
    status: sub.status,
    customerId: customerId(sub.customer),
    customerEmail: customerEmail(sub.customer),
    customerName: customerName(sub.customer),
    productName: sub.items?.data?.[0]?.price?.nickname ?? undefined,
    collectionPaused: sub.pause_collection != null,
    discountPercentOff: discountPercent(sub),
    items,
  }
}

// ---- Gateway (pagination) ----

const EXPAND = ["data.customer", "data.items.data.price", "data.discounts"]

/** Build a StripeGateway over any client implementing subscriptions.list — follows pagination fully. */
export function makeStripeGateway(client: StripeSubListClient): StripeGateway {
  return {
    async listSubscriptions(): Promise<RawStripeSub[]> {
      const out: RawStripeSub[] = []
      let startingAfter: string | undefined
      // Hard ceiling as a runaway guard; real end is has_more === false.
      for (let guard = 0; guard < 1000; guard++) {
        const page: StripeApiList = await client.subscriptions.list({ status: "all", limit: 100, starting_after: startingAfter, expand: EXPAND })
        for (const sub of page.data) out.push(mapStripeSubscription(sub))
        if (!page.has_more || page.data.length === 0) break
        startingAfter = page.data[page.data.length - 1].id
      }
      return out
    },
  }
}
