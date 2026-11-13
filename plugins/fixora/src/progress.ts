// User-facing progress: synthetic rows in the origin session, markdown reports the agent presents
// verbatim, and RPC events for a TUI. Works identically whether or not a TUI is attached.

import type { Plugin } from "@opencode/plugin"
import type { FixoraOptions } from "./options.js"
import { beginStep, endStep, saveRun } from "./state.js"
import type { RunRecord, Services, Step, StepTiming } from "./types.js"

export type Emit = (name: string, data: Record<string, unknown>) => Promise<void>

export interface Runtime {
  ctx: Plugin.Context
  opts: FixoraOptions
  services: Services
  emit: Emit
  /** In-flight pipelines by runId, for cancel/restart. */
  inflight: Map<string, AbortController>
}

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

export async function progress(rt: Runtime, run: RunRecord, message: string) {
  await rt.emit("run.progress", { runId: run.runId, sessionID: run.originSessionID, step: run.step, message })
  await notify(rt.ctx, run.originSessionID, `fixora ${run.runId} · ${message}`)
}

export async function appendLog(folder: string, line: string) {
  const { appendFile, mkdir } = await import("node:fs/promises")
  await mkdir(folder, { recursive: true })
  await appendFile(`${folder}/run.log`, `${new Date().toISOString()} ${line}\n`)
}
