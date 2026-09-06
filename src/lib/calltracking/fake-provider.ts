// A scriptable CallTrackingProvider for tests — proves that ANY provider drives the same aggregation/
// sync/storage. Supports injecting errors (account resolve, per-company fetch) to exercise the sync's
// three-state discipline without a live vendor.
import type { CallTrackingProvider, TrackedCall, TrackedCompany } from "./types"

export class FakeCallTrackingProvider implements CallTrackingProvider {
  readonly name: string
  constructor(
    private data: {
      name?: string
      accountId?: string
      accountError?: Error
      companies?: TrackedCompany[]
      callsByCompany?: Record<string, TrackedCall[] | Error>
    } = {},
  ) {
    this.name = data.name ?? "fake-calltracking"
  }
  async resolveAccountId(): Promise<string> {
    if (this.data.accountError) throw this.data.accountError
    return this.data.accountId ?? "acct"
  }
  async listCompanies(): Promise<TrackedCompany[]> {
    return this.data.companies ?? []
  }
  async fetchCalls(_accountId: string, companyId: string): Promise<TrackedCall[]> {
    const v = this.data.callsByCompany?.[companyId]
    if (v instanceof Error) throw v
    return v ?? []
  }
}
