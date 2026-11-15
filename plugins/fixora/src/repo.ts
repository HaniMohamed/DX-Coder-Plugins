// The repository a command applies to is the ORIGINATING SESSION's project, never the plugin's own
// location (a globally installed plugin lives in the home directory).

import type { Plugin } from "@opencode/plugin"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { git } from "./git.js"
import { saveRun } from "./state.js"
import type { RunRecord } from "./types.js"

export interface SessionRepo {
  /** Directory the session works in. */
  directory: string
  /** Git top level of that directory (equals `directory` when it is the root). */
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
  const top = await git.topLevel(directory).catch(() => undefined)
  const same = !top || top === directory || realpathSafe(directory) === realpathSafe(top)
  return { directory, repo: same ? directory : top!, projectID }
}

/**
 * Guarantees `run.repo` / `run.projectID` / `run.folder` on records written before the repository was
 * stored (older plugin versions): they are resolved from the originating session and saved.
 */
export async function ensureRunRepo(ctx: Plugin.Context, run: RunRecord): Promise<RunRecord> {
  if (run.repo) return run
  const where = await sessionRepo(ctx, run.originSessionID)
  run.repo = where.repo
  run.projectID ??= where.projectID
  const pluginRoot = ctx.location.directory
  if (!run.folder || run.folder.startsWith(join(pluginRoot, ".dxcoder"))) run.folder = join(where.repo, ".dxcoder", "fixora", run.runId)
  await saveRun(ctx, run)
  return run
}

const realpathSafe = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
