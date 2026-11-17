// The repository a command applies to is the ORIGINATING SESSION's directory, never the plugin's own
// location (a globally installed plugin lives in the home directory). The git top level is reported
// by the worker's prepare phase; the plugin does not run git.

import type { Plugin } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
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

/** The `url` of a remote from the first `[remote "<name>"]` section of a git config text (pure). */
export function remoteUrlFromConfig(text: string, remote: string): string | undefined {
  let inside = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const section = /^\[(.+)\]$/.exec(line)
    if (section) {
      inside = /^remote\s+"(.+)"$/.exec(section[1]!)?.[1] === remote
      continue
    }
    if (!inside) continue
    const m = /^url\s*=\s*(.+)$/.exec(line)
    if (m) return m[1]!.trim()
  }
  return undefined
}

/**
 * The remote URL of the checkout a session works in, read from `.git/config` (walking up from the
 * directory; a `.git` file — worktree or submodule — is followed through its `gitdir:` line). Best
 * effort: undefined when nothing readable is found, and the worker then reports it instead.
 */
export async function readRemoteUrl(directory: string, remote: string): Promise<string | undefined> {
  let dir = directory
  for (let i = 0; i < 8; i++) {
    const dotGit = join(dir, ".git")
    let config = await readFile(join(dotGit, "config"), "utf8").catch(() => undefined)
    if (config === undefined) {
      const pointer = await readFile(dotGit, "utf8").catch(() => undefined)
      const gitdir = pointer && /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim()
      if (gitdir) {
        const resolved = gitdir.startsWith("/") ? gitdir : join(dir, gitdir)
        const common = await readFile(join(resolved, "commondir"), "utf8").catch(() => undefined)
        const base = common ? (common.trim().startsWith("/") ? common.trim() : join(resolved, common.trim())) : resolved
        config = await readFile(join(base, "config"), "utf8").catch(() => undefined)
      }
    }
    if (config !== undefined) return remoteUrlFromConfig(config, remote)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

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
