// The user's checkout: what the prepare phase must leave behind, how the restore phase undoes it,
// and the git commands both prompts spell out. Pure.

import { shellQuote } from "./git.js"
import type { RunRecord } from "./types.js"

/** True when a step needs the fix branch checked out (everything after fetch, before restore). */
export const needsCheckout = (step: RunRecord["step"]) => !["detect", "fetch", "restore", "done"].includes(step)

export const needsPrepare = (run: RunRecord) => !run.checkout?.active

/** Records the prepare submission on the run. */
export function markPrepared(run: RunRecord, p: { previousBranch: string; previousHeadSha: string; stashRef?: string | null; branch: string; gitRoot?: string; baseSha?: string; remoteUrl?: string | null; at?: string }): RunRecord {
  run.checkout = {
    active: true,
    previousBranch: p.previousBranch,
    previousHeadSha: p.previousHeadSha,
    stashRef: p.stashRef ?? run.checkout?.stashRef ?? undefined,
    preparedAt: p.at ?? new Date().toISOString(),
    restoredAt: undefined,
  }
  run.branch = p.branch
  if (p.gitRoot) run.gitRoot = p.gitRoot
  if (p.baseSha) run.base.sha = p.baseSha
  if (p.remoteUrl !== undefined) run.base.remoteUrl = p.remoteUrl
  return run
}

export function markRestored(run: RunRecord, at = new Date().toISOString()): RunRecord {
  run.checkout = { ...run.checkout, active: false, restoredAt: at }
  return run
}

/** The exact commands the restore phase runs, in order. */
export function restorePlan(run: RunRecord, o: { keepFix?: boolean } = {}): string[] {
  const c = run.checkout
  const target = c.previousBranch && c.previousBranch !== "HEAD" ? c.previousBranch : c.previousHeadSha
  const out: string[] = []
  if (o.keepFix) {
    out.push(`git status --porcelain=v1 --untracked-files=all   # entries outside .dxcoder/ and generated paths (lockfiles, node_modules, .dart_tool, build outputs) are the uncommitted fix of this run: then STOP HERE — do not check out, do not pop — and report ok:true with results { branch: "${run.branch ?? "<fix branch>"}", stashPopped: false, kept: true }`)
  } else out.push(`git status --porcelain=v1 --untracked-files=all   # anything left behind by the run? report it, never discard it`)
  out.push(`git checkout ${shellQuote(target ?? "-")}`)
  if (c.stashRef) {
    out.push(`git stash list   # find the entry whose message is "fixora/${run.runId}" (commit ${c.stashRef.slice(0, 10)})`)
    out.push(`git stash pop <that stash@{n}>   # on a conflict: leave the stash in place and report ok:false`)
  }
  out.push(`git rev-parse --abbrev-ref HEAD   # must print ${target ?? "the previous branch"}`)
  return out
}

/** What the final report prints when restore could not finish. */
export function manualRestoreCommands(run: RunRecord): string[] {
  const c = run.checkout
  const L = [`git checkout ${c.previousBranch ?? c.previousHeadSha ?? "<your branch>"}`]
  if (c.stashRef) L.push(`git stash list   # find "fixora/${run.runId}"`, "git stash pop stash@{n}")
  return L
}
