// NEW: tenant resolution for the route + cron layer. A real product swaps these for its own org model
// and session/JWT layer; kept deliberately small so the routes are runnable out of the box.
import type { Db } from "mongodb"
import { getDb, COLLECTIONS } from "./db/mongo/client"
import { tokenAccessControl, type AccessControl, type Session } from "./hub-app/adapters"
import { identityStore } from "./identity/store"

/**
 * List the orgIds a cron should sweep. Prefers HUB_ORG_IDS (comma-separated) for an explicit roster;
 * otherwise derives the distinct set of orgs that have at least one client (a stalest-first sweep can
 * be layered on top later). Errors propagate — a cron that cannot list tenants must fail, not run empty.
 */
export async function listOrgIds(db: Db = getDb()): Promise<string[]> {
  const env = process.env.HUB_ORG_IDS
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean)
  const ids = await db.collection(COLLECTIONS.clients).distinct("orgId")
  return (ids as string[]).filter(Boolean)
}

/**
 * API access control. Resolves a bearer API key against the identity store (hashed lookup) to a Session.
 * Falls back to a static HUB_API_TOKENS JSON map for local dev when the DB has no keys configured.
 */
export function getAccessControl(db?: Db): AccessControl {
  const raw = process.env.HUB_API_TOKENS
  let devMap: Record<string, Session> = {}
  if (raw) {
    try {
      devMap = JSON.parse(raw) as Record<string, Session>
    } catch {
      devMap = {} // a malformed token map means "no one is authorized", never "everyone"
    }
  }
  const devAccess = tokenAccessControl(devMap)
  return {
    async authenticate(authHeader) {
      const token = (authHeader ?? "").replace(/^Bearer\s+/i, "").trim()
      if (!token) return null
      // DB-backed API key first; fall back to the dev map.
      try {
        const resolved = await identityStore(db).verifyApiKey(token)
        if (resolved) return { orgId: resolved.orgId, capabilities: resolved.capabilities }
      } catch {
        // DB unavailable: fall through to the dev map rather than failing open.
      }
      return devAccess.authenticate(authHeader)
    },
    can(session, capability) {
      return session.capabilities.includes(capability)
    },
  }
}

export const SESSION_COOKIE = "mdh_session"

function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=")
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/**
 * Resolve the caller from a request — the single auth entry point for routes. Order:
 *   1) Bearer API key (programmatic access), 2) session cookie (browser/dashboard), 3) dev token map.
 * Returns null when unauthenticated. Never fails open.
 */
export async function getSession(req: Request, db?: Db): Promise<Session | null> {
  const access = getAccessControl(db)
  // 1) Bearer API key (or dev-map token)
  const viaBearer = await access.authenticate(req.headers.get("authorization"))
  if (viaBearer) return viaBearer
  // 2) Session cookie
  const cookieToken = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE]
  if (cookieToken) {
    try {
      const s = await identityStore(db).verifySession(cookieToken)
      if (s) return { orgId: s.orgId, capabilities: s.capabilities }
    } catch {
      /* DB unavailable -> unauthenticated, never fail open */
    }
  }
  return null
}
