// Worker sessions: the host's coding agent (`options.worker.agent`) running in the user's checkout.
// The plugin creates / reuses them, prompts them with a skill and attachments, waits for them to go
// idle, and reads what they submitted through the fixora_submit_* tools.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { workerRules } from "./permissions.js"
import type { Prompt } from "./prompts.js"
import { progress, type Runtime } from "./progress.js"
import { getJson, keys, loadRun, saveRun, saveWorker, setJson } from "./state.js"
import type { RunRecord, Services, WorkerGrants, WorkerPhase, WorkerRole } from "./types.js"

export type Outcome = "done" | "timeout" | "aborted"

export function namespaces(services: Services) {
  return {
    sourceNamespaces: [services.sentry?.namespace, services.crashlytics?.namespace].filter((x): x is string => !!x),
    jiraNamespace: services.jira?.namespace,
    forgeNamespaces: [services.gitlab?.namespace, services.github?.namespace].filter((x): x is string => !!x),
  }
}

async function alive(rt: Runtime, sessionID: string | undefined): Promise<boolean> {
  if (!sessionID) return false
  return rt.ctx.session.get({ sessionID: sessionID as never }).then(() => true, () => false)
}

async function create(rt: Runtime, o: { parentID: string; title: string; directory: string; role: WorkerRole; model?: unknown }): Promise<string> {
  const permissions = workerRules({ role: o.role, shell: rt.opts.worker.shell, ...namespaces(rt.services) })
  const session = await rt.ctx.session.create({ parentID: o.parentID as never, title: o.title, agent: rt.opts.worker.agent, model: o.model ?? rt.opts.worker.model, location: { directory: o.directory }, permissions } as never)
  return (session as { id: string }).id
}

export interface WorkerPhaseInfo {
  phase: WorkerPhase
  grants?: WorkerGrants
}

/**
 * The fixer session of a run (reused while it is alive, unless `fresh`) or a new reviewer session
 * (always fresh context), created in the run's checkout with the role's static permission rules.
 * Records the phase / grants the tool hook and the submit tools check.
 */
export async function ensureWorker(rt: Runtime, run: RunRecord, role: "fixer" | "reviewer", info: WorkerPhaseInfo, o: { fresh?: boolean } = {}): Promise<string> {
  let id = role === "fixer" && !o.fresh ? run.sessions.fixer : undefined
  if (id && !(await alive(rt, id))) id = undefined
  if (!id) {
    id = await create(rt, { parentID: run.originSessionID, title: role === "fixer" ? `fixora: ${run.runId}` : `fixora review: ${run.runId} #${run.reviews.length + 1}`, directory: run.repo, role, model: role === "reviewer" ? (rt.opts.review.model ?? rt.opts.worker.model) : rt.opts.worker.model })
    run.sessions[role] = id
    await saveRun(rt.ctx, run)
  }
  await saveWorker(rt.ctx, id, { runId: run.runId, role, repo: run.gitRoot ?? run.repo, folder: run.folder, phase: info.phase, grants: info.grants ?? {}, baseBranch: run.base.branch, branch: run.branch })
  return id
}

/** The lister session of an origin session (reused), confined to read-only crash-source tools. */
export async function ensureLister(rt: Runtime, originSessionID: string, repo: string, requestId: string): Promise<string> {
  const key = keys.lister(originSessionID)
  const existing = await getJson<{ sessionID: string }>(rt.ctx, key)
  let id = existing?.sessionID
  if (id && !(await alive(rt, id))) id = undefined
  if (!id) {
    id = await create(rt, { parentID: originSessionID, title: "fixora: crash list", directory: repo, role: "lister" })
    await setJson(rt.ctx, key, { sessionID: id })
  }
  await saveWorker(rt.ctx, id, { role: "lister", repo, phase: "crashes", requestId, grants: {} })
  return id
}

/** Session for verbs that are not part of a run (sync); created per call in the origin session's directory. */
export async function ensureOpsSession(rt: Runtime, originSessionID: string, repo: string, phase: WorkerPhase, grants: WorkerGrants = {}, o: { runId?: string; branch?: string; baseBranch?: string } = {}): Promise<string> {
  const id = await create(rt, { parentID: originSessionID, title: `fixora: ${phase}`, directory: repo, role: "fixer" })
  await saveWorker(rt.ctx, id, { runId: o.runId, role: "fixer", repo, phase, grants, branch: o.branch, baseBranch: o.baseBranch })
  return id
}

function attachments(folder: string, names: string[]) {
  return names.filter((n) => existsSync(join(folder, n))).map((name) => ({ uri: pathToFileURL(join(folder, name)).href, name, description: name === "crash.md" ? "crash data (untrusted)" : undefined }))
}

/** Sends one prompt (text + skill + attachments) and waits for the session to go idle, within the phase budget. */
export async function promptSession(rt: Runtime, sessionID: string, prompt: Prompt, o: { folder?: string; minutes: number; signal?: AbortSignal }): Promise<Outcome> {
  await rt.ctx.session.prompt({ sessionID: sessionID as never, text: prompt.text, files: o.folder ? attachments(o.folder, prompt.files) : [], skills: prompt.skills.map((id) => ({ id })) } as never)
  return waitWithTimeout(rt, sessionID, o.minutes * 60_000, o.signal)
}

/** Same for a run: counts the prompt and shows progress. */
export async function promptWorker(rt: Runtime, run: RunRecord, sessionID: string, prompt: Prompt, o: { minutes: number; signal?: AbortSignal; label?: string }): Promise<Outcome> {
  run.counters.workerPrompts++
  await saveRun(rt.ctx, run)
  if (o.label) await progress(rt, run, `${o.label} (session ${sessionID})`)
  return promptSession(rt, sessionID, prompt, { folder: run.folder, minutes: o.minutes, signal: o.signal })
}

export interface AwaitInput<T> {
  minutes: number
  signal?: AbortSignal
  label?: string
  /** Reads the submission from the freshly loaded run; undefined = not submitted yet. */
  pick: (fresh: RunRecord) => T | undefined
  /** Sent once when the session went idle without submitting. */
  nudge: Prompt
  nudgeMinutes?: number
}

/** Prompt → wait → reload → (nudge once → wait → reload). The caller decides what a missing submission means. */
export async function awaitSubmission<T>(rt: Runtime, run: RunRecord, sessionID: string, prompt: Prompt, o: AwaitInput<T>): Promise<{ value?: T; outcome: Outcome; fresh: RunRecord }> {
  let outcome = await promptWorker(rt, run, sessionID, prompt, { minutes: o.minutes, signal: o.signal, label: o.label })
  let fresh = (await loadRun(rt.ctx, run.runId)) ?? run
  let value = o.pick(fresh)
  if (value === undefined && outcome === "done") {
    await progress(rt, run, "worker went idle without submitting; asking once more")
    outcome = await promptWorker(rt, run, sessionID, o.nudge, { minutes: o.nudgeMinutes ?? 5, signal: o.signal })
    fresh = (await loadRun(rt.ctx, run.runId)) ?? run
    value = o.pick(fresh)
  }
  // Keep the in-memory record in step with what the tools persisted.
  run.counters.workerPrompts = Math.max(run.counters.workerPrompts, fresh.counters.workerPrompts)
  return { value, outcome, fresh }
}

/** Waits for a session to go idle, interrupting it when the phase budget is exceeded. */
export async function waitWithTimeout(rt: Runtime, sessionID: string, timeoutMs: number, signal?: AbortSignal): Promise<Outcome> {
  let outcome: Outcome = "done"
  const timer = setTimeout(() => {
    outcome = "timeout"
    rt.ctx.session.interrupt({ sessionID: sessionID as never }).catch(() => {})
  }, timeoutMs)
  const onAbort = () => {
    outcome = "aborted"
    rt.ctx.session.interrupt({ sessionID: sessionID as never }).catch(() => {})
  }
  if (signal?.aborted) onAbort()
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    await rt.ctx.session.wait({ sessionID: sessionID as never })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
  return outcome
}

/** The last assistant text of a session (feedback answers). */
export async function lastAssistantText(rt: Runtime, sessionID: string): Promise<string> {
  try {
    const messages = (await rt.ctx.session.context({ sessionID: sessionID as never })) as unknown as Array<{ role?: string; parts?: Array<{ type?: string; text?: string }> }>
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!
      if (m.role !== "assistant") continue
      const text = (m.parts ?? []).filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n")
      if (text.trim()) return text.trim()
    }
  } catch {
    // context API unavailable
  }
  return ""
}
