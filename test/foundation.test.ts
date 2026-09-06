import { describe, it, expect, beforeAll } from "vitest"
import { normalizeDomain, withTimeout, classifyReadStatus, classifyUnitsRead } from "../src/lib/helpers.js"
import { encrypt, decrypt, decryptMaybe, integrationAad } from "../src/lib/integrations/vault.js"
import { summarizeFailures, syncStatus, toSyncLogEntry, SYNC_ERROR_SAMPLE_CAP } from "../src/lib/sync-log.js"
import { verifyCronSecret } from "../src/lib/auth/cron.js"

beforeAll(() => {
  process.env.INTEGRATION_VAULT_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")
})

describe("normalizeDomain", () => {
  it("strips scheme, www, path; lowercases", () => {
    expect(normalizeDomain("HTTPS://WWW.Example.com/foo/bar")).toBe("example.com")
    expect(normalizeDomain("")).toBe("example.com")
  })
})

describe("withTimeout", () => {
  it("resolves the inner promise when fast", async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, "x")).resolves.toBe(7)
  })
  // FAILURE-PATH: a hung read must surface as an error, never hang or resolve to a fake value.
  it("rejects with a labeled error when the inner promise is too slow", async () => {
    const slow = new Promise<number>((r) => setTimeout(() => r(1), 50))
    await expect(withTimeout(slow, 5, "semrush")).rejects.toThrow(/semrush timed out after 5ms/)
  })
})

describe("classifyReadStatus (three-state)", () => {
  it("200 present, 404 absent, everything else error", () => {
    expect(classifyReadStatus(200)).toBe("present")
    expect(classifyReadStatus(404)).toBe("absent")
    // FAILURE-PATH: 403 / 500 / 0 are ERROR, never absent (never "nothing here").
    for (const s of [403, 429, 500, 502, 0]) expect(classifyReadStatus(s)).toBe("error")
  })
})

describe("classifyUnitsRead (SEMrush three-state)", () => {
  it("numeric body ok = balance", () => {
    expect(classifyUnitsRead(true, 200, " 42 ")).toEqual({ kind: "ok", balance: 42 })
  })
  it("depletion reads as an authoritative balance 0, not unreadable", () => {
    expect(classifyUnitsRead(false, 200, "ERROR 120 :: API UNITS BALANCE IS TOO LOW")).toEqual({ kind: "ok", balance: 0 })
  })
  // FAILURE-PATH: an HTTP failure or garbage body is UNREADABLE, never a real balance of 0.
  it("transport failure is unreadable, non-numeric ok body is unreadable", () => {
    expect(classifyUnitsRead(false, 503, "")).toEqual({ kind: "unreadable", detail: "HTTP 503" })
    expect(classifyUnitsRead(true, 200, "banana")).toEqual({ kind: "unreadable", detail: "non-numeric body" })
  })
})

describe("vault (AES-256-GCM + AAD)", () => {
  it("round-trips with and without aad", () => {
    expect(decrypt(encrypt("secret"))).toBe("secret")
    const aad = integrationAad("agency", "callrail")
    expect(decrypt(encrypt("tok", aad), aad)).toBe("tok")
  })
  it("a v2 blob decrypted with the WRONG aad throws (context binding)", () => {
    const blob = encrypt("tok", integrationAad("agency", "callrail"))
    expect(() => decrypt(blob, integrationAad("agency", "stripe"))).toThrow()
  })
  // FAILURE-PATH: decryptMaybe distinguishes absent (no blob) from error (tamper/wrong key).
  it("decryptMaybe: present / absent / error are distinct", () => {
    const good = encrypt("v")
    expect(decryptMaybe(good)).toEqual({ status: "present", value: "v" })
    expect(decryptMaybe(null)).toEqual({ status: "absent" })
    expect(decryptMaybe("")).toEqual({ status: "absent" })
    const tampered = good.slice(0, -4) + "AAAA"
    const r = decryptMaybe(tampered)
    expect(r.status).toBe("error")
  })
})

describe("sync-log", () => {
  it("summarizeFailures caps the sample and counts the remainder", () => {
    expect(summarizeFailures([], 0)).toBeNull()
    const many = ["a", "b", "c", "d", "e", "f", "g"]
    const out = summarizeFailures(many, 7)
    expect(out).toBe(`a | b | c | d | e | (+2 more)`)
    expect(SYNC_ERROR_SAMPLE_CAP).toBe(5)
  })
  it("syncStatus derives success / partial / error", () => {
    expect(syncStatus({ errors: 0, processed: 3 })).toBe("success")
    expect(syncStatus({ errors: 2, processed: 3 })).toBe("partial") // some worked -> preserve existing
    expect(syncStatus({ errors: 2, processed: 0 })).toBe("error")   // nothing written -> aborted
  })
  it("toSyncLogEntry builds a bounded row", () => {
    const e = toSyncLogEntry("callrail", "snapshot", { processed: 1, errors: 1, total: 2, errorSample: ["boom"] })
    expect(e.status).toBe("partial")
    expect(e.recordsAffected).toBe(1)
    expect(e.errorMessage).toBe("boom")
    expect(typeof e.createdAt).toBe("string")
  })
})

describe("verifyCronSecret", () => {
  it("accepts the exact bearer, rejects everything else, fails closed without a secret", () => {
    process.env.CRON_SECRET = "s3cr3t"
    expect(verifyCronSecret("Bearer s3cr3t")).toBe(true)
    expect(verifyCronSecret("Bearer nope")).toBe(false)
    expect(verifyCronSecret(null)).toBe(false)
    delete process.env.CRON_SECRET
    expect(verifyCronSecret("Bearer s3cr3t")).toBe(false)
  })
})
