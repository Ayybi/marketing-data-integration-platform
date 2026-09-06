// NEW (your change): provider-agnostic LLM layer. Core code depends only on LLMClient.
// The forced-tool schema / system prompt flow THROUGH this interface unchanged.

export type LLMMessage = { role: "user" | "assistant"; content: string }

export type LLMSchema = {
  name: string // forced-tool name, e.g. "classify_call"
  description: string
  inputSchema: Record<string, unknown> // provider-neutral JSON Schema
}

export type StructuredRequest = {
  system: string
  messages: LLMMessage[]
  schema: LLMSchema
  maxTokens: number
  temperature?: number
}

export type CompleteRequest = {
  system: string
  messages: LLMMessage[]
  maxTokens: number
  temperature?: number
}

export type TokenUsage = { in: number; out: number }

// Three-state result honoring "failure != absence" (§12). A refusal/timeout/parse/transport failure is
// a distinct ERROR state, never a silent empty object.
export type LLMResult<T> =
  | { ok: true; data: T; usage: TokenUsage; model: string }
  | { ok: false; error: string; kind: "refusal" | "timeout" | "parse" | "transport"; model: string }

export interface LLMClient {
  readonly provider: string
  readonly model: string
  structured<T = Record<string, unknown>>(req: StructuredRequest): Promise<LLMResult<T>>
  complete(req: CompleteRequest): Promise<LLMResult<string>>
}
