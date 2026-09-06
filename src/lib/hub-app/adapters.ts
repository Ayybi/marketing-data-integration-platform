// NEW (extraction seam, doc §2 / §11): the adapters that replace the dashboard's coupling. The core
// connectors import these interfaces, never a dashboard module. Everything in §2's coupling table maps
// onto one of these.
//
//  - AccessControl / Session   -> replaces requireStaff / RBAC (tenant identity)
//  - CredentialSource          -> the vault-backed integrations repo (already in Repos.credentials)
//  - SyncObserver              -> sync_log (already in Repos.syncLog)
//
// Keeping them here means a host app swaps its own auth/session in without touching connector code.
import type { Repos } from "../db/types"

/** A resolved caller. orgId is the tenant key that scopes every repo (RLS replacement). */
export type Session = { orgId: string; userId?: string; capabilities: string[] }

export interface AccessControl {
  /** Resolve a request's credential (bearer token / cookie) to a Session, or null if unauthenticated. */
  authenticate(authHeader: string | null | undefined): Promise<Session | null>
  /** Capability check — "can this session read/sync this workspace's data". */
  can(session: Session, capability: string): boolean
}

/** Per-request context handed to every handler. repos is ALREADY scoped to session.orgId. */
export type HubContext = {
  session: Session
  repos: Repos
}

/**
 * Simple token->session AccessControl for tests and single-tenant deployments. Maps an opaque bearer
 * token to a Session. A real product swaps this for its session/JWT layer without touching handlers.
 */
export function tokenAccessControl(tokens: Record<string, Session>): AccessControl {
  return {
    async authenticate(authHeader) {
      const token = (authHeader ?? "").replace(/^Bearer\s+/i, "").trim()
      if (!token) return null
      return tokens[token] ?? null
    },
    can(session, capability) {
      return session.capabilities.includes(capability)
    },
  }
}
