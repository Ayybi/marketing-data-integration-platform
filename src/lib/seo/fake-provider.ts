// A configurable in-memory SeoProvider for tests — and a reference for how a LIMITED-capability vendor
// (e.g. a Google-only stack with no backlinks) behaves: unsupported capabilities return the standard
// unsupported_capability error, never a fake zero.
import type { ReadResult } from "../result"
import {
  type SeoProvider,
  type SeoCapability,
  type SeoDomainOverview,
  type SeoBacklinks,
  type SeoKeyword,
  type SeoQuota,
  unsupportedCapability,
} from "./types"

export class FakeSeoProvider implements SeoProvider {
  readonly name: string
  readonly capabilities: ReadonlySet<SeoCapability>
  constructor(
    private data: {
      name?: string
      capabilities?: SeoCapability[]
      overview?: ReadResult<SeoDomainOverview>
      backlinks?: ReadResult<SeoBacklinks>
      keywords?: ReadResult<SeoKeyword[]>
      quota?: SeoQuota
    } = {},
  ) {
    this.name = data.name ?? "fake"
    this.capabilities = new Set(data.capabilities ?? ["overview", "backlinks", "keywords", "quota"])
  }

  async domainOverview(_domain?: string, _opts?: unknown): Promise<ReadResult<SeoDomainOverview>> {
    if (!this.capabilities.has("overview")) return unsupportedCapability("overview")
    return this.data.overview ?? { status: "absent" }
  }
  async backlinks(_domain?: string, _opts?: unknown): Promise<ReadResult<SeoBacklinks>> {
    if (!this.capabilities.has("backlinks")) return unsupportedCapability("backlinks")
    return this.data.backlinks ?? { status: "absent" }
  }
  async organicKeywords(_domain?: string, _opts?: unknown): Promise<ReadResult<SeoKeyword[]>> {
    if (!this.capabilities.has("keywords")) return unsupportedCapability("keywords")
    return this.data.keywords ?? { status: "absent" }
  }
  async quota(): Promise<SeoQuota> {
    return this.data.quota ?? { kind: "unlimited" }
  }
}
