// SEMrush ADAPTER for the SeoProvider port. A thin mapping layer over the existing semrush.ts reads —
// it translates SEMrush's shapes/units into the normalized SEO types. Adding another vendor means
// writing a sibling file like this; callers never change.
import type { Fetcher } from "../http"
import type { ReadResult } from "../result"
import {
  fetchDomainOverview,
  fetchDomainBacklinks,
  fetchDomainOrganicKeywords,
  readApiUnitsBalance,
  SemrushUnitsError,
} from "../semrush"
import {
  type SeoProvider,
  type SeoCapability,
  type SeoDomainOverview,
  type SeoBacklinks,
  type SeoKeyword,
  type SeoQuota,
  type SeoReadOpts,
  SeoQuotaError,
} from "./types"

const CAPS = new Set<SeoCapability>(["overview", "backlinks", "keywords", "quota"])

export class SemrushSeoProvider implements SeoProvider {
  readonly name = "semrush"
  readonly capabilities = CAPS as ReadonlySet<SeoCapability>

  constructor(
    private fetcher: Fetcher,
    private apiKey: string,
  ) {}

  private async guardUnits<T>(run: () => Promise<ReadResult<T>>): Promise<ReadResult<T>> {
    try {
      return await run()
    } catch (e) {
      if (e instanceof SemrushUnitsError) throw new SeoQuotaError(this.name) // normalize depletion signal
      throw e
    }
  }

  async domainOverview(domain: string, opts?: SeoReadOpts): Promise<ReadResult<SeoDomainOverview>> {
    return this.guardUnits(async () => {
      const r = await fetchDomainOverview(this.fetcher, this.apiKey, domain, opts?.database ?? "us", opts?.throwOnQuota ?? false)
      if (r.status !== "present") return r
      // Map SEMrush -> normalized (identical fields today, but map explicitly to keep the boundary).
      return { status: "present", value: { organicTraffic: r.value.organicTraffic, organicKeywords: r.value.organicKeywords, rank: r.value.rank } }
    })
  }

  async backlinks(domain: string, opts?: SeoReadOpts): Promise<ReadResult<SeoBacklinks>> {
    return this.guardUnits(async () => {
      const r = await fetchDomainBacklinks(this.fetcher, this.apiKey, domain, opts?.throwOnQuota ?? false)
      if (r.status !== "present") return r
      return { status: "present", value: { authorityScore: r.value.authorityScore, totalBacklinks: r.value.totalBacklinks, referringDomains: r.value.referringDomains } }
    })
  }

  async organicKeywords(domain: string, opts?: SeoReadOpts): Promise<ReadResult<SeoKeyword[]>> {
    return this.guardUnits(async () => {
      const r = await fetchDomainOrganicKeywords(this.fetcher, this.apiKey, domain, opts?.database ?? "us", opts?.limit ?? 100, opts?.throwOnQuota ?? false)
      if (r.status !== "present") return r
      return { status: "present", value: r.value.map((k) => ({ phrase: k.phrase, position: k.position, volume: k.volume })) }
    })
  }

  async quota(): Promise<SeoQuota> {
    const u = await readApiUnitsBalance(this.fetcher, this.apiKey)
    if (u.kind === "ok") return { kind: "ok", balance: u.balance }
    if (u.kind === "unconfigured") return { kind: "unconfigured" }
    return { kind: "unreadable", detail: u.detail }
  }
}
