// CallRail AI classification (doc §4.1 callrail-classify.ts). Labels a call transcription via the
// provider-agnostic LLM (your change; the doc used Claude directly).
//
// Failure discipline (§12): a classifier ERROR (refusal/timeout/transport/unknown label) is surfaced
// and the call is LEFT UNCLASSIFIED — never defaulted to "junk" or any other confident-but-wrong label.
import type { LLMClient, LLMSchema } from "./llm/types"
import type { Repos, CallRailCallRow } from "./db/types"
import type { ReadResult } from "./result"

export type CallClass = NonNullable<CallRailCallRow["aiClass"]>
const LABELS: CallClass[] = ["new_estimate", "active_job_followup", "service_inquiry", "junk"]

const CLASSIFY_TOOL: LLMSchema = {
  name: "classify_call",
  description: "Classify a home-services phone call from its transcription.",
  inputSchema: {
    type: "object",
    required: ["label"],
    properties: {
      label: { type: "string", enum: LABELS },
      reason: { type: "string" },
    },
  },
}

const SYSTEM = `You classify inbound phone calls for a home-services contractor from a call transcription.
Choose exactly one label:
- new_estimate: the caller wants a quote/estimate for new work.
- active_job_followup: the caller is an existing customer about a job already in progress.
- service_inquiry: a general question about services, hours, or availability, not yet an estimate request.
- junk: spam, wrong number, solicitation, or no usable content.
Ground the label in what the transcription actually says. Call the classify_call tool; no prose.`

/**
 * Classify one transcription. Three-state: present -> a valid label, absent -> no transcription to
 * classify, error -> the model failed or returned an unrecognized label (call stays unclassified).
 */
export async function classifyTranscription(llm: LLMClient, transcription: string | undefined): Promise<ReadResult<CallClass>> {
  const text = (transcription ?? "").trim()
  if (!text) return { status: "absent" }
  const res = await llm.structured<{ label?: string }>({
    system: SYSTEM,
    messages: [{ role: "user", content: text.slice(0, 8000) }],
    schema: CLASSIFY_TOOL,
    maxTokens: 200,
    temperature: 0,
  })
  if (!res.ok) return { status: "error", error: `${res.kind}: ${res.error}` }
  const label = res.data.label
  if (!label || !LABELS.includes(label as CallClass)) {
    return { status: "error", error: `unrecognized label: ${String(label)}` }
  }
  return { status: "present", value: label as CallClass }
}

/**
 * Bounded, best-effort post-sync pass (§4.1 classifyUnclassifiedQualifiedCalls, default 15). Classifies
 * qualified calls that have a transcription but no label yet. Returns counts; per-call errors are
 * counted, not fatal, and leave the call unclassified for a later retry.
 */
export async function classifyUnclassifiedQualifiedCalls(
  repos: Repos,
  llm: LLMClient,
  limit = 15,
): Promise<{ classified: number; skipped: number; errors: number }> {
  const calls = await repos.callrail.unclassifiedQualifiedCalls(limit)
  let classified = 0
  let skipped = 0
  let errors = 0
  for (const c of calls) {
    const r = await classifyTranscription(llm, c.transcription)
    if (r.status === "present") {
      await repos.callrail.setCallClass(c.callrailCallId, r.value)
      classified += 1
    } else if (r.status === "absent") {
      skipped += 1
    } else {
      errors += 1 // surfaced via the return count; call left unclassified (never mislabeled)
    }
  }
  return { classified, skipped, errors }
}
