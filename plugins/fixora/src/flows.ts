// Command verbs: list / fix / paste / top / batch / status / retry / feedback / restart / fixed /
// report / clean / sync. Deterministic work happens here and in pipeline.ts; the model only runs in
// worker sessions.

import { existsSync } from "node:fs"
import { copyFile, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Flags } from "./command.js"
import { git } from "./git.js"
import { connectJira } from "./jira.js"
import { connected, detectServices, INSTALL_SOURCES, listServers, renderDoctor } from "./mcp.js"
import { Pipeline } from "./pipeline.js"
import { FixoraStop, notify, present, tell, type Runtime } from "./progress.js"
import { renderCrashTable, renderFunnelReport, renderJiraComment, renderRunsTable, renderRunStatus } from "./render.js"
import { availableSources, listTopCrashes, resolveRef, runIdFor } from "./sources/index.js"
import { acquireLock, funnel, keys, listCrashIndex, listRuns, loadCrashIndex, loadRun, now, releaseLock, resumePoint, saveCrashIndex, saveRun, TERMINAL } from "./state.js"
import type { CrashSummary, RunRecord, Source, Step } from "./types.js"

export const folderFor = (rt: Runtime, runId: string) => join(rt.ctx.location.directory, ".dxcoder", "fixora", runId)

export function newRun(rt: Runtime, o: { runId: string; source: Source; crashId: string; sessionID: string; flags: Flags; refExtra?: Record<string, string>; title?: string }): RunRecord {
  const at = now()
  return {
    version: 1,
    runId: o.runId,
    source: o.source,
    crashId: o.crashId,
    fingerprint: "",
    title: o.title ?? o.runId,
    originSessionID: o.sessionID,
    createdAt: at,
    updatedAt: at,
    step: "detect",
    status: "running",
    flags: { dryRun: o.flags.dryRun, ticket: o.flags.ticket, push: o.flags.push, mr: o.flags.mr, auto: o.flags.auto, force: o.flags.force, testFirst: o.flags.testFirst ?? rt.opts.mode === "test-first" },
    base: { remote: rt.opts.remote, branch: o.flags.base ?? rt.opts.baseBranch },
    sessions: {},
    commitShas: [],
    reviews: [],
    counters: { fixRounds: 0, reviewRounds: 0, feedback: 0, restarts: 0, workerPrompts: 0 },
    pipeline: { analysed: false, ticketed: false, fixed: false, validated: false, reviewed: false, committed: false, pushed: false, mrOpened: false, loopClosed: false },
    timings: {},
    approvals: {},
    folder: folderFor(rt, o.runId),
    meta: { ...(o.refExtra ? { refExtra: JSON.stringify(o.refExtra) } : {}), ...(o.flags.forceTriage ? { forceTriage: true } : {}), ...(o.flags.tests ? { tests: o.flags.tests } : {}) },
  }
}

export async function refreshServices(rt: Runtime) {
  rt.services = await detectServices(rt.ctx)
  return rt.services
}

/** Runs the pipeline for a run record, tracking it as in flight. Resolves when the pipeline ends. */
export async function startPipeline(rt: Runtime, run: RunRecord, o: { from: Step; feedback?: string }): Promise<RunRecord> {
  if (rt.inflight.has(run.runId)) throw new FixoraStop(`Run ${run.runId} is already in progress. Use \`/fixora status ${run.runId}\`, or \`/fixora restart ${run.runId}\` to abort and start over.`)
  const lock = await acquireLock(rt.ctx, keys.lockCrash(run.runId), run.originSessionID)
  if (!lock.ok && !lock.stale) throw new FixoraStop(`Run ${run.runId} is locked by session ${lock.lock.owner} until ${lock.lock.expiresAt}. If that session is gone, wait for the lock to expire or \`/fixora restart ${run.runId}\`.`)
  if (!lock.ok && lock.stale) await notify(rt.ctx, run.originSessionID, `fixora ${run.runId}: reclaimed a stale lock from ${lock.lock.owner}`)
  const controller = new AbortController()
  rt.inflight.set(run.runId, controller)
  run.status = "running"
  await saveRun(rt.ctx, run)
  await rt.emit("run.started", { runId: run.runId, sessionID: run.originSessionID, title: run.title })
  return new Pipeline(rt, run, { from: o.from, signal: controller.signal, feedback: o.feedback }).execute()
}

// ---------- list ----------

export async function runList(rt: Runtime, input: { sessionID: string; top?: number; minUsers?: number; source?: Source }): Promise<{ crashes: CrashSummary[]; markdown: string }> {
  await refreshServices(rt)
  const sources = availableSources(rt.services, rt.opts)
  if (sources.length === 0) {
    const configured = Object.values(rt.services).filter((s) => s && (s.id === "sentry" || s.id === "crashlytics"))
    const hint = configured.length ? `\n\nConfigured but not connected: ${configured.map((s) => `${s!.id} ("${s!.serverName}", ${s!.status})`).join(", ")} — connect from /mcps.` : ""
    throw new FixoraStop(`${INSTALL_SOURCES}${hint}`)
  }
  const { crashes, errors } = await listTopCrashes({ ctx: rt.ctx, services: rt.services, options: rt.opts, sessionID: input.sessionID }, { top: input.top ?? rt.opts.batch.top * 2, minUsers: input.minUsers, source: input.source })
  const states = new Map<string, { state: string; runId?: string; mrUrl?: string }>()
  for (const c of crashes) {
    const run = await loadRun(rt.ctx, runIdFor(c.source, c.id))
    if (run) {
      c.runId = run.runId
      c.state = run.mrStatus === "merged" ? "merged" : run.mrUrl ? "mr_open" : run.status === "running" ? "in_progress" : run.status === "awaiting-approval" ? "awaiting" : run.status === "done" ? "fixed" : run.status === "skipped" ? "skipped" : run.reopened ? "reopened" : "failed"
      c.fingerprint = run.fingerprint
      states.set(run.fingerprint || run.runId, { state: c.state, runId: run.runId, mrUrl: run.mrUrl })
      if (!run.fingerprint) states.set(run.runId, { state: c.state, runId: run.runId, mrUrl: run.mrUrl })
    }
  }
  const table = renderCrashTable(crashes, { states })
  const markdown = [`### Fixora · top crashes (${sources.map((s) => s.id).join(", ")})`, "", table, ...(errors.length ? ["", `Errors: ${errors.join("; ")}`] : [])].join("\n")
  const file = join(rt.ctx.location.directory, ".dxcoder", "fixora", "crashes.md")
  await mkdir(join(rt.ctx.location.directory, ".dxcoder", "fixora"), { recursive: true })
  await writeFile(file, `${markdown}\n`)
  return { crashes, markdown }
}

export async function presentList(rt: Runtime, sessionID: string, list: { crashes: CrashSummary[]; markdown: string }) {
  const refs = list.crashes.slice(0, 10).map((c) => `${c.source}:${c.id}`)
  await rt.ctx.session.synthetic({
    sessionID: sessionID as never,
    description: `fixora: ${list.crashes.length} crash(es) listed`,
    text: [
      "[fixora] Present the following table to the user verbatim as markdown.",
      `Then, if the \`question\` tool is available, ask ONE multiple-choice question "Which crash should Fixora fix?" with these options (label = the ref, description = title and users): ${refs.join(", ")}, plus the option "Fix the top 3", plus "None for now". When the user answers, call the \`fixora_start\` tool with the chosen refs (for "Fix the top 3" pass the first three refs). If the question tool is not available, tell the user to run \`/fixora fix <ref>\`.`,
      "",
      list.markdown,
    ].join("\n"),
    resume: true,
  })
}

// ---------- fix / paste / top / batch ----------

export interface StartInput {
  sessionID: string
  ref: string
  flags: Flags
}

export async function prepareRun(rt: Runtime, input: StartInput): Promise<RunRecord> {
  const resolved = resolveRef(input.ref, rt.opts)
  if (!resolved) throw new FixoraStop(`"${input.ref}" is not a crash reference. Use \`sentry:<id>\`, \`crashlytics:<id>\`, a Sentry issue URL, a Firebase console issue URL, or \`/fixora paste <file>\`.`)
  if (resolved.source !== "manual") {
    await refreshServices(rt)
    const service = rt.services[resolved.source]
    if (!connected(service) || !rt.opts.sources.includes(resolved.source)) {
      const reason = !service ? `no ${resolved.source} MCP server is connected` : `the ${resolved.source} MCP server "${service.serverName}" is ${service.status}`
      throw new FixoraStop(`${reason}. Connect it from /mcps, or use \`/fixora paste <file>\` with the stack trace.\n\n${INSTALL_SOURCES}`)
    }
  }
  const runId = runIdFor(resolved.source, resolved.id)
  const existing = await loadRun(rt.ctx, runId)
  if (existing) {
    if (rt.inflight.has(existing.runId) || existing.status === "running" || existing.status === "awaiting-approval") {
      if (rt.inflight.has(existing.runId)) throw new FixoraStop(`Run ${runId} is already in progress (step ${existing.step}). \`/fixora status ${runId}\` shows it.`)
    }
    if (!input.flags.force) {
      if (existing.mrUrl || existing.status === "done") throw new FixoraStop(`Run ${runId} already ${existing.mrUrl ? `has a merge request: ${existing.mrUrl}` : "finished"}. Use \`/fixora feedback ${runId} "…"\` to change the fix, \`/fixora restart ${runId}\` for a fresh cycle, or \`--force\` to start over.`)
      if (!TERMINAL.has(existing.status)) throw new FixoraStop(`Run ${runId} stopped at step \`${existing.step}\` (${existing.status}${existing.error ? `: ${existing.error.slice(0, 160)}` : ""}). Use \`/fixora retry ${runId}\` to continue from there, or \`--force\` to start over.`)
    }
    await Pipeline.moveToHistory(existing.folder, input.flags.force ? ["trace.txt"] : ["crash.json", "crash.md", "run.log", "trace.txt"])
  }
  const run = newRun(rt, { runId, source: resolved.source, crashId: resolved.id, sessionID: input.sessionID, flags: input.flags, refExtra: resolved.extra })
  if (existing?.reopened) run.reopened = existing.reopened
  // A pasted trace lives in the run folder; keep pointing at it when the crash is re-run or restarted.
  if (!resolved.extra && existing?.meta?.refExtra) run.meta = { ...run.meta, refExtra: existing.meta.refExtra }
  if (existing?.title && run.title === run.runId) run.title = existing.title
  // A forced re-run is a new attempt: new branch and worktree names, the old ones are left for inspection.
  if (existing && input.flags.force) run.counters.restarts = (existing.counters?.restarts ?? 0) + 1
  await mkdir(run.folder, { recursive: true })
  await saveRun(rt.ctx, run)
  return run
}

export async function runFix(rt: Runtime, input: StartInput): Promise<RunRecord> {
  const run = await prepareRun(rt, input)
  return startPipeline(rt, run, { from: "detect" })
}

export async function runPaste(rt: Runtime, input: { sessionID: string; file: string; title?: string; platform?: string; language?: string; flags: Flags }): Promise<RunRecord> {
  const path = input.file.startsWith("/") ? input.file : join(rt.ctx.location.directory, input.file)
  if (!existsSync(path)) throw new FixoraStop(`File not found: ${path}`)
  const { crashFromText } = await import("./sources/manual.js")
  const text = await Bun.file(path).text()
  const crash = crashFromText({ text, title: input.title, platform: input.platform, language: input.language as never, appPackage: rt.opts.appPackage, inAppPrefixes: rt.opts.inAppPackages })
  if (crash.frames.length === 0) throw new FixoraStop("Could not parse any stack frame from the file. Supported: Dart/Flutter, Kotlin/Java, Swift/Objective-C, JavaScript/TypeScript, Python, Go, .NET, or any lines with path:line.")
  const runId = runIdFor("manual", crash.id)
  const folder = folderFor(rt, runId)
  await mkdir(folder, { recursive: true })
  const copy = join(folder, "trace.txt")
  await copyFile(path, copy)
  const extra: Record<string, string> = { file: copy }
  if (input.title) extra.title = input.title
  if (input.platform) extra.platform = input.platform
  if (input.language) extra.language = input.language
  const run = await prepareRun(rt, { sessionID: input.sessionID, ref: `manual:${crash.id}`, flags: input.flags })
  run.meta = { ...run.meta, refExtra: JSON.stringify(extra) }
  run.title = crash.title
  await saveRun(rt.ctx, run)
  return startPipeline(rt, run, { from: "detect" })
}

export async function runTop(rt: Runtime, input: { sessionID: string; count: number; minUsers?: number; source?: Source; maxMinutes?: number; flags: Flags }): Promise<{ started: string[]; errors: string[] }> {
  const list = await runList(rt, { sessionID: input.sessionID, top: input.count * 3, minUsers: input.minUsers, source: input.source })
  const candidates = list.crashes.filter((c) => !c.state || c.state === "new" || c.state === "failed" || c.state === "reopened").slice(0, input.count)
  if (candidates.length === 0) throw new FixoraStop("No new crashes to fix (every listed crash already has a run). Use `/fixora` to see them.")
  await notify(rt.ctx, input.sessionID, `fixora: fixing ${candidates.length} crash(es): ${candidates.map((c) => `${c.source}:${c.id}`).join(", ")}`)
  const deadline = input.maxMinutes ? Date.now() + input.maxMinutes * 60_000 : undefined
  const started: string[] = []
  const errors: string[] = []
  for (const c of candidates) {
    if (deadline && Date.now() > deadline) {
      errors.push(`time budget of ${input.maxMinutes} minutes exhausted before ${c.source}:${c.id}`)
      break
    }
    try {
      const run = await runFix(rt, { sessionID: input.sessionID, ref: `${c.source}:${c.id}`, flags: input.flags })
      started.push(`${run.runId} (${run.status})`)
    } catch (error) {
      errors.push(`${c.source}:${c.id}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
    }
  }
  return { started, errors }
}

// ---------- status / report / sync ----------

export async function runStatus(rt: Runtime, input: { sessionID: string; runId?: string }) {
  if (input.runId) {
    const run = await loadRun(rt.ctx, input.runId)
    if (!run) throw new FixoraStop(`No run ${input.runId}. \`/fixora status\` lists runs.`)
    if (rt.inflight.has(run.runId)) run.status = "running"
    await present(rt.ctx, input.sessionID, `fixora ${run.runId}: ${run.status} at ${run.step}`, renderRunStatus(run))
    return
  }
  const runs = await listRuns(rt.ctx)
  for (const r of runs) if (rt.inflight.has(r.runId)) r.status = "running"
  await present(rt.ctx, input.sessionID, `fixora: ${runs.length} run(s)`, renderRunsTable(runs.slice(0, 30)), runs.length ? "`/fixora status <runId>` shows one run in detail." : undefined)
}

export async function runReport(rt: Runtime, input: { sessionID: string; days: number }) {
  const [runs, crashes] = await Promise.all([listRuns(rt.ctx), listCrashIndex(rt.ctx)])
  const stats = funnel(runs, crashes, { days: input.days })
  await present(rt.ctx, input.sessionID, `fixora report: ${stats.total} run(s) in ${input.days} days`, renderFunnelReport(stats))
}

export async function runDoctor(rt: Runtime, input: { sessionID: string }) {
  await refreshServices(rt)
  const [servers, tools] = await Promise.all([listServers(rt.ctx), rt.ctx.tool.list()])
  const markdown = renderDoctor({ servers, toolIds: tools.map((t) => t.id), services: rt.services, options: rt.opts })
  await tell(rt.ctx, input.sessionID, "fixora doctor", markdown)
  return markdown
}

export async function runSync(rt: Runtime, input: { sessionID: string }) {
  await refreshServices(rt)
  const runs = (await listRuns(rt.ctx)).filter((r) => r.mrUrl && r.mrStatus !== "merged" && r.mrStatus !== "closed")
  let updated = 0
  for (const r of runs) {
    if (await Pipeline.syncMr(rt, r)) {
      updated++
      if (r.mrStatus === "merged") await notify(rt.ctx, input.sessionID, `fixora ${r.runId}: MR merged 🎉 — mark the release with /fixora fixed ${r.runId} --release <version>`)
    }
  }
  await notify(rt.ctx, input.sessionID, `fixora sync: ${runs.length} open MR(s) checked, ${updated} status change(s)`)
  return updated
}

// ---------- retry / feedback / restart / fixed / clean ----------

export async function runRetry(rt: Runtime, input: { sessionID: string; runId: string; from?: Step; fresh: boolean; flags: Flags }): Promise<RunRecord> {
  const run = await loadRun(rt.ctx, input.runId)
  if (!run) throw new FixoraStop(`No run ${input.runId}.`)
  if (rt.inflight.has(run.runId)) throw new FixoraStop(`Run ${run.runId} is still in progress.`)
  await refreshServices(rt)
  run.originSessionID = input.sessionID
  if (input.flags.base) run.base.branch = input.flags.base
  if (input.flags.forceTriage) run.meta = { ...run.meta, forceTriage: true }
  if (input.flags.tests) run.meta = { ...run.meta, tests: input.flags.tests }
  if (input.flags.dryRun) run.flags.dryRun = true
  if (!input.flags.ticket) run.flags.ticket = false
  if (!input.flags.mr) run.flags.mr = false
  if (!input.flags.push) run.flags.push = false
  if (input.flags.auto) run.flags.auto = true
  if (input.fresh && run.worktree) {
    await rt.ctx.worktree.remove({ projectID: rt.ctx.location.project.id, directory: run.worktree, force: true } as never).catch(() => {})
    run.worktree = undefined
    run.sessions = {}
  }
  let from = resumePoint(run, input.from)
  if (run.status === "done" && !input.from) throw new FixoraStop(`Run ${run.runId} is already done. Use \`/fixora feedback\` or \`/fixora restart\`.`)
  if (run.status === "skipped" && !input.from) from = run.meta?.forceTriage ? "analyse" : "fetch"
  if (run.status === "blocked" && !input.from) from = run.blockedReason === "dirty-worktree" ? "branch" : "validate"
  if (input.fresh) from = "detect"
  run.error = undefined
  run.blockedReason = undefined
  run.skipReason = undefined
  await notify(rt.ctx, input.sessionID, `fixora ${run.runId}: retrying from ${from}`)
  return startPipeline(rt, run, { from })
}

export async function runFeedback(rt: Runtime, input: { sessionID: string; runId: string; message: string }): Promise<RunRecord> {
  const run = await loadRun(rt.ctx, input.runId)
  if (!run) throw new FixoraStop(`No run ${input.runId}.`)
  if (rt.inflight.has(run.runId)) throw new FixoraStop(`Run ${run.runId} is still in progress.`)
  if (!run.worktree || !existsSync(run.worktree)) throw new FixoraStop(`Run ${run.runId} has no worktree any more. \`/fixora retry ${run.runId} --fresh\` to recreate it.`)
  await refreshServices(rt)
  run.originSessionID = input.sessionID
  run.counters.feedback++
  await writeFile(join(run.folder, "feedback.md"), `# Feedback ${run.counters.feedback}\n\n${input.message}\n`)
  await saveRun(rt.ctx, run)
  const controller = new AbortController()
  rt.inflight.set(run.runId, controller)
  await rt.emit("run.started", { runId: run.runId, sessionID: run.originSessionID, title: `${run.title} (feedback ${run.counters.feedback})` })
  const { FixoraFeedback } = await import("./feedback.js")
  // The worker answers or changes first, then the normal validate → review → commit → push → mr → close-loop loop runs.
  try {
    await FixoraFeedback.apply(rt, run, input.message, controller.signal)
  } catch (error) {
    rt.inflight.delete(run.runId)
    run.status = "failed"
    run.error = error instanceof Error ? error.message : String(error)
    await saveRun(rt.ctx, run)
    throw error
  }
  if (!run.pipeline.fixed || run.tests !== undefined) {
    rt.inflight.delete(run.runId)
    return run
  }
  return new Pipeline(rt, run, { from: "validate", signal: controller.signal, feedback: input.message }).execute()
}

export async function runRestart(rt: Runtime, input: { sessionID: string; runId: string; flags: Flags }): Promise<RunRecord> {
  const run = await loadRun(rt.ctx, input.runId)
  if (!run) throw new FixoraStop(`No run ${input.runId}.`)
  await refreshServices(rt)
  const inflight = rt.inflight.get(run.runId)
  if (inflight) {
    inflight.abort()
    rt.inflight.delete(run.runId)
    for (const s of [run.sessions.fixer, run.sessions.reviewer]) if (s) await rt.ctx.session.interrupt({ sessionID: s as never }).catch(() => {})
  }
  await releaseLock(rt.ctx, keys.lockCrash(run.runId)).catch(() => {})
  if (run.mrUrl) await Pipeline.closeMr(rt, run).catch(() => {})
  if (run.jiraKey) {
    const jira = await connectJira(rt.ctx, { service: rt.services.jira, options: rt.opts, sessionID: input.sessionID })
    await jira?.port.comment(run.jiraKey, renderJiraComment("restart", run)).catch(() => {})
  }
  if (run.worktree) {
    await rt.ctx.worktree.remove({ projectID: rt.ctx.location.project.id, directory: run.worktree, force: true } as never).catch(() => {})
  }
  await Pipeline.moveToHistory(run.folder)
  run.originSessionID = input.sessionID
  run.counters.restarts++
  run.counters.fixRounds = 0
  run.counters.reviewRounds = 0
  run.counters.feedback = 0
  run.branch = undefined
  run.worktree = undefined
  run.sessions = {}
  run.mrUrl = undefined
  run.mrId = undefined
  run.mrStatus = undefined
  run.mrProvider = undefined
  run.commitShas = []
  run.fix = undefined
  run.tests = undefined
  run.reviews = []
  run.triage = undefined
  run.pipeline = { analysed: false, ticketed: run.pipeline.ticketed, fixed: false, validated: false, reviewed: false, committed: false, pushed: false, mrOpened: false, loopClosed: false }
  run.approvals = {}
  run.timings = {}
  run.error = undefined
  run.blockedReason = undefined
  run.skipReason = undefined
  run.flags = { ...run.flags, force: true, dryRun: input.flags.dryRun || run.flags.dryRun, auto: input.flags.auto || run.flags.auto }
  await saveRun(rt.ctx, run)
  await notify(rt.ctx, input.sessionID, `fixora ${run.runId}: restarting (attempt ${run.counters.restarts + 1})`)
  return startPipeline(rt, run, { from: "fetch" })
}

export async function runFixed(rt: Runtime, input: { sessionID: string; runId: string; release: string; platform?: string }) {
  const run = await loadRun(rt.ctx, input.runId)
  if (!run) throw new FixoraStop(`No run ${input.runId}.`)
  const index = (await loadCrashIndex(rt.ctx, run.fingerprint)) ?? { fingerprint: run.fingerprint, runIds: [run.runId], reopened: { count: 0 } }
  index.fixedIn = { release: input.release, platform: input.platform, markedBy: input.sessionID, at: now(), runId: run.runId }
  index.reopened = { count: 0 }
  await saveCrashIndex(rt.ctx, index)
  run.meta = { ...run.meta, fixedIn: input.release, fixedPlatform: input.platform ?? null }
  await saveRun(rt.ctx, run)
  if (run.jiraKey) {
    await refreshServices(rt)
    const jira = await connectJira(rt.ctx, { service: rt.services.jira, options: rt.opts, sessionID: input.sessionID })
    await jira?.port.comment(run.jiraKey, renderJiraComment("fixed", run, { release: input.release })).catch(() => {})
  }
  await present(rt.ctx, input.sessionID, `fixora ${run.runId}: marked fixed in ${input.release}`, `Marked \`${run.runId}\` (${run.title}) as fixed in release **${input.release}**${input.platform ? ` (${input.platform})` : ""}. If the same crash fingerprint shows up again, Fixora will flag it as reopened.`)
}

export async function runClean(rt: Runtime, input: { sessionID: string; runId: string; remote: boolean }) {
  const run = await loadRun(rt.ctx, input.runId)
  if (!run) throw new FixoraStop(`No run ${input.runId}.`)
  if (rt.inflight.has(run.runId)) throw new FixoraStop(`Run ${run.runId} is in progress; restart or wait first.`)
  const notes: string[] = []
  if (run.worktree) {
    await rt.ctx.worktree.remove({ projectID: rt.ctx.location.project.id, directory: run.worktree, force: true } as never).then(() => notes.push(`removed worktree ${run.worktree}`), (e: Error) => notes.push(`worktree removal failed: ${e.message}`))
    run.worktree = undefined
  }
  if (input.remote && run.branch && run.pipeline.pushed) {
    await rt.ctx.permission.assert({ sessionID: input.sessionID as never, action: "fixora.delete-branch", resources: [`delete remote branch ${run.base.remote}/${run.branch}`], metadata: { runId: run.runId } })
    await git.deleteRemoteBranch(rt.ctx.location.directory, run.base.remote, run.branch, run.base.branch).then(() => notes.push(`deleted ${run.base.remote}/${run.branch}`), (e: Error) => notes.push(`remote branch deletion failed: ${e.message}`))
  }
  run.sessions = {}
  await saveRun(rt.ctx, run)
  await present(rt.ctx, input.sessionID, `fixora ${run.runId}: cleaned`, notes.map((n) => `- ${n}`).join("\n") || "Nothing to clean.")
}
