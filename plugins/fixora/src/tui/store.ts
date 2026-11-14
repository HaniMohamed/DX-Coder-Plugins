// TUI state and pure reducers over the server's RPC events (no Solid imports, so bun:test can run it).

import { STEPS, type RunRecord, type Step } from "../types.js"
import type { GatePreview, RunSummary } from "../rpc.js"
import type { FunnelStats } from "../state.js"

export type StageStatus = "pending" | "running" | "ok" | "failed" | "skipped"

export interface StageView {
  step: Step
  status: StageStatus
  startedAt?: number
  durationMs?: number
  attempt?: number
  detail?: string
}

export interface RunView {
  runId: string
  sessionID: string
  title: string
  status: string
  step: Step
  stages: StageView[]
  startedAt: number
  updatedAt: number
  progress?: string
  confidence?: number
  rootCause?: string
  category?: string
  risk?: string
  introducedBy?: string
  files?: string[]
  checks?: string
  review?: string
  branch?: string
  jiraKey?: string
  jiraUrl?: string
  mrUrl?: string
  mrStatus?: string
  fixerSessionID?: string
  error?: string
  totalMs?: number
  report?: string
  gateId?: string
  gateKind?: string
  counters?: { fixRounds: number; reviewRounds: number; feedback: number; restarts: number }
  reopened?: string
}

export interface GateView {
  gateId: string
  runId: string
  sessionID: string
  kind: string
  summary: string
  preview: GatePreview
  acked: boolean
  dialogOpen: boolean
  createdAt: number
}

export interface CrashRow {
  source: string
  id: string
  title: string
  userCount?: number
  eventCount?: number
  lastSeen?: string
  appVersion?: string
  url?: string
  fingerprint?: string
  state?: string
  runId?: string
  ref?: string
  platform?: string
  appId?: string
}

export type PanelView = "run" | "runs" | "report"

export interface TuiState {
  runs: Record<string, RunView>
  order: string[]
  gates: Record<string, GateView>
  crashes: CrashRow[]
  crashesAt?: number
  sources: Array<{ id: string; status: string; serverName?: string }>
  now: number
  /** Which view the docked panel shows; everything stays inside the session, no full-screen pages. */
  view: PanelView
  /** Selected row in the runs view. */
  cursor: number
  /** Run pinned to the panel by `/fixora status <runId>`; otherwise the session's latest run. */
  pinned?: string
  report?: FunnelStats
}

export const STAGE_TITLES: Record<Step, string> = {
  detect: "Detect",
  fetch: "Fetch crash",
  map: "Map stack trace",
  branch: "Worktree + branch",
  analyse: "Root cause",
  ticket: "Jira ticket",
  fix: "Fix",
  validate: "Checks",
  review: "Review",
  commit: "Commit",
  push: "Push",
  mr: "Merge request",
  "close-loop": "Link",
  done: "Done",
}

export const initialState = (): TuiState => ({ runs: {}, order: [], gates: {}, crashes: [], sources: [], now: Date.now(), view: "run", cursor: 0 })

export const emptyStages = (): StageView[] => STEPS.filter((s) => s !== "done").map((step) => ({ step, status: "pending" }))

const touch = (state: TuiState, runId: string) => {
  if (!state.order.includes(runId)) state.order.unshift(runId)
  else state.order = [runId, ...state.order.filter((id) => id !== runId)]
}

export function ensureRun(state: TuiState, runId: string, sessionID: string, title?: string, now = Date.now()): RunView {
  let run = state.runs[runId]
  if (!run) {
    run = { runId, sessionID, title: title ?? runId, status: "running", step: "detect", stages: emptyStages(), startedAt: now, updatedAt: now }
    state.runs[runId] = run
  }
  if (title) run.title = title
  if (sessionID) run.sessionID = sessionID
  run.updatedAt = now
  touch(state, runId)
  return run
}

/** Server-side timing statuses map onto the panel's stage statuses. */
const stageStatus = (status: string): StageStatus => (status === "running" ? "running" : status === "ok" ? "ok" : status === "skipped" ? "skipped" : status === "failed" ? "failed" : "pending")

export function applyEvent(state: TuiState, name: string, data: Record<string, unknown>, now = Date.now()): TuiState {
  const runId = typeof data.runId === "string" ? data.runId : undefined
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : ""
  switch (name) {
    case "run.started": {
      if (!runId) break
      const run = ensureRun(state, runId, sessionID, typeof data.title === "string" ? data.title : undefined, now)
      run.status = "running"
      run.error = undefined
      run.report = undefined
      run.startedAt = now
      if (run.stages.every((s) => s.status === "ok" || s.status === "skipped")) run.stages = emptyStages()
      break
    }
    case "run.stage": {
      if (!runId) break
      const run = ensureRun(state, runId, sessionID, undefined, now)
      const step = data.step as Step
      const status = stageStatus(String(data.status))
      const stage = run.stages.find((s) => s.step === step)
      if (stage) {
        stage.status = status
        stage.attempt = typeof data.attempt === "number" ? data.attempt : stage.attempt
        stage.detail = typeof data.detail === "string" ? data.detail : status === "running" ? undefined : stage.detail
        if (status === "running") {
          stage.startedAt = now
          stage.durationMs = undefined
        } else if (typeof data.durationMs === "number") stage.durationMs = data.durationMs
      }
      run.step = step
      if (status === "running") {
        run.status = "running"
        run.progress = undefined
        // Everything after the current step is pending again (loops back to validate).
        const idx = STEPS.indexOf(step)
        for (const s of run.stages) if (STEPS.indexOf(s.step) > idx && s.status !== "pending") s.status = "pending"
      }
      break
    }
    case "run.progress": {
      if (!runId) break
      const run = ensureRun(state, runId, sessionID, undefined, now)
      run.progress = typeof data.message === "string" ? data.message : undefined
      break
    }
    case "run.card": {
      if (!runId) break
      const run = ensureRun(state, runId, sessionID, undefined, now)
      const card = (data.data ?? {}) as Record<string, unknown>
      if (data.kind === "triage") {
        run.confidence = typeof card.confidence === "number" ? card.confidence : run.confidence
        run.rootCause = typeof card.rootCause === "string" ? card.rootCause : run.rootCause
        run.category = typeof card.category === "string" ? card.category : run.category
        run.risk = typeof card.risk === "string" ? card.risk : run.risk
        run.introducedBy = typeof card.introducedBy === "string" ? card.introducedBy : run.introducedBy
        run.reopened = typeof card.reopened === "string" ? card.reopened : run.reopened
      } else if (data.kind === "validation") {
        run.files = Array.isArray(card.files) ? (card.files as string[]) : run.files
        run.checks = typeof card.checks === "string" ? card.checks : run.checks
        run.review = typeof card.review === "string" ? card.review : run.review
      } else if (data.kind === "ticket") run.jiraKey = typeof card.jiraKey === "string" ? card.jiraKey : run.jiraKey
      break
    }
    case "run.awaiting": {
      if (!runId || typeof data.gateId !== "string") break
      const run = ensureRun(state, runId, sessionID, undefined, now)
      run.status = "awaiting-approval"
      run.gateId = data.gateId
      run.gateKind = typeof data.kind === "string" ? data.kind : undefined
      state.gates[data.gateId] = { gateId: data.gateId, runId, sessionID, kind: String(data.kind ?? ""), summary: typeof data.summary === "string" ? data.summary : "", preview: (data.preview ?? {}) as GatePreview, acked: false, dialogOpen: false, createdAt: now }
      break
    }
    case "run.gate.resolved": {
      if (!runId) break
      const run = ensureRun(state, runId, sessionID, undefined, now)
      if (typeof data.gateId === "string") delete state.gates[data.gateId]
      run.gateId = undefined
      run.gateKind = undefined
      run.status = data.decision === "approved" ? "running" : "rejected"
      break
    }
    case "run.done": {
      if (!runId) break
      const run = ensureRun(state, runId, sessionID, undefined, now)
      run.status = "done"
      run.step = "done"
      run.mrUrl = typeof data.mrUrl === "string" ? data.mrUrl : run.mrUrl
      run.jiraKey = typeof data.jiraKey === "string" ? data.jiraKey : run.jiraKey
      run.branch = typeof data.branch === "string" ? data.branch : run.branch
      run.totalMs = typeof data.totalMs === "number" ? data.totalMs : run.totalMs
      run.report = typeof data.report === "string" ? data.report : run.report
      run.progress = undefined
      for (const s of run.stages) if (s.status === "running") s.status = "ok"
      break
    }
    case "run.failed": {
      if (!runId) break
      const run = ensureRun(state, runId, sessionID, undefined, now)
      run.status = typeof data.status === "string" ? data.status : "failed"
      run.step = (data.step as Step) ?? run.step
      run.error = typeof data.error === "string" ? data.error : run.error
      run.progress = undefined
      const stage = run.stages.find((s) => s.step === run.step)
      if (stage && stage.status === "running") stage.status = run.status === "skipped" ? "skipped" : "failed"
      for (const g of Object.values(state.gates)) if (g.runId === runId) delete state.gates[g.gateId]
      run.gateId = undefined
      break
    }
    case "crash.reopened": {
      if (!runId) break
      const run = ensureRun(state, runId, sessionID, undefined, now)
      run.reopened = typeof data.reason === "string" ? data.reason : "reopened"
      break
    }
  }
  state.now = now
  return state
}

/** Merges a `runs.list` summary into the store without clobbering live stage details. */
export function applySummary(state: TuiState, s: RunSummary, now = Date.now()): RunView {
  const run = ensureRun(state, s.runId, s.originSessionID ?? "", s.title, now)
  run.status = s.status
  run.step = s.step as Step
  run.confidence = s.confidence ?? run.confidence
  run.jiraKey = s.jiraKey ?? run.jiraKey
  run.jiraUrl = s.jiraUrl ?? run.jiraUrl
  run.mrUrl = s.mrUrl ?? run.mrUrl
  run.mrStatus = s.mrStatus ?? run.mrStatus
  run.branch = s.branch ?? run.branch
  run.fixerSessionID = s.fixerSessionID ?? run.fixerSessionID
  run.error = s.error ?? run.error
  run.totalMs = s.totalMs ?? run.totalMs
  run.counters = s.counters ?? run.counters
  run.startedAt = Date.parse(s.createdAt) || run.startedAt
  run.updatedAt = Date.parse(s.updatedAt) || run.updatedAt
  // Derive stage states from the recorded step when the live events were missed (e.g. TUI started later).
  const idx = STEPS.indexOf(run.step)
  if (run.stages.every((st) => st.status === "pending")) {
    for (const st of run.stages) {
      const i = STEPS.indexOf(st.step)
      if (i < idx) st.status = "ok"
      else if (i === idx) st.status = s.status === "done" ? "ok" : s.status === "running" ? "running" : s.status === "awaiting-approval" ? "running" : s.status === "skipped" ? "skipped" : "failed"
    }
    if (s.status === "done") for (const st of run.stages) if (st.status === "pending") st.status = "ok"
  }
  state.order.sort((a, b) => (state.runs[b]?.updatedAt ?? 0) - (state.runs[a]?.updatedAt ?? 0))
  return run
}

/** Fills the detail cards from a full run record (`runs.get`). */
export function applyRecord(state: TuiState, record: RunRecord, now = Date.now()): RunView {
  const run = ensureRun(state, record.runId, record.originSessionID, record.title, now)
  run.status = record.status
  run.step = record.step
  run.branch = record.branch ?? run.branch
  run.jiraKey = record.jiraKey ?? run.jiraKey
  run.jiraUrl = record.jiraUrl ?? run.jiraUrl
  run.mrUrl = record.mrUrl ?? run.mrUrl
  run.mrStatus = record.mrStatus ?? run.mrStatus
  run.fixerSessionID = record.sessions?.fixer ?? run.fixerSessionID
  run.error = record.error ?? run.error
  run.totalMs = record.totalMs ?? run.totalMs
  run.counters = record.counters ?? run.counters
  if (record.triage) {
    run.confidence = record.triage.confidence
    run.rootCause = record.triage.rootCause
    run.category = record.triage.category
    run.risk = record.fix?.risk.level ?? record.triage.risk.level
    const sc = record.triage.suspectCommits[0]
    if (sc) run.introducedBy = `${sc.sha.slice(0, 10)} ${sc.subject}${record.triage.introducedInRelease ? ` · ${record.triage.introducedInRelease}` : ""}`
  }
  if (record.fix) run.files = record.fix.filesChanged
  if (record.tests) run.checks = record.tests.commands.map((c) => `${c.kind} ${c.exitCode === 0 ? "✓" : "✗"}`).join(" · ")
  const review = record.reviews[record.reviews.length - 1]
  if (review) run.review = `${review.verdict} (round ${record.reviews.length})`
  if (record.reopened) run.reopened = record.reopened.reason ?? "reopened"
  for (const st of run.stages) {
    const t = record.timings[st.step]
    if (!t) continue
    st.status = stageStatus(t.status)
    st.durationMs = t.durationMs
    st.attempt = t.attempts
    st.startedAt = Date.parse(t.startedAt) || st.startedAt
  }
  return run
}

export const activeRuns = (state: TuiState) => state.order.map((id) => state.runs[id]!).filter((r) => r.status === "running" || r.status === "awaiting-approval")
export const awaitingGates = (state: TuiState) => Object.values(state.gates).sort((a, b) => a.createdAt - b.createdAt)
export const runsForSession = (state: TuiState, sessionID: string) => state.order.map((id) => state.runs[id]!).filter((r) => r.sessionID === sessionID)
export const panelRun = (state: TuiState, sessionID: string): RunView | undefined => {
  if (state.pinned && state.runs[state.pinned]) return state.runs[state.pinned]
  const mine = runsForSession(state, sessionID)
  return mine.find((r) => r.status === "awaiting-approval") ?? mine.find((r) => r.status === "running") ?? mine[0] ?? state.order.map((id) => state.runs[id]!)[0]
}

export const STATUS_GLYPH: Record<StageStatus, string> = { pending: "○", running: "◐", ok: "✓", failed: "✗", skipped: "–" }
export const SPINNER = ["◐", "◓", "◑", "◒"]

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
export const truncate = (text: string | undefined, width: number) => {
  const t = (text ?? "").replace(/\s+/g, " ").trim()
  return t.length <= width ? t : `${t.slice(0, Math.max(0, width - 1))}…`
}
export const relTime = (ms: number) => {
  const d = Date.now() - ms
  const m = Math.round(d / 60000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
export const meter = (value: number, width = 10) => {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * width)
  return { filled: "█".repeat(filled), empty: "░".repeat(width - filled) }
}
