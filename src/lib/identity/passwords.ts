// NEW: password hashing (scrypt) for org users. Format: "scrypt$<saltB64>$<hashB64>".
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

const N = 16384
const KEYLEN = 32

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEYLEN, { N })
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = String(stored ?? "").split("$")
  if (parts.length !== 3 || parts[0] !== "scrypt") return false
  const salt = Buffer.from(parts[1], "base64")
  const expected = Buffer.from(parts[2], "base64")
  const actual = scryptSync(password, salt, expected.length, { N })
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
