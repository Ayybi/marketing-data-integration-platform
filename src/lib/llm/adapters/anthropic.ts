// NEW (your change): Anthropic adapter behind the provider-agnostic LLMClient. Forced-tool calls map
// to messages.create with tool_choice; the result is decoded to the three-state LLMResult so a refusal
// or transport error is never mistaken for a valid empty answer (§12).
import type Anthropic from "@anthropic-ai/sdk"
import type { CompleteRequest, LLMClient, LLMResult, StructuredRequest } from "../types"

// Latest, most capable default (see model guidance). Override with LLM_MODEL / ANTHROPIC_MODEL.
export const DEFAULT_CLAUDE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8"

export class AnthropicAdapter implements LLMClient {
  readonly provider = "anthropic"
  constructor(
    private client: Anthropic,
    readonly model: string = DEFAULT_CLAUDE_MODEL,
  ) {}

  async structured<T = Record<string, unknown>>(req: StructuredRequest): Promise<LLMResult<T>> {
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        system: req.system,
        tools: [{ name: req.schema.name, description: req.schema.description, input_schema: req.schema.inputSchema as any }],
        tool_choice: { type: "tool", name: req.schema.name },
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      })
      const block = res.content.find((b) => b.type === "tool_use") as { input?: unknown } | undefined
      if (!block) return { ok: false, error: "model did not call the forced tool", kind: "refusal", model: this.model }
      return {
        ok: true,
        data: block.input as T,
        usage: { in: res.usage?.input_tokens ?? 0, out: res.usage?.output_tokens ?? 0 },
        model: this.model,
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), kind: "transport", model: this.model }
    }
  }

  async complete(req: CompleteRequest): Promise<LLMResult<string>> {
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        system: req.system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      })
      const text = res.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("")
      return { ok: true, data: text, usage: { in: res.usage?.input_tokens ?? 0, out: res.usage?.output_tokens ?? 0 }, model: this.model }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), kind: "transport", model: this.model }
    }
  }
}
