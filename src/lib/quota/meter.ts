// NEW (§11 multi-tenancy): per-tenant usage metering so one customer cannot exhaust a shared quota
// (SEMrush units, Google/Meta rate limits) or hammer the API. Counters are keyed (orgId, meter, window)
// and consumed atomically.
import type { Db } from "mongodb"
import { COLLECTIONS, getDb } from "../db/mongo/client"

export class QuotaExceeded extends Error {
  constructor(
    readonly meter: string,
    readonly used: number,
    readonly limit: number,
  ) {
    super(`quota exceeded for "${meter}": ${used}/${limit}`)
    this.name = "QuotaExceeded"
  }
}

type CounterRow = { orgId: string; provider: string; window: string; count: number }

export function monthWindow(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}
export function dayWindow(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

export type ConsumeResult = { allowed: boolean; used: number; limit: number }

export interface UsageMeter {
  get(orgId: string, provider: string, window: string): Promise<number>
  /** Atomically consume `n` units if under `limit`; returns whether it was allowed + the resulting usage. */
  consume(orgId: string, provider: string, window: string, limit: number, n?: number): Promise<ConsumeResult>
  usageForOrg(orgId: string, window: string): Promise<Record<string, number>>
}

export function makeUsageMeter(db: Db): UsageMeter {
  const coll = db.collection<CounterRow>(COLLECTIONS.usageCounters)
  return {
    async get(orgId, provider, window) {
      const row = await coll.findOne({ orgId, provider, window })
      return row?.count ?? 0
    },
    async consume(orgId, provider, window, limit, n = 1) {
      await coll.updateOne({ orgId, provider, window }, { $setOnInsert: { orgId, provider, window, count: 0 } }, { upsert: true })
      // Only increment when the resulting count stays within the limit (atomic guard).
      const updated = await coll.findOneAndUpdate({ orgId, provider, window, count: { $lte: limit - n } }, { $inc: { count: n } }, { returnDocument: "after" })
      if (updated) return { allowed: true, used: updated.count, limit }
      const cur = await coll.findOne({ orgId, provider, window })
      return { allowed: false, used: cur?.count ?? 0, limit }
    },
    async usageForOrg(orgId, window) {
      const rows = await coll.find({ orgId, window }).toArray()
      const out: Record<string, number> = {}
      for (const r of rows) out[r.provider] = r.count
      return out
    },
  }
}

export function usageMeter(db?: Db): UsageMeter {
  return makeUsageMeter(db ?? getDb())
}

/** Per-tenant plan limits (monthly). Env defaults; a real product stores these per org/plan. */
export function planLimit(meter: string): number {
  const env = {
    seo_reads: process.env.HUB_SEO_READS_PER_MONTH,
    ads_reads: process.env.HUB_ADS_READS_PER_MONTH,
    api_reads: process.env.HUB_API_READS_PER_MONTH,
  } as Record<string, string | undefined>
  const raw = env[meter]
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : 100_000 // generous default
}
