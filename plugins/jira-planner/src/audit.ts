// Pure gap/drift logic. The model decides semantic matches (matchedExisting); this module
// computes deterministic hints, estimate verdicts and the report the tech lead reads.

import type { PushDecision } from "./render.js"
import { topologicalOrder, type ExistingSubtask, type SubtasksFile } from "./schema.js"

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "with", "as", "at", "by", "is", "be",
  "implement", "implementation", "add", "create", "update", "build", "new", "support", "task", "subtask",
])

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\s*\[[^\]]*\]\s*/g, "") // "[PROJ-1] " style prefixes
    .replace(/^\s*[a-z][a-z0-9_]+-\d+\s*[:\-–]\s*/i, "") // "PROJ-1: " style prefixes
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

const stem = (word: string) => {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1)
  return word
}

export function tokens(title: string): Set<string> {
  const out = new Set<string>()
  for (const word of normalizeTitle(title).split(" ")) {
    if (!word || STOPWORDS.has(word) || word.length < 2) continue
    out.add(stem(word))
  }
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

export const STRONG_HINT = 0.6
export const WEAK_HINT = 0.35

export interface MatchHint {
  plannedId: string
  key: string
  score: number
  strength: "strong" | "weak"
}

/** Greedy one-to-one title similarity hints. They never decide a match; the model and the lead do. */
export function matchHints(
  planned: ReadonlyArray<{ id: string; title: string }>,
  existing: ReadonlyArray<{ key: string; summary: string }>,
): MatchHint[] {
  const pairs: MatchHint[] = []
  const plannedTokens = planned.map((p) => ({ id: p.id, tokens: tokens(p.title) }))
  const existingTokens = existing.map((e) => ({ key: e.key, tokens: tokens(e.summary) }))
  for (const p of plannedTokens) {
    for (const e of existingTokens) {
      const score = jaccard(p.tokens, e.tokens)
      if (score >= WEAK_HINT) pairs.push({ plannedId: p.id, key: e.key, score, strength: score >= STRONG_HINT ? "strong" : "weak" })
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.plannedId.localeCompare(b.plannedId))
  const usedPlanned = new Set<string>()
  const usedExisting = new Set<string>()
  const out: MatchHint[] = []
  for (const pair of pairs) {
    if (usedPlanned.has(pair.plannedId) || usedExisting.has(pair.key)) continue
    usedPlanned.add(pair.plannedId)
    usedExisting.add(pair.key)
    out.push({ ...pair, score: Math.round(pair.score * 100) / 100 })
  }
  return out
}

export type EstimateVerdict = "ok" | "drift" | "unestimated"
export const DRIFT_RATIO = 0.3
export const DRIFT_ABSOLUTE = 2

export function estimateVerdict(planned: number, existing: number | null): { estimate: EstimateVerdict; delta: number | null } {
  if (existing === null || existing === undefined || Number.isNaN(existing)) return { estimate: "unestimated", delta: null }
  const delta = existing - planned
  const drift = Math.abs(delta) / planned > DRIFT_RATIO || Math.abs(delta) >= DRIFT_ABSOLUTE
  return { estimate: drift ? "drift" : "ok", delta }
}

export interface GapReport {
  issue: string
  generatedAt: string
  matched: Array<{
    plannedId: string
    key: string
    title: string
    existingSummary: string
    plannedPoints: number
    existingPoints: number | null
    verdict: "same" | "partial" | "superseded"
    estimate: EstimateVerdict
    delta: number | null
  }>
  missing: Array<{ plannedId: string; title: string; storyPoints: number; dependsOn: string[]; hint?: MatchHint }>
  extra: Array<{ key: string; summary: string; existingPoints: number | null; status: string; hint?: MatchHint }>
  totals: { plannedPoints: number; existingPoints: number; matchedPlannedPoints: number; matchedExistingPoints: number }
  hints: MatchHint[]
}

export function computeGapReport(plan: SubtasksFile, existing: ExistingSubtask[], generatedAt = new Date().toISOString()): GapReport {
  const existingByKey = new Map(existing.map((e) => [e.key.toUpperCase(), e]))
  const matched: GapReport["matched"] = []
  const missingPlanned: SubtasksFile["subtasks"] = []
  const referenced = new Set<string>()

  for (const s of plan.subtasks) {
    if (!s.matchedExisting) {
      missingPlanned.push(s)
      continue
    }
    const key = s.matchedExisting.key.toUpperCase()
    referenced.add(key)
    const live = existingByKey.get(key)
    const existingPoints = live ? live.storyPoints : s.matchedExisting.existingPoints
    const verdict = estimateVerdict(s.storyPoints, existingPoints)
    matched.push({
      plannedId: s.id,
      key: live?.key ?? s.matchedExisting.key,
      title: s.title,
      existingSummary: live?.summary ?? s.matchedExisting.summary,
      plannedPoints: s.storyPoints,
      existingPoints,
      verdict: s.matchedExisting.verdict,
      ...verdict,
    })
  }

  const extraExisting = existing.filter((e) => !referenced.has(e.key.toUpperCase()))
  const hints = matchHints(missingPlanned, extraExisting)
  const hintByPlanned = new Map(hints.map((h) => [h.plannedId, h]))
  const hintByKey = new Map(hints.map((h) => [h.key, h]))

  const missing = missingPlanned.map((s) => ({
    plannedId: s.id,
    title: s.title,
    storyPoints: s.storyPoints,
    dependsOn: s.dependsOn,
    ...(hintByPlanned.has(s.id) ? { hint: hintByPlanned.get(s.id) } : {}),
  }))
  const extra = extraExisting.map((e) => ({
    key: e.key,
    summary: e.summary,
    existingPoints: e.storyPoints,
    status: e.status,
    ...(hintByKey.has(e.key) ? { hint: hintByKey.get(e.key) } : {}),
  }))

  const sum = (xs: Array<number | null>) => xs.reduce<number>((acc, x) => acc + (x ?? 0), 0)
  return {
    issue: plan.issue,
    generatedAt,
    matched,
    missing,
    extra,
    totals: {
      plannedPoints: sum(plan.subtasks.map((s) => s.storyPoints)),
      existingPoints: sum(existing.map((e) => e.storyPoints)),
      matchedPlannedPoints: sum(matched.map((m) => m.plannedPoints)),
      matchedExistingPoints: sum(matched.map((m) => m.existingPoints)),
    },
    hints,
  }
}

const fmtPoints = (n: number | null) => (n === null ? "—" : String(n))
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")

export function renderGapReport(report: GapReport): string {
  const lines: string[] = []
  const drift = report.matched.filter((m) => m.estimate === "drift")
  const unestimated = report.matched.filter((m) => m.estimate === "unestimated")
  lines.push(`# Gap report for ${report.issue}`, "")
  lines.push(`Generated ${report.generatedAt}`, "")
  lines.push("## Totals", "")
  lines.push("| Planned points | Existing points (all) | Matched planned | Matched existing |", "|---|---|---|---|")
  lines.push(
    `| ${report.totals.plannedPoints} | ${report.totals.existingPoints} | ${report.totals.matchedPlannedPoints} | ${report.totals.matchedExistingPoints} |`,
    "",
  )
  lines.push(
    `- Missing in Jira: **${report.missing.length}**  ·  Extra in Jira (not in plan): **${report.extra.length}**  ·  Matched: **${report.matched.length}**  ·  Estimate drift: **${drift.length}**  ·  Unestimated in Jira: **${unestimated.length}**`,
    "",
  )

  lines.push("## Missing in Jira (planned, not yet created)", "")
  if (report.missing.length === 0) lines.push("None.", "")
  else {
    lines.push("| Id | Title | Points | Depends on | Possible existing match |", "|---|---|---|---|---|")
    for (const m of report.missing)
      lines.push(
        `| ${m.plannedId} | ${cell(m.title)} | ${m.storyPoints} | ${m.dependsOn.join(", ") || "—"} | ${m.hint ? `${m.hint.key} (${m.hint.strength}, ${m.hint.score})` : "—"} |`,
      )
    lines.push("")
    if (report.missing.some((m) => m.hint?.strength === "strong"))
      lines.push(
        "Rows with a **strong** hint are probably the same work as an existing subtask. Confirm by setting `matchedExisting` on that subtask in subtasks.json, or leave it to create a new one.",
        "",
      )
  }

  lines.push("## Matched (planned ↔ existing)", "")
  if (report.matched.length === 0) lines.push("None.", "")
  else {
    lines.push("| Id | Planned title | Jira key | Jira summary | Verdict | Planned pts | Jira pts | Estimate |", "|---|---|---|---|---|---|---|---|")
    for (const m of report.matched)
      lines.push(
        `| ${m.plannedId} | ${cell(m.title)} | ${m.key} | ${cell(m.existingSummary)} | ${m.verdict} | ${m.plannedPoints} | ${fmtPoints(m.existingPoints)} | ${m.estimate}${m.delta !== null && m.delta !== 0 ? ` (${m.delta > 0 ? "+" : ""}${m.delta})` : ""} |`,
      )
    lines.push("")
  }

  lines.push("## Extra in Jira (existing subtasks not covered by the plan)", "")
  if (report.extra.length === 0) lines.push("None.", "")
  else {
    lines.push("| Jira key | Summary | Status | Jira pts | Possible planned match |", "|---|---|---|---|---|")
    for (const e of report.extra)
      lines.push(
        `| ${e.key} | ${cell(e.summary)} | ${cell(e.status)} | ${fmtPoints(e.existingPoints)} | ${e.hint ? `${e.hint.plannedId} (${e.hint.strength}, ${e.hint.score})` : "—"} |`,
      )
    lines.push("")
  }

  lines.push("## Estimate check", "")
  if (drift.length === 0 && unestimated.length === 0) lines.push("All matched subtasks have estimates consistent with the plan.", "")
  else {
    for (const m of drift)
      lines.push(
        `- **${m.key}** (${m.plannedId}): Jira has ${fmtPoints(m.existingPoints)} pts, plan says ${m.plannedPoints} pts (${m.delta! > 0 ? "+" : ""}${m.delta}). Review the estimate.`,
      )
    for (const m of unestimated) lines.push(`- **${m.key}** (${m.plannedId}): no story points in Jira; plan says ${m.plannedPoints} pts.`)
    lines.push("")
    lines.push(`Drift threshold: more than ${Math.round(DRIFT_RATIO * 100)}% or at least ${DRIFT_ABSOLUTE} points difference.`, "")
  }
  return lines.join("\n")
}

// ---------- push decisions ----------

export const MARKER = (issue: string, id: string) => `[dxcoder-jira-planner ${issue}#${id}]`

export function decidePush(plan: SubtasksFile, existing: ExistingSubtask[], already: ReadonlyArray<{ id: string; key: string }>): PushDecision[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  const existingByTitle = new Map(existing.map((e) => [norm(e.summary), e]))
  const createdIds = new Map(already.map((c) => [c.id, c]))
  return topologicalOrder(plan.subtasks).map((subtask) => {
    if (subtask.matchedExisting) return { subtask, action: "skip", reason: `matched to existing ${subtask.matchedExisting.key} (${subtask.matchedExisting.verdict})` }
    const created = createdIds.get(subtask.id)
    if (created) return { subtask, action: "skip", reason: `already created as ${created.key} by a previous push` }
    const marker = MARKER(plan.issue, subtask.id)
    const marked = existing.find((e) => (e.description ?? "").includes(marker))
    if (marked) return { subtask, action: "skip", reason: `already created as ${marked.key} (marker found in its description)` }
    const sameTitle = existingByTitle.get(norm(subtask.title))
    if (sameTitle) return { subtask, action: "skip", reason: `an existing subtask has the same title: ${sameTitle.key}` }
    return { subtask, action: "create" }
  })
}
