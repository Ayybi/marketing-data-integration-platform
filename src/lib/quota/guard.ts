// NEW: route-level quota guard. Records one unit per call per tenant per month and refuses (429) when a
// tenant is over its plan limit — so one customer cannot exhaust a shared vendor quota via the API.
import { usageMeter, monthWindow, planLimit, type ConsumeResult } from "./meter"

export async function enforceMonthlyQuota(orgId: string, meter: string): Promise<ConsumeResult> {
  return usageMeter().consume(orgId, meter, monthWindow(), planLimit(meter))
}
