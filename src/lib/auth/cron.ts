// WRITE-FROM-SPEC (doc Part A §8): every cron route is guarded by a CRON_SECRET bearer check.
// Returns a boolean rather than throwing so a route can answer 403 cleanly.

export function verifyCronSecret(authHeader: string | null | undefined): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false // fail closed: no secret configured means no cron access
  const expected = `Bearer ${secret}`
  const got = authHeader ?? ""
  // Constant-time-ish compare on equal-length strings; length mismatch is an immediate reject.
  if (got.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}
