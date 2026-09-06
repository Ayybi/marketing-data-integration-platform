// A scriptable PaidAdsProvider for tests — proves any platform yields the same normalized AdInsights.
import type { ReadResult } from "../result"
import type { PaidAdsProvider, AdInsights, AdBounds } from "./types"

export class FakeAdsProvider implements PaidAdsProvider {
  readonly platform: string
  constructor(
    private result: ReadResult<AdInsights>,
    platform = "fake",
  ) {
    this.platform = platform
  }
  async accountInsights(_accountId?: string, _bounds?: AdBounds): Promise<ReadResult<AdInsights>> {
    return this.result
  }
}
