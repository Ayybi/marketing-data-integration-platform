// Credential vault (doc Part A §5 / B2). AES-256-GCM with the key from INTEGRATION_VAULT_KEY.
//
// DEVIATION FROM DOC (your change, matched to the ideas-project vault for cross-product consistency):
//  - Self-describing versioned blob "v1:<iv>:<tag>:<ct>" / "v2:..." (base64 parts) instead of the doc's
//    raw [IV|tag|ct] base64 concatenation. Functionally equivalent AES-256-GCM; easier to evolve.
//  - AAD binding: with an `aad`, the ciphertext is cryptographically bound to its context
//    (e.g. "integ:agency:callrail") so a blob cannot be moved to another provider/tenant row. v2 tag.
//  - decryptMaybe returns THREE STATES (present/absent/error) — the §12 invariant at the vault seam —
//    rather than the doc's silent legacy-plaintext passthrough. A decrypt FAILURE is never an ABSENCE.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto"
import type { ReadResult } from "../result"

const ALGO = "aes-256-gcm"
const IV_LEN = 12 // GCM standard nonce length

function key(): Buffer {
  const raw = process.env.INTEGRATION_VAULT_KEY
  if (!raw) throw new Error("INTEGRATION_VAULT_KEY is not set")
  // Accept a 32-byte hex or base64 key, or derive a stable 32-byte key from any passphrase.
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex")
  const b64 = Buffer.from(raw, "base64")
  if (b64.length === 32) return b64
  return createHash("sha256").update(raw, "utf8").digest()
}

/** Encrypt plaintext to a self-describing blob. With aad -> "v2:..."; without -> "v1:...". */
export function encrypt(plaintext: string, aad?: string): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key(), iv)
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"))
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  const version = aad !== undefined ? "v2" : "v1"
  return [version, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":")
}

/**
 * Decrypt a blob produced by encrypt(). THROWS on tamper/wrong-key/wrong-aad/malformed (an ERROR,
 * never a silent value). For a "v2" blob the same `aad` MUST be supplied or the auth tag fails.
 */
export function decrypt(blob: string, aad?: string): string {
  const parts = String(blob ?? "").split(":")
  if (parts.length !== 4 || (parts[0] !== "v1" && parts[0] !== "v2")) throw new Error("vault: malformed blob")
  const [version, ivB64, tagB64, ctB64] = parts as [string, string, string, string]
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64"))
  if (version === "v2") decipher.setAAD(Buffer.from(aad ?? "", "utf8"))
  decipher.setAuthTag(Buffer.from(tagB64, "base64"))
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8")
}

/**
 * decryptMaybe — three-state read at the vault seam (§12 invariant):
 *   present -> decrypted value, absent -> genuinely no blob (null/empty), error -> a blob exists but
 *   cannot be decrypted (tamper/wrong key/wrong aad). Never conflates a decrypt FAILURE with ABSENT.
 */
export function decryptMaybe(blob: string | null | undefined, aad?: string): ReadResult<string> {
  if (blob == null || blob === "") return { status: "absent" }
  try {
    return { status: "present", value: decrypt(blob, aad) }
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) }
  }
}

/** Canonical AAD for an integrations credential: binds ciphertext to its scope + provider (+ client). */
export function integrationAad(scope: "agency" | "client", provider: string, clientId?: string): string {
  return scope === "agency"
    ? `integ:agency:${provider}`
    : `integ:client:${provider}:${clientId ?? ""}`
}
