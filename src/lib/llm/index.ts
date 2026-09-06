// Provider-agnostic LLM factory (your change). Callers depend only on LLMClient; the provider is
// chosen by config. Env: LLM_PROVIDER (default anthropic), LLM_API_KEY (falls back to a provider key),
// LLM_MODEL (optional override). Only the Anthropic adapter ships here; add openai/gemini adapters the
// same way as the ideas-project layer if you need them.
import Anthropic from "@anthropic-ai/sdk"
import type { LLMClient } from "./types"
import { AnthropicAdapter, DEFAULT_CLAUDE_MODEL } from "./adapters/anthropic"
import type { Repos } from "../db/types"
import { resolveLlmConfig } from "../tenant-creds"

export * from "./types"
export { AnthropicAdapter, DEFAULT_CLAUDE_MODEL } from "./adapters/anthropic"
export { FakeLLM } from "./adapters/fake"

export type LlmProvider = "anthropic"

let cached: LLMClient | null = null

export function getLLM(): LLMClient {
  if (cached) return cached
  const provider = (process.env.LLM_PROVIDER ?? "anthropic") as LlmProvider
  const apiKey = process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY
  const model = process.env.LLM_MODEL ?? DEFAULT_CLAUDE_MODEL
  if (!apiKey) throw new Error(`No API key for LLM_PROVIDER="${provider}". Set LLM_API_KEY or ANTHROPIC_API_KEY.`)
  if (provider !== "anthropic") throw new Error(`Unknown LLM_PROVIDER: ${provider}`)
  cached = new AnthropicAdapter(new Anthropic({ apiKey }), model)
  return cached
}

/** Test/DI hook: force a specific client (e.g. FakeLLM) without touching env. */
export function setLLM(client: LLMClient | null): void {
  cached = client
}

/**
 * BYO: build an LLM client from the TENANT's own config (vault -> env). No shared cache — each org's key
 * stays its own. Honors a test override set via setLLM(). Throws if the workspace has no key configured.
 */
export async function getLLMForOrg(repos: Repos): Promise<LLMClient> {
  if (cached) return cached // test/DI override
  const cfg = await resolveLlmConfig(repos)
  if (!cfg) throw new Error("No LLM key configured for this workspace")
  if (cfg.provider !== "anthropic") throw new Error(`Unknown LLM provider: "${cfg.provider}"`)
  return new AnthropicAdapter(new Anthropic({ apiKey: cfg.apiKey }), cfg.model ?? DEFAULT_CLAUDE_MODEL)
}
