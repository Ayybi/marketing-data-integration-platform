// NEW: injected fake LLM client for deterministic tests (the doc's "injected client" strategy).
// Lets tests script structured/complete results — including the ERROR states — with no live API.
import type { CompleteRequest, LLMClient, LLMResult, StructuredRequest } from "../types"

type Scripted<T> = LLMResult<T> | ((req: StructuredRequest | CompleteRequest) => LLMResult<T>)

export class FakeLLM implements LLMClient {
  readonly provider = "fake"
  readonly model = "fake-model"
  private structuredQueue: Array<Scripted<unknown>> = []
  private completeQueue: Array<Scripted<string>> = []
  public calls: { structured: StructuredRequest[]; complete: CompleteRequest[] } = { structured: [], complete: [] }

  onStructured<T>(r: Scripted<T>): this {
    this.structuredQueue.push(r as Scripted<unknown>)
    return this
  }
  onComplete(r: Scripted<string>): this {
    this.completeQueue.push(r)
    return this
  }

  async structured<T = Record<string, unknown>>(req: StructuredRequest): Promise<LLMResult<T>> {
    this.calls.structured.push(req)
    const next = this.structuredQueue.shift()
    if (!next) return { ok: false, error: "FakeLLM: no scripted structured result", kind: "transport", model: this.model }
    const r = typeof next === "function" ? next(req) : next
    return r as LLMResult<T>
  }

  async complete(req: CompleteRequest): Promise<LLMResult<string>> {
    this.calls.complete.push(req)
    const next = this.completeQueue.shift()
    if (!next) return { ok: false, error: "FakeLLM: no scripted complete result", kind: "transport", model: this.model }
    return typeof next === "function" ? next(req) : next
  }

  static ok<T>(data: T): LLMResult<T> {
    return { ok: true, data, usage: { in: 0, out: 0 }, model: "fake-model" }
  }
  static err<T = never>(kind: "refusal" | "timeout" | "parse" | "transport", error = "scripted error"): LLMResult<T> {
    return { ok: false, error, kind, model: "fake-model" }
  }
}
