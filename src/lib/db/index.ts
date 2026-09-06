// NEW (your change): storage factory. Returns repos ALREADY SCOPED to an org — callers cannot obtain
// an unscoped handle, which is what enforces tenant isolation in place of Postgres RLS.
import type { Db } from "mongodb"
import { getDb } from "./mongo/client"
import { makeMongoRepos } from "./mongo/repos"
import type { Repos } from "./types"

export * from "./types"

export function repos(orgId: string, db?: Db): Repos {
  if (!orgId) throw new Error("repos(orgId): orgId is required (tenant isolation)")
  return makeMongoRepos(db ?? getDb(), orgId)
}
