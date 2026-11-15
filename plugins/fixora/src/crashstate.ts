// What Fixora already did about a listed crash (pure): the state, a short label, the Jira / MR
// links and the "came back after the fix" detection the picker, the markdown table and the TUI
// show next to every crash. Derived from the run record and the crash index, never stored.

import { detectReopen } from "./fingerprint.js"
import type { CrashFix, CrashIndexEntry, CrashState, CrashSummary, RunRecord } from "./types.js"

/** States a new run may be started for without `--force` (the others already own a fix or are busy). */
const CANDIDATES: ReadonlySet<string> = new Set<CrashState>(["new", "failed", "reopened"])
export const isFixCandidate = (state: string | undefined) => !state || CANDIDATES.has(state)

/** States where a fix exists (an MR, a merge, a release, or at least a finished branch). */
const FIXED: ReadonlySet<CrashState> = new Set<CrashState>(["mr_open", "merged", "released", "fixed"])
export const isFixed = (state: string | undefined) => !!state && FIXED.has(state as CrashState)

export const STATE_GLYPH: Record<CrashState, string> = {
  new: "·",
  in_progress: "◐",
  awaiting: "⏸",
  mr_open: "✓",
  mr_closed: "✗",
  merged: "✓",
  released: "✓",
  fixed: "✓",
  reopened: "↻",
  failed: "✗",
  skipped: "–",
}

const STAGE: Partial<Record<RunRecord["step"], string>> = { detect: "detecting", fetch: "fetching the crash", prepare: "preparing the checkout", analyse: "finding the root cause", ticket: "creating the ticket", fix: "fixing", validate: "running checks", review: "in review", publish: "publishing", "close-loop": "linking", restore: "restoring the checkout" }

const mrRef = (run: Pick<RunRecord, "mrId" | "mrProvider">): string => {
  if (!run.mrId) return "MR"
  const p = (run.mrProvider ?? "").toLowerCase()
  if (p.includes("gitlab") || p.includes("glab")) return `MR !${run.mrId}`
  if (p.includes("github") || p === "gh") return `PR #${run.mrId}`
  return `MR ${run.mrId}`
}

export interface FixContext {
  index?: CrashIndexEntry
  /** The crash as the source lists it now (last seen, version) for the "came back" check. */
  crash?: Pick<CrashSummary, "lastSeen" | "appVersion">
  /** The run is executing in this process right now (storage may lag behind). */
  inflight?: boolean
  now?: string
}

/** The fix record of a crash that has a run. */
export function crashFixOf(run: RunRecord, o: FixContext = {}): CrashFix {
  const now = o.now ?? new Date().toISOString()
  const fix: CrashFix = {
    runId: run.runId,
    state: "new",
    label: "new",
    at: run.updatedAt,
    step: run.step,
    jiraKey: run.jiraKey,
    jiraUrl: run.jiraUrl,
    mrUrl: run.mrUrl,
    mrId: run.mrId,
    mrStatus: run.mrStatus,
    mrRef: run.mrUrl ? mrRef(run) : undefined,
    branch: run.branch,
    attempts: (run.counters?.restarts ?? 0) + 1,
  }
  const index = o.index
  const released = index?.fixedIn && index.fixedIn.runId === run.runId ? index.fixedIn : undefined
  const reopenedBefore = run.reopened?.count ?? (index?.reopened.count || undefined)
  const previously = run.reopened?.fixedIn ?? index?.fixedIn?.release

  if (o.inflight || run.status === "running") {
    fix.state = "in_progress"
    fix.label = STAGE[run.step] ?? "in progress"
  } else if (run.status === "awaiting-approval") {
    fix.state = "awaiting"
    fix.label = "waiting for your approval"
  } else if (released) {
    fix.release = released.release
    fix.at = released.at
    // Only the source's own "last seen" can say the crash came back; without it, trust the index.
    const back = o.crash?.lastSeen ? detectReopen(index, o.crash, now) : { reopened: false as const }
    if (back.reopened || (index?.reopened.count ?? 0) > 0) {
      fix.state = "reopened"
      fix.stillSeen = back.reopened
      fix.reopened = Math.max(1, index?.reopened.count ?? 0)
      fix.label = `came back after the fix in ${released.release}`
      fix.note = back.detail ?? (index?.reopened.reason ? `likely ${index.reopened.reason.replace(/-/g, " ")}` : undefined)
    } else {
      fix.state = "released"
      fix.label = `fixed in ${released.release}${released.platform ? ` (${released.platform})` : ""}`
    }
  } else if (run.mrStatus === "merged") {
    fix.state = "merged"
    fix.label = `fixed · ${fix.mrRef ?? "MR"} merged`
    const mergedAt = typeof run.meta?.mergedAt === "string" ? run.meta.mergedAt : run.updatedAt
    fix.at = mergedAt
    if (o.crash?.lastSeen && o.crash.lastSeen > mergedAt) {
      fix.stillSeen = true
      fix.note = "still seen after the merge: not released yet, or the fix is incomplete"
    }
  } else if (run.mrUrl && run.mrStatus === "closed") {
    fix.state = "mr_closed"
    fix.label = `${fix.mrRef ?? "MR"} closed without merging`
  } else if (run.mrUrl) {
    fix.state = "mr_open"
    fix.label = `fixed · ${fix.mrRef ?? "MR"} ${run.mrStatus === "draft" ? "draft" : "open"}`
    fix.at = run.timings.publish?.endedAt ?? run.updatedAt
  } else if (run.status === "done") {
    fix.state = "fixed"
    fix.label = run.flags.dryRun ? "fixed (dry run, not committed)" : run.pipeline.pushed ? "fixed · pushed, no MR" : run.pipeline.committed ? "fixed · committed on the branch" : "fixed on the branch"
  } else if (run.status === "skipped") {
    fix.state = "skipped"
    fix.label = `skipped${run.skipReason ? `: ${run.skipReason.slice(0, 80)}` : ""}`
  } else {
    fix.state = "failed"
    const why = run.blockedReason ? ` (${run.blockedReason})` : ""
    fix.label = `${run.status === "failed" ? "failed" : run.status} at ${run.step}${why}`
    if (run.error) fix.note = run.error.split("\n")[0]!.slice(0, 120)
  }
  if (reopenedBefore && fix.state !== "reopened") {
    fix.reopened = reopenedBefore
    const prefix = `reopened ×${reopenedBefore}${previously ? ` (was fixed in ${previously})` : ""}`
    fix.note = fix.note ? `${prefix}; ${fix.note}` : prefix
  }
  return fix
}

export interface FixTally {
  total: number
  fixed: number
  byState: Partial<Record<CrashState, number>>
  candidates: number
}

export function tallyFixes(list: CrashSummary[]): FixTally {
  const byState: Partial<Record<CrashState, number>> = {}
  let fixed = 0
  let candidates = 0
  for (const c of list) {
    const s = (c.state ?? "new") as CrashState
    byState[s] = (byState[s] ?? 0) + 1
    if (isFixed(s)) fixed++
    if (isFixCandidate(s)) candidates++
  }
  return { total: list.length, fixed, byState, candidates }
}

const STATE_WORD: Record<CrashState, string> = {
  new: "new",
  in_progress: "in progress",
  awaiting: "waiting for approval",
  mr_open: "MR open",
  mr_closed: "MR closed",
  merged: "merged",
  released: "released",
  fixed: "fixed on a branch",
  reopened: "came back",
  failed: "failed",
  skipped: "skipped",
}

/** One line: "3 of 10 already fixed by Fixora (1 merged · 2 MR open) · 1 came back · 6 new". */
export function describeTally(t: FixTally): string {
  if (t.total === 0) return "no crashes"
  const fixedParts = (["released", "merged", "mr_open", "fixed"] as CrashState[]).filter((s) => t.byState[s]).map((s) => `${t.byState[s]} ${STATE_WORD[s]}`)
  const rest = (["reopened", "in_progress", "awaiting", "mr_closed", "failed", "skipped", "new"] as CrashState[]).filter((s) => t.byState[s]).map((s) => `${t.byState[s]} ${STATE_WORD[s]}`)
  const head = t.fixed ? `${t.fixed} of ${t.total} already fixed by Fixora${fixedParts.length ? ` (${fixedParts.join(" · ")})` : ""}` : `${t.total} crash(es), none fixed by Fixora yet`
  return [head, ...rest].join(" · ")
}

/** The commands that make sense next for a crash in this state. */
export function nextCommands(fix: CrashFix, ref?: string): string[] {
  const id = fix.runId
  switch (fix.state) {
    case "mr_open":
    case "fixed":
      return [`/fixora feedback ${id} "…"`, `/fixora fixed ${id} --release <version>`]
    case "merged":
      return [`/fixora fixed ${id} --release <version>`]
    case "released":
      return []
    case "reopened":
      return [`/fixora restart ${id}`]
    case "mr_closed":
      return [`/fixora restart ${id}`, ...(ref ? [`/fixora fix ${ref} --force`] : [])]
    case "failed":
      return [`/fixora retry ${id}`]
    case "skipped":
      return [`/fixora retry ${id}`, `/fixora status ${id}`]
    case "in_progress":
    case "awaiting":
      return [`/fixora status ${id}`]
    default:
      return []
  }
}
