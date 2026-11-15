// The repository a command applies to is the ORIGINATING SESSION's directory, never the plugin's own
// location (a globally installed plugin lives in the home directory). The git top level is reported
// by the worker's prepare phase; the plugin does not run git.

import type { Plugin } from "@opencode/plugin"
import { join } from "node:path"
import { saveRun } from "./state.js"
import type { RunRecord } from "./types.js"

export interface SessionRepo {
  /** Directory the session works in. */
  directory: string
  /** Same as `directory`: every worker session is created with this location. */
  repo: string
  projectID?: string
}

export async function sessionRepo(ctx: Plugin.Context, sessionID: string): Promise<SessionRepo> {
  let directory: string = ctx.location.directory
  let projectID: string | undefined = ctx.location.project?.id
  try {
    const s = (await ctx.session.get({ sessionID: sessionID as never })) as { location?: { directory?: string }; projectID?: string }
    if (s.location?.directory) {
      directory = s.location.directory
      projectID = s.projectID ?? projectID
    }
  } catch {
    // unknown session (tests, or a session that no longer exists): fall back to the plugin location
  }
  return { directory, repo: directory, projectID }
}

export const folderFor = (repo: string, runId: string) => join(repo, ".dxcoder", "fixora", runId)

/**
 * Guarantees `run.repo` / `run.folder` / `run.checkout` on records written by older plugin versions:
 * they are resolved from the originating session and saved.
 */
export async function ensureRunRepo(ctx: Plugin.Context, run: RunRecord): Promise<RunRecord> {
  let changed = false
  if (!run.repo) {
    const where = await sessionRepo(ctx, run.originSessionID)
    run.repo = where.repo
    changed = true
  }
  const pluginRoot = ctx.location.directory
  if (!run.folder || (run.folder.startsWith(join(pluginRoot, ".dxcoder")) && pluginRoot !== run.repo)) {
    run.folder = folderFor(run.repo, run.runId)
    changed = true
  }
  if (!run.checkout) {
    run.checkout = { active: false }
    changed = true
  }
  if (changed) await saveRun(ctx, run)
  return run
}
