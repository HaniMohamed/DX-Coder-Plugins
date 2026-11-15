// User-facing progress: synthetic rows in the origin session, markdown reports the agent presents
// verbatim, and RPC events for a TUI. Works identically whether or not a TUI is attached.

import type { Plugin } from "@opencode/plugin"
import type { ToolSchema } from "./mcp.js"
import type { FixoraOptions } from "./options.js"
import type { SourceContext } from "./sources/types.js"
import { beginStep, endStep, saveRun } from "./state.js"
import type { RunRecord, Services, Step, StepTiming } from "./types.js"

export type Emit = (name: string, data: Record<string, unknown>) => Promise<void>

export interface Inflight {
  controller: AbortController
  /** Resolves when the pipeline (including the restore phase) has finished. */
  done: Promise<RunRecord>
}

export interface Runtime {
  ctx: Plugin.Context
  opts: FixoraOptions
  services: Services
  /** Declared input schemas of the host's tools (refreshed with the services). */
  schemas?: Map<string, ToolSchema>
  emit: Emit
  /** In-flight pipelines by runId, for cancel/restart. */
  inflight: Map<string, Inflight>
  /** How often a run waiting for the repository lock polls (tests shorten it). */
  lockPollMs?: number
  /** Legacy-option warnings were shown once in this process. */
  warnedLegacy?: boolean
}

export const toolProps = (rt: Runtime, toolId: string): Record<string, unknown> => rt.schemas?.get(toolId)?.props ?? {}

export const sourceContext = (rt: Runtime): SourceContext => ({ options: rt.opts, services: rt.services, toolProps: (id) => toolProps(rt, id) })

/** Expected stop: the message is shown to the user as-is. */
export class FixoraStop extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FixoraStop"
  }
}

const GLYPH: Record<StepTiming["status"], string> = { ok: "✓", failed: "✗", skipped: "–", running: "◐" }

/** Short notice row in the TUI; `text` is what the model sees if the session resumes. */
export async function notify(ctx: Plugin.Context, sessionID: string, description: string, text = description) {
  await ctx.session.synthetic({ sessionID, text, description: description.slice(0, 160), resume: false })
}

/** Hands a report to the originating session's agent so it is presented as a visible reply. */
export async function present(ctx: Plugin.Context, sessionID: string, description: string, report: string, next?: string) {
  await ctx.session.synthetic({
    sessionID,
    description: description.slice(0, 160),
    text: `[fixora result] Present the following report to the user verbatim as markdown. Do not call tools, do not summarize away tables or links.\n\n${report}${next ? `\n\n${next}` : ""}`,
    resume: true,
  })
}

/** Asks the origin agent to relay a message to the user (used for expected stops and errors). */
export async function tell(ctx: Plugin.Context, sessionID: string, description: string, message: string) {
  await ctx.session.synthetic({
    sessionID,
    description: description.slice(0, 160),
    text: `[fixora] Tell the user exactly this, formatted as markdown, without calling tools:\n\n${message}`,
    resume: true,
  })
}

export async function stageBegin(rt: Runtime, run: RunRecord, step: Step, detail?: string) {
  beginStep(run, step)
  await saveRun(rt.ctx, run)
  await rt.emit("run.stage", { runId: run.runId, sessionID: run.originSessionID, step, status: "running", attempt: run.timings[step]?.attempts ?? 1, detail })
  await notify(rt.ctx, run.originSessionID, `fixora ${run.runId} · ◐ ${step}${detail ? ` — ${detail}` : ""}`)
}

export async function stageEnd(rt: Runtime, run: RunRecord, step: Step, status: StepTiming["status"], detail?: string, error?: string) {
  endStep(run, step, status, undefined, error)
  await saveRun(rt.ctx, run)
  const t = run.timings[step]
  await rt.emit("run.stage", { runId: run.runId, sessionID: run.originSessionID, step, status, durationMs: t?.durationMs, attempt: t?.attempts ?? 1, detail: detail ?? error })
  await notify(rt.ctx, run.originSessionID, `fixora ${run.runId} · ${GLYPH[status]} ${step}${t?.durationMs !== undefined ? ` (${Math.round(t.durationMs / 1000)}s)` : ""}${detail ? ` — ${detail}` : ""}${error ? ` — ${error.slice(0, 120)}` : ""}`)
}

const lastRow = new Map<string, number>()

/**
 * Live progress. The RPC event feeds the panel on every call; the chat row is rate-limited
 * (`quiet`: at most one row per 15 s per run) so frequent updates do not flood the session.
 */
export async function progress(rt: Runtime, run: RunRecord, message: string, o: { quiet?: boolean } = {}) {
  await rt.emit("run.progress", { runId: run.runId, sessionID: run.originSessionID, step: run.step, message })
  const now = Date.now()
  if (o.quiet && now - (lastRow.get(run.runId) ?? 0) < 15_000) return
  lastRow.set(run.runId, now)
  await notify(rt.ctx, run.originSessionID, `fixora ${run.runId} · ${message}`)
}

/** Human label for a worker tool call, from its input shape (the host event carries no tool name). */
export function describeToolCall(input: Record<string, unknown> | undefined): string {
  if (!input) return "working"
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined)
  const file = str("filePath") ?? str("path") ?? str("file_path") ?? str("file")
  const base = file ? file.split("/").slice(-2).join("/") : undefined
  if (str("command")) return `$ ${str("command")!.replace(/\s+/g, " ").slice(0, 80)}`
  if (file && (input.oldString !== undefined || input.old_string !== undefined || input.edits !== undefined)) return `editing ${base}`
  if (file && (input.content !== undefined || input.contents !== undefined)) return `writing ${base}`
  if (file && input.offset === undefined && input.limit === undefined && Object.keys(input).length === 1) return `reading ${base}`
  if (file) return `reading ${base}`
  if (str("pattern")) return `searching ${str("pattern")!.slice(0, 60)}`
  if (str("query")) return `looking up ${str("query")!.slice(0, 60)}`
  if (input.runId !== undefined && input.classification !== undefined) return "submitting the root cause"
  if (input.runId !== undefined && input.filesChanged !== undefined) return "submitting the fix report"
  if (input.runId !== undefined && input.verdict !== undefined) return "submitting the review"
  if (input.requestId !== undefined && input.results !== undefined) return "submitting the crash list"
  if (input.runId !== undefined && input.issue !== undefined) return "submitting the fetched crash"
  if (input.runId !== undefined && input.stage !== undefined) return "reporting the checkout"
  if (input.runId !== undefined && (input.committed !== undefined || input.pushed !== undefined || input.mr !== undefined || input.mrSkipped !== undefined)) return "reporting the publish result"
  if (input.runId !== undefined && input.action !== undefined) return "reporting the ticket"
  if (input.op !== undefined && input.ok !== undefined) return `finishing ${String(input.op)}`
  if (typeof input.toolId === "string" || (typeof input.appId === "string" && input.issueId !== undefined)) return "calling the crash source"
  if (str("question")) return "asking you a question"
  return "working"
}

export async function appendLog(folder: string, line: string) {
  const { appendFile, mkdir } = await import("node:fs/promises")
  await mkdir(folder, { recursive: true })
  await appendFile(`${folder}/run.log`, `${new Date().toISOString()} ${line}\n`)
}
