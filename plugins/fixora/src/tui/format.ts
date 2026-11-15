// Pure formatting, layout and grouping helpers for the panel (no Solid, no host imports) so
// bun:test covers every layout decision: column widths per panel width, wrapping, progress,
// crash ordering and the text of every row. The Solid components only pad and colour.

import type { CrashFix, CrashState, Step } from "../types.js"
import { isFixCandidate, isFixed, STATE_GLYPH } from "../crashstate.js"
import type { CrashRow, RunView, StageStatus, StageView } from "./store.js"

// ---------- time and numbers ----------

export const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
}

export const fmtShort = (ms: number | undefined) => {
  if (ms === undefined) return ""
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return fmtClock(ms)
}

/** "now" / "5m ago" / "3h ago" / "2d ago"; pass the store clock so rows stay reactive. */
export const relTime = (ms: number, now = Date.now()) => {
  const d = now - ms
  const m = Math.round(d / 60000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** 540 → "540", 1840 → "1.8k", 12400 → "12k", 1_200_000 → "1.2M". */
export const compactNumber = (n: number) => {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

export const meter = (value: number, width = 10) => {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * width)
  return { filled: "█".repeat(filled), empty: "░".repeat(width - filled) }
}

// ---------- text ----------

const isWide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1f64f) ||
  (cp >= 0x1f900 && cp <= 0x1f9ff) ||
  (cp >= 0x20000 && cp <= 0x3fffd)
const isZero = (cp: number) => (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || cp === 0xfe0f

/** Terminal columns a string occupies (CJK / emoji count 2, combining marks 0). */
export const displayWidth = (s: string) => {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    w += isZero(cp) ? 0 : isWide(cp) ? 2 : 1
  }
  return w
}

/** Collapses whitespace and cuts to `width` columns with an ellipsis. */
export const truncate = (text: string | undefined, width: number) => {
  const t = (text ?? "").replace(/\s+/g, " ").trim()
  if (displayWidth(t) <= width) return t
  if (width <= 1) return width === 1 ? "…" : ""
  let out = ""
  let w = 0
  for (const ch of t) {
    const cw = displayWidth(ch)
    if (w + cw > width - 1) break
    out += ch
    w += cw
  }
  return `${out}…`
}

/** Pads (or truncates with an ellipsis) to exactly `width` columns. */
export const padDisplay = (s: string, width: number, align: "left" | "right" = "left") => {
  const t = truncate(s, width)
  const pad = " ".repeat(Math.max(0, width - displayWidth(t)))
  return align === "right" ? `${pad}${t}` : `${t}${pad}`
}

/** Word-wraps into lines of at most `width` columns; long tokens are hard-broken; a cut last line ends with "…". */
export const wrap = (text: string | undefined, width: number, maxLines?: number): string[] => {
  const words = (text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean)
  if (words.length === 0 || width < 1) return []
  const lines: string[] = []
  let line = ""
  const push = () => {
    if (line) lines.push(line)
    line = ""
  }
  for (let word of words) {
    while (displayWidth(word) > width) {
      // hard break: fill the current line, then continue with the rest
      const room = width - (line ? displayWidth(line) + 1 : 0)
      if (room < 2) {
        push()
        continue
      }
      let head = ""
      let w = 0
      for (const ch of word) {
        const cw = displayWidth(ch)
        if (w + cw > room) break
        head += ch
        w += cw
      }
      line = line ? `${line} ${head}` : head
      word = word.slice(head.length)
      push()
    }
    if (!word) continue
    if (!line) line = word
    else if (displayWidth(line) + 1 + displayWidth(word) <= width) line = `${line} ${word}`
    else {
      push()
      line = word
    }
  }
  push()
  if (maxLines !== undefined && lines.length > maxLines) {
    const cut = lines.slice(0, Math.max(1, maxLines))
    cut[cut.length - 1] = truncate(`${cut[cut.length - 1]} ${lines.slice(cut.length).join(" ")}`, width)
    return cut
  }
  return lines
}

// ---------- tones ----------

export type ToneKey = "success" | "warning" | "error" | "accent" | "muted" | "base"

export const statusTone = (status: string): ToneKey => {
  switch (status) {
    case "ok":
    case "done":
      return "success"
    case "running":
      return "accent"
    case "awaiting-approval":
      return "warning"
    case "failed":
    case "rejected":
    case "blocked":
    case "review-exhausted":
    case "timeout":
      return "error"
    default:
      return "muted"
  }
}

export const stageTone = (status: StageStatus): ToneKey => (status === "ok" ? "success" : status === "running" ? "accent" : status === "failed" ? "error" : "muted")

export const crashTone = (state: string | undefined): ToneKey => {
  switch (state as CrashState | undefined) {
    case undefined:
    case "new":
      return "base"
    case "reopened":
    case "awaiting":
      return "warning"
    case "failed":
    case "mr_closed":
      return "error"
    case "in_progress":
      return "accent"
    case "mr_open":
    case "merged":
    case "released":
    case "fixed":
      return "success"
    default:
      return "muted"
  }
}

export const confidenceToneKey = (c: number): ToneKey => (c >= 0.75 ? "success" : c >= 0.5 ? "warning" : "error")

export const STATUS_LABEL: Record<string, string> = { running: "running", "awaiting-approval": "awaiting you", done: "done", failed: "failed", rejected: "rejected", skipped: "skipped", blocked: "blocked", "review-exhausted": "review exhausted", timeout: "timed out", cancelled: "cancelled" }
/** ≤ 9 columns, for the narrow runs list. */
export const STATUS_SHORT: Record<string, string> = { running: "running", "awaiting-approval": "awaiting", done: "done", failed: "failed", rejected: "rejected", skipped: "skipped", blocked: "blocked", "review-exhausted": "exhausted", timeout: "timeout", cancelled: "cancelled" }

// ---------- columns ----------

export interface Col {
  id: string
  min: number
  /** Takes the remaining width (first flex column wins). */
  flex?: boolean
  /** 0 = never dropped; higher priorities are dropped first when the width is short. */
  priority?: number
}
export type Layout = Record<string, number>

/** Column widths for `width`: optional columns are dropped (highest priority first) until the row fits, the rest goes to the flex column. */
export const fit = (width: number, cols: Col[], gap = 1): Layout => {
  const present = [...cols]
  const total = () => present.reduce((a, c) => a + c.min, 0) + Math.max(0, present.length - 1) * gap
  while (total() > width) {
    let drop = -1
    for (let i = 0; i < present.length; i++) {
      const p = present[i]!.priority ?? 0
      if (p > 0 && (drop < 0 || p >= (present[drop]!.priority ?? 0))) drop = i
    }
    if (drop < 0) break
    present.splice(drop, 1)
  }
  const layout: Layout = {}
  for (const c of present) layout[c.id] = c.min
  const flex = present.find((c) => c.flex)
  if (flex) layout[flex.id] = Math.max(flex.min, flex.min + width - total())
  return layout
}

export type Breakpoint = "narrow" | "medium" | "wide"
export const breakpoint = (width: number): Breakpoint => (width < 56 ? "narrow" : width < 84 ? "medium" : "wide")

export const runsLayout = (width: number): Layout => {
  const wide = breakpoint(width) === "wide"
  return fit(width, [
    { id: "cursor", min: 2 },
    { id: "glyph", min: 2 },
    { id: "chip", min: wide ? 16 : 9 },
    { id: "title", min: 12, flex: true },
    { id: "age", min: 7, priority: 1 },
    { id: "progress", min: 5, priority: 2 },
    { id: "stage", min: wide ? 18 : 12, priority: 3 },
    { id: "links", min: 14, priority: 4 },
  ])
}

export const crashesLayout = (width: number): Layout =>
  fit(width, [
    { id: "cursor", min: 2 },
    { id: "glyph", min: 2 },
    { id: "title", min: 12, flex: true },
    { id: "age", min: 7, priority: 1 },
    { id: "impact", min: 10, priority: 2 },
    { id: "badge", min: 18, priority: 3 },
    { id: "platform", min: 12, priority: 4 },
  ])

// ---------- pipeline ----------

export const progressOf = (stages: StageView[]): { done: number; total: number; current?: Step; pct: number } => {
  const total = stages.length
  const done = stages.filter((s) => s.status === "ok" || s.status === "skipped").length
  const current = stages.find((s) => s.status === "running")?.step ?? stages.find((s) => s.status === "failed")?.step ?? stages.find((s) => s.status === "pending")?.step
  return { done, total, current, pct: total ? done / total : 0 }
}

export const progressBar = (done: number, total: number, width: number) => {
  const w = Math.max(1, width)
  const filled = total > 0 ? Math.round(Math.max(0, Math.min(1, done / total)) * w) : 0
  return { filled: "▰".repeat(filled), empty: "▱".repeat(w - filled) }
}

export const counterLine = (c: RunView["counters"] | undefined) => {
  if (!c) return ""
  const parts: string[] = []
  if (c.fixRounds > 1) parts.push(`fix ×${c.fixRounds}`)
  if (c.reviewRounds > 1) parts.push(`review ×${c.reviewRounds}`)
  if (c.feedback > 0) parts.push(`feedback ${c.feedback}`)
  if (c.restarts > 0) parts.push(`restarts ${c.restarts}`)
  return parts.join(" · ")
}

export type TimelineRow = { kind: "stage"; stage: StageView } | { kind: "collapsed"; count: number; durationMs: number }

/** Folds ≥ 4 leading finished stages into one row so the active part of a long pipeline stays in view. */
export const collapseStages = (stages: StageView[], collapse: boolean): TimelineRow[] => {
  let lead = 0
  while (lead < stages.length && (stages[lead]!.status === "ok" || stages[lead]!.status === "skipped")) lead++
  if (!collapse || lead < 4 || lead === stages.length) return stages.map((stage) => ({ kind: "stage", stage }))
  const head = stages.slice(0, lead)
  return [{ kind: "collapsed", count: lead, durationMs: head.reduce((a, s) => a + (s.durationMs ?? 0), 0) }, ...stages.slice(lead).map((stage) => ({ kind: "stage" as const, stage }))]
}

// ---------- runs ----------

export const isActive = (status: string) => status === "running" || status === "awaiting-approval"

export const groupRuns = (runs: RunView[]): Array<{ key: "active" | "finished"; label: string; rows: RunView[] }> => {
  const active = runs.filter((r) => isActive(r.status))
  const finished = runs.filter((r) => !isActive(r.status))
  const out: Array<{ key: "active" | "finished"; label: string; rows: RunView[] }> = []
  if (active.length) out.push({ key: "active", label: "Active", rows: active })
  if (finished.length) out.push({ key: "finished", label: "Finished", rows: finished })
  return out
}

/** "MR open · DE-77" for the links column of a run row. */
export const runLinks = (r: Pick<RunView, "mrUrl" | "mrStatus" | "jiraKey">) => [r.mrUrl ? `MR ${r.mrStatus ?? "open"}` : "", r.jiraKey ?? ""].filter(Boolean).join(" · ")

// ---------- crashes ----------

export const sourceLabel: Record<string, string> = { sentry: "Sentry", crashlytics: "Crashlytics", manual: "Pasted" }

/** "DE-456 · MR !418 merged · release 3.2.2" for a crash Fixora already handled. */
export function fixBadge(fix: CrashFix | undefined): string {
  if (!fix) return ""
  const parts: string[] = []
  if (fix.jiraKey) parts.push(fix.jiraKey)
  if (fix.mrUrl) parts.push(`${fix.mrRef ?? "MR"}${fix.mrStatus ? ` ${fix.mrStatus}` : ""}`)
  if (fix.release) parts.push(`release ${fix.release}`)
  return parts.join(" · ")
}

export const STATE_ORDER: CrashState[] = ["new", "reopened", "failed", "awaiting", "in_progress", "mr_closed", "mr_open", "merged", "fixed", "released", "skipped"]
const stateRank = (state: string | undefined) => {
  const i = STATE_ORDER.indexOf((state ?? "new") as CrashState)
  return i < 0 ? STATE_ORDER.length : i
}

export type CrashSort = "state" | "source"

export const sortCrashes = (rows: CrashRow[], by: CrashSort): CrashRow[] =>
  [...rows].sort((a, b) => {
    if (by === "source") {
      const s = (sourceLabel[a.source] ?? a.source).localeCompare(sourceLabel[b.source] ?? b.source)
      if (s !== 0) return s
    }
    const r = stateRank(a.state) - stateRank(b.state)
    if (r !== 0) return r
    const u = (b.userCount ?? -1) - (a.userCount ?? -1)
    if (u !== 0) return u
    return (b.eventCount ?? -1) - (a.eventCount ?? -1)
  })

const BUCKET: Record<CrashState, string> = { new: "New", reopened: "Came back / failed", failed: "Came back / failed", mr_closed: "Came back / failed", awaiting: "In progress", in_progress: "In progress", mr_open: "Fixed", merged: "Fixed", fixed: "Fixed", released: "Fixed", skipped: "Skipped" }

/** Rows grouped for the list, in display order (input is expected to be sorted with `sortCrashes`). */
export const groupCrashes = (rows: CrashRow[], by: CrashSort): Array<{ key: string; label: string; rows: CrashRow[] }> => {
  const groups: Array<{ key: string; label: string; rows: CrashRow[] }> = []
  for (const c of rows) {
    const key = by === "source" ? c.source : (BUCKET[(c.state ?? "new") as CrashState] ?? "Other")
    const label = by === "source" ? (sourceLabel[c.source] ?? c.source) : key
    let g = groups.find((x) => x.key === key)
    if (!g) {
      g = { key, label, rows: [] }
      groups.push(g)
    }
    g.rows.push(c)
  }
  return groups
}

export const crashTally = (rows: CrashRow[]) => ({
  total: rows.length,
  new: rows.filter((c) => !c.state || c.state === "new").length,
  fixed: rows.filter((c) => isFixed(c.state)).length,
  inProgress: rows.filter((c) => c.state === "in_progress" || c.state === "awaiting").length,
  reopened: rows.filter((c) => c.state === "reopened").length,
  failed: rows.filter((c) => c.state === "failed" || c.state === "mr_closed").length,
  candidates: rows.filter((c) => isFixCandidate(c.state)).length,
})

/** "540 users" / "1.8k events" / "". */
export const crashImpact = (c: Pick<CrashRow, "userCount" | "eventCount">) => (c.userCount !== undefined ? `${compactNumber(c.userCount)} users` : c.eventCount !== undefined ? `${compactNumber(c.eventCount)} events` : "")

/** "android v3.2.1". */
export const crashMeta = (c: Pick<CrashRow, "platform" | "appVersion">) => [c.platform, c.appVersion ? `v${c.appVersion}` : undefined].filter(Boolean).join(" ")

export const crashGlyph = (c: Pick<CrashRow, "fix" | "state">) => STATE_GLYPH[(c.fix?.state ?? c.state ?? "new") as CrashState] ?? "·"

export interface SubLine {
  text: string
  href?: string
}

/** The detail lines under a selected crash row: what Fixora did, the links, the note. */
export const crashSubline = (c: CrashRow): SubLine[] => {
  const out: SubLine[] = []
  const f = c.fix
  if (f) {
    out.push({ text: `${STATE_GLYPH[f.state] ?? ""} ${f.label}${f.stillSeen && f.state !== "reopened" ? " · still seen" : ""} · run ${f.runId}`.trim() })
    if (f.note) out.push({ text: f.note })
    if (f.jiraKey) out.push({ text: `Jira ${f.jiraKey}`, href: f.jiraUrl })
    if (f.mrUrl) out.push({ text: `${f.mrRef ?? "MR"}${f.mrStatus ? ` ${f.mrStatus}` : ""}`, href: f.mrUrl })
  } else if (c.runId) out.push({ text: `run ${c.runId}` })
  if (c.url) out.push({ text: `${sourceLabel[c.source] ?? c.source}${c.fingerprint ? ` · ${c.fingerprint.slice(0, 12)}` : ""}`, href: c.url })
  return out
}

/** Rows a run can be started for from the list (the others are busy or already fixed → `--force`). */
export const crashBusy = (c: Pick<CrashRow, "state">) => c.state === "in_progress" || c.state === "awaiting"

// ---------- stage titles ----------

const STAGE_SHORT: Partial<Record<Step, string>> = { fetch: "Fetch", prepare: "Prepare", ticket: "Ticket", publish: "Publish", "close-loop": "Link", restore: "Restore" }
const STAGE_LONG: Record<Step, string> = { detect: "Detect", fetch: "Fetch crash", prepare: "Prepare checkout", analyse: "Root cause", ticket: "Jira ticket", fix: "Fix", validate: "Checks", review: "Review", publish: "Ticket · commit · push · MR", "close-loop": "Link", restore: "Restore checkout", done: "Done" }

/** Stage title that fits the panel: the long form at ≥ 70 columns, a short one below. */
export const stageTitle = (step: Step, width: number) => (width >= 70 ? STAGE_LONG[step] : (STAGE_SHORT[step] ?? STAGE_LONG[step])) ?? String(step)
/** Width of the stage-title column at this panel width. */
export const stageTitleWidth = (width: number) => (width >= 70 ? 28 : 11)
