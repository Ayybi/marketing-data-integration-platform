// Call-tracking provider factory. Selects the vendor by CALL_TRACKING_PROVIDER (default "callrail") and
// builds its adapter with a resolved API key. To add a vendor: write an adapter implementing
// CallTrackingProvider, then add a case here — aggregation/sync/storage never change.
import type { Repos } from "../db/types"
import type { Fetcher } from "../http"
import { defaultFetcher } from "../http"
import { type CallTrackingProvider, CallTrackingNotConfigured } from "./types"
import { CallRailProvider, resolveCallRailKey } from "./callrail-provider"

export * from "./types"
export { syncCallTracking } from "./sync"
export { aggregateCallSnapshots, trackedCallToRow } from "./aggregate"
export { CallRailProvider, resolveCallRailKey, mapRawCallToTracked, callRailGet, getAgencyAccountId, fetchCompanies, fetchCallsForCompany } from "./callrail-provider"
export type { RawCall, CallRailCompany } from "./callrail-provider"
export { FakeCallTrackingProvider } from "./fake-provider"

let override: CallTrackingProvider | null = null

/** The provider name that will be selected (for sync_log source labelling before the provider is built). */
export function selectedProviderName(): string {
  return (process.env.CALL_TRACKING_PROVIDER ?? "callrail").toLowerCase()
}

/**
 * Resolve the configured call-tracking provider. Throws CallTrackingNotConfigured when the vendor has no
 * credential (absent), or a plain Error when a stored credential fails to decrypt (surfaced, not absent).
 */
export async function getCallTrackingProvider(repos: Repos, opts?: { fetcher?: Fetcher }): Promise<CallTrackingProvider> {
  if (override) return override
  const name = selectedProviderName()
  const fetcher = opts?.fetcher ?? defaultFetcher
  switch (name) {
    case "callrail": {
      const key = await resolveCallRailKey(repos)
      if (key.status === "absent") throw new CallTrackingNotConfigured("callrail")
      if (key.status === "error") throw new Error(`callrail credential error: ${key.error}`)
      return new CallRailProvider(fetcher, key.value)
    }
    // case "calltrackingmetrics": { ... }  // add adapters here
    default:
      throw new Error(`Unknown CALL_TRACKING_PROVIDER: "${name}"`)
  }
}

/** Test/DI hook: force a specific provider (e.g. FakeCallTrackingProvider) without touching env. */
export function setCallTrackingProvider(p: CallTrackingProvider | null): void {
  override = p
}
