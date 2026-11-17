// Command verbs: list / fix / paste / top / batch / status / retry / feedback / restart / fixed /
// report / clean / sync / doctor. The plugin decides and records; the agent does every git, check
// and MCP action in worker sessions inside the session's checkout.

import { existsSync } from "node:fs"
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Flags } from "./command.js"
import { describeError } from "./errors.js"
import { crashFixOf, describeTally, isFixCandidate, tallyFixes } from "./crashstate.js"
import { parseRemote, shellQuote } from "./git.js"
import { jiraCommentInput } from "./jira.js"
import { connected, detectServices, INSTALL_SOURCES, listServers, renderDoctor, renderToolSchema, toolSchemas } from "./mcp.js"
import { mrListProviderOrder, renderMrList, renderMrOp, type MrListPlan, type MrListState, type MrProvider } from "./mr.js"
import { legacyOptionWarnings } from "./options.js"
import { Pipeline } from "./pipeline.js"
import { crashListPrompt, nudgePrompt, opsPrompt, recoverPrompt, restoreSteps, SKILLS, type OpStep } from "./prompts.js"
import { FixoraStop, notify, present, progress, sourceContext, tell, toolProps, type Runtime } from "./progress.js"
import { rankCandidates, rebuildIndex, rebuildRun, renderRecoverReport, type RecoverOutcome } from "./recover.js"
import { renderCrashTable, renderFunnelReport, renderJiraComment, renderRunsTable, renderRunStatus } from "./render.js"
import { ensureRunRepo, folderFor, readRemoteUrl, sessionRepo, type SessionRepo } from "./repo.js"
import { availableSources, listPlans, resolveRef, runIdFor } from "./sources/index.js"
import { acquireLock, funnel, getJson, keys, listCrashIndex, listKeys, listRuns, loadCrashIndex, loadRun, now, releaseLock, resumePoint, saveCrashIndex, saveRun, setJson, TERMINAL, wipeStorage } from "./state.js"
import type { CrashListRecord, RecoverRecord } from "./tools.js"
import type { CrashSummary, RunRecord, Source, Step, WorkerGrants, WorkerPhase } from "./types.js"
import { awaitSubmission, ensureLister, ensureRecoverSession, ensureWorker, promptSession } from "./worker.js"

export { folderFor }

const rand = () => Math.random().toString(36).slice(2, 10)

export function newRun(rt: Runtime, o: { runId: string; source: Source; crashId: string; sessionID: string; flags: Flags; refExtra?: Record<string, string>; title?: string; repo: SessionRepo }): RunRecord {
  const at = now()
  return {
    version: 1,
    runId: o.runId,
    source: o.source,
    crashId: o.crashId,
    fingerprint: "",
    title: o.title ?? o.runId,
    originSessionID: o.sessionID,
    repo: o.repo.repo,
    createdAt: at,
    updatedAt: at,
    step: "detect",
    status: "running",
    flags: { dryRun: o.flags.dryRun, ticket: o.flags.ticket, push: o.flags.push, mr: o.flags.mr, auto: o.flags.auto, force: o.flags.force, testFirst: o.flags.testFirst ?? rt.opts.mode === "test-first" },
    base: { remote: rt.opts.remote, branch: o.flags.base ?? rt.opts.baseBranch },
    checkout: { active: false },
    sessions: {},
    commitShas: [],
    reviews: [],
    counters: { fixRounds: 0, reviewRounds: 0, feedback: 0, restarts: 0, workerPrompts: 0 },
    pipeline: { analysed: false, ticketed: false, fixed: false, validated: false, reviewed: false, committed: false, pushed: false, mrOpened: false, loopClosed: false },
    timings: {},
    approvals: {},
    folder: folderFor(o.repo.repo, o.runId),
    meta: { ...(o.refExtra ? { refExtra: JSON.stringify(o.refExtra) } : {}), ...(o.flags.forceTriage ? { forceTriage: true } : {}), ...(o.flags.tests ? { tests: o.flags.tests } : {}) },
  }
}

/** Re-reads the host's tools and MCP servers (read-only) and caches the tool schemas. */
export async function refreshServices(rt: Runtime) {
  const [services, schemas] = await Promise.all([detectServices(rt.ctx), toolSchemas(rt.ctx).catch(() => new Map())])
  rt.services = services
  rt.schemas = schemas
  return rt.services
}

/** Shows the legacy-option warnings once per process. */
export async function warnLegacyOnce(rt: Runtime, sessionID: string) {
  if (rt.warnedLegacy) return
  rt.warnedLegacy = true
  const warnings = legacyOptionWarnings(rt.ctx.options)
  if (warnings.length) await notify(rt.ctx, sessionID, `fixora: ignored legacy options — ${warnings.join("; ")}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Runs the pipeline for a run record, tracking it as in flight. One checkout cannot host two runs,
 * so a repository lock serialises them (polled, within the batch time budget). Resolves when the
 * pipeline, including the restore phase, has ended.
 */
export async function startPipeline(rt: Runtime, run: RunRecord, o: { from: Step; feedback?: string }): Promise<RunRecord> {
  if (rt.inflight.has(run.runId)) throw new FixoraStop(`Run ${run.runId} is already in progress. Use \`/fixora status ${run.runId}\`, or \`/fixora restart ${run.runId}\` to abort and start over.`)
  const lock = await acquireLock(rt.ctx, keys.lockCrash(run.runId), run.originSessionID)
  if (!lock.ok && !lock.stale) throw new FixoraStop(`Run ${run.runId} is locked by session ${lock.lock.owner} until ${lock.lock.expiresAt}. If that session is gone, wait for the lock to expire or \`/fixora restart ${run.runId}\`.`)
  if (!lock.ok && lock.stale) await notify(rt.ctx, run.originSessionID, `fixora ${run.runId}: reclaimed a stale lock from ${lock.lock.owner}`)
  const controller = new AbortController()
  const repoKey = keys.lockRepo(run.repo)
  const done = (async () => {
    try {
      // Wait for the checkout: another run may be using it.
      const deadline = Date.now() + rt.opts.batch.maxMinutes * 60_000
      let waited = false
      for (;;) {
        const r = await acquireLock(rt.ctx, repoKey, run.runId)
        if (r.ok || r.stale) break
        if (controller.signal.aborted) throw new FixoraStop(`run ${run.runId} was cancelled while waiting for the checkout`)
        if (Date.now() > deadline) throw new FixoraStop(`Run ${run.runId} waited ${rt.opts.batch.maxMinutes} minutes for the checkout ${run.repo}, still used by run ${r.lock.owner}. Retry later or \`/fixora restart ${r.lock.owner}\`.`)
        if (!waited) {
          waited = true
          await progress(rt, run, `waiting for the checkout (used by run ${r.lock.owner})`)
        }
        await sleep(rt.lockPollMs ?? 5000)
      }
      run.status = "running"
      await saveRun(rt.ctx, run)
      await rt.emit("run.started", { runId: run.runId, sessionID: run.originSessionID, title: run.title })
      return await new Pipeline(rt, run, { from: o.from, signal: controller.signal, feedback: o.feedback }).execute()
    } catch (error) {
      // Only the lock wait can throw here; the pipeline reports its own failures.
      run.status = "failed"
      run.error = describeError(error)
      await saveRun(rt.ctx, run)
      await tell(rt.ctx, run.originSessionID, `fixora ${run.runId}: ${run.error.slice(0, 120)}`, run.error)
      return run
    } finally {
      rt.inflight.delete(run.runId)
      const held = await getJson<{ owner: string }>(rt.ctx, repoKey)
      if (held?.owner === run.runId) await releaseLock(rt.ctx, repoKey).catch(() => {})
      await releaseLock(rt.ctx, keys.lockCrash(run.runId)).catch(() => {})
    }
  })()
  rt.inflight.set(run.runId, { controller, done })
  return done
}

// ---------- list ----------

export interface ListInput {
  sessionID: string
  top?: number
  minUsers?: number
  source?: Source
  /** Only this platform's Firebase app(s): "android", "ios" or "web". */
  platform?: string
  refresh?: boolean
  /** Diagnostic: keep raw replies and never use the cache. */
  probe?: boolean
}

/** Lists the top crashes through a lister session (the agent makes the MCP calls). Cached per origin session. */
export async function runList(rt: Runtime, input: ListInput): Promise<{ crashes: CrashSummary[]; markdown: string; errors: string[]; record?: CrashListRecord }> {
  await refreshServices(rt)
  const sources = availableSources(rt.services, rt.opts)
  if (sources.length === 0) {
    const configured = Object.values(rt.services).filter((s) => s && (s.id === "sentry" || s.id === "crashlytics"))
    const hint = configured.length ? `\n\nConfigured but not connected: ${configured.map((s) => `${s!.id} ("${s!.serverName}", ${s!.status})`).join(", ")} — connect from /mcps.` : ""
    throw new FixoraStop(`${INSTALL_SOURCES}${hint}`)
  }
  const query = { top: input.top ?? rt.opts.batch.top * 2, minUsers: input.minUsers, source: input.source, platform: input.platform }
  const where = await sessionRepo(rt.ctx, input.sessionID)
  const listerKey = keys.lister(input.sessionID)
  const listerRecord = (await getJson<{ sessionID?: string; lastRequestId?: string }>(rt.ctx, listerKey)) ?? {}
  let record: CrashListRecord | undefined
  if (!input.refresh && !input.probe && listerRecord.lastRequestId) {
    const cached = await getJson<CrashListRecord>(rt.ctx, keys.crashes(listerRecord.lastRequestId))
    const fresh = cached?.result && Date.now() - Date.parse(cached.result.at) < rt.opts.crashes.cacheMinutes * 60_000
    if (cached && fresh && cached.query.top === query.top && cached.query.minUsers === query.minUsers && cached.query.source === query.source && cached.query.platform === query.platform) record = cached
  }
  if (!record) {
    const sc = sourceContext(rt)
    const { plans, errors: planErrors } = listPlans(sc, { ...query, top: input.probe ? 3 : query.top })
    if (plans.length === 0) throw new FixoraStop(`No crash source can be queried: ${planErrors.join("; ") || "no list tool found"}.`)
    const requestId = `list-${rand()}`
    record = { requestId, originSessionID: input.sessionID, createdAt: now(), query, plans, planErrors }
    await setJson(rt.ctx, keys.crashes(requestId), record)
    const sessionID = await ensureLister(rt, input.sessionID, where.repo, requestId)
    await setJson(rt.ctx, listerKey, { ...(await getJson<{ sessionID: string }>(rt.ctx, listerKey)), lastRequestId: requestId })
    await notify(rt.ctx, input.sessionID, `fixora: the agent is listing crashes from ${plans.map((p) => p.source).join(", ")} (session ${sessionID})`)
    const prompt = crashListPrompt({ requestId, plans, top: query.top, probe: input.probe })
    let outcome = await promptSession(rt, sessionID, prompt, { minutes: rt.opts.worker.maxPhaseMinutes.list })
    record = (await getJson<CrashListRecord>(rt.ctx, keys.crashes(requestId))) ?? record
    if (!record.result && outcome === "done") {
      outcome = await promptSession(rt, sessionID, nudgePrompt("fixora_submit_crashes", undefined, [SKILLS.crashes], `requestId "${requestId}" and every reply or error you got`), { minutes: 3 })
      record = (await getJson<CrashListRecord>(rt.ctx, keys.crashes(requestId))) ?? record
    }
    if (!record.result) throw new FixoraStop(outcome === "timeout" ? `Listing crashes exceeded ${rt.opts.worker.maxPhaseMinutes.list} minutes. See the lister session ${sessionID} and try again.` : `The lister session ${sessionID} did not report the crash list. See that session, then run /fixora again.`)
  }
  const crashes = await annotateFixes(rt, record.result!.crashes.map((c) => ({ ...c })))
  const errors = [...record.result!.errors]
  const table = renderCrashTable(crashes)
  const hint = errors.length && crashes.length === 0 ? "\n\nEvery source call failed. HTML / 5xx / \"Unable to parse JSON\" errors are usually transient on the Google side or a proxy: run `/fixora` again, or `/fixora doctor --probe` to see the raw replies. 401 / 403 mean the MCP server's account cannot read this project." : ""
  const markdown = [`### Fixora · top crashes (${sources.map((s) => s.id).join(", ")}${query.platform ? `, ${query.platform} only` : ""})`, "", table, ...(errors.length ? ["", `Errors: ${errors.join("; ")}${hint}`] : [])].join("\n")
  const file = join(where.repo, ".dxcoder", "fixora", "crashes.md")
  await mkdir(join(where.repo, ".dxcoder", "fixora"), { recursive: true })
  await writeFile(file, `${markdown}\n`)
  return { crashes, markdown, errors, record }
}

/**
 * Marks every listed crash Fixora already worked on: state, label, Jira / MR links, release and
 * reopen history (`crash.fix`), derived from the run record and the crash index. Runs in flight in
 * this process are reported as such even when storage lags behind.
 */
export async function annotateFixes(rt: Runtime, crashes: CrashSummary[], now = new Date().toISOString()): Promise<CrashSummary[]> {
  for (const c of crashes) {
    const run = await loadRun(rt.ctx, runIdFor(c.source, c.id))
    if (!run) continue
    const index = run.fingerprint ? await loadCrashIndex(rt.ctx, run.fingerprint) : undefined
    const fix = crashFixOf(run, { index, crash: c, inflight: rt.inflight.has(run.runId), now })
    c.runId = run.runId
    c.state = fix.state
    c.fix = fix
    if (run.fingerprint) c.fingerprint = run.fingerprint
  }
  return crashes
}

export async function presentList(rt: Runtime, sessionID: string, list: { crashes: CrashSummary[]; markdown: string }) {
  const ref = (c: CrashSummary) => c.ref ?? `${c.source}:${c.id}`
  const candidates = list.crashes.filter((c) => isFixCandidate(c.state)).slice(0, 10)
  const tally = tallyFixes(list.crashes)
  const fixed = list.crashes.filter((c) => c.fix && !isFixCandidate(c.state))
  const ask = candidates.length
    ? `Then, if the \`question\` tool is available, ask ONE multiple-choice question "Which crash should Fixora fix?" with these options (label = the ref, description = title and users): ${candidates.map(ref).join(", ")}, plus the option "Fix the top ${Math.min(3, candidates.length)}", plus "None for now". When the user answers, call the \`fixora_start\` tool with the chosen refs (for "Fix the top N" pass the first ${Math.min(3, candidates.length)} of these refs). If the question tool is not available, tell the user to run \`/fixora fix <ref>\`.`
    : "Every listed crash already has a Fixora run (see the table); do not offer to start one. Point the user at the links and the commands under the table instead."
  const skip = fixed.length ? `Do NOT offer these ${fixed.length} crash(es), they already have a Fixora run: ${fixed.map((c) => `${ref(c)} = ${c.fix!.label}`).join("; ")}. If the user asks about one of them, show its Jira / MR links from the table and suggest the command listed under "Already handled by Fixora".` : ""
  await rt.ctx.session.synthetic({
    sessionID: sessionID as never,
    description: `fixora: ${list.crashes.length} crash(es) listed, ${tally.fixed} already fixed`,
    text: ["[fixora] Present the following table to the user verbatim as markdown (keep the links).", ask, skip, "", list.markdown].filter(Boolean).join("\n"),
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
    if (rt.inflight.has(existing.runId)) throw new FixoraStop(`Run ${runId} is already in progress (step ${existing.step}). \`/fixora status ${runId}\` shows it.`)
    if (!input.flags.force) {
      if (existing.mrUrl || existing.status === "done") throw new FixoraStop(`Run ${runId} already ${existing.mrUrl ? `has a merge request: ${existing.mrUrl}` : "finished"}. Use \`/fixora feedback ${runId} "…"\` to change the fix, \`/fixora restart ${runId}\` for a fresh cycle, or \`--force\` to start over.`)
      if (!TERMINAL.has(existing.status)) throw new FixoraStop(`Run ${runId} stopped at step \`${existing.step}\` (${existing.status}${existing.error ? `: ${existing.error.slice(0, 160)}` : ""}). Use \`/fixora retry ${runId}\` to continue from there, or \`--force\` to start over.`)
    }
    if (existing.checkout?.active) throw new FixoraStop(`Run ${runId} still has its branch checked out in ${existing.repo} (restore pending). Run \`/fixora clean ${runId}\` first, or \`/fixora retry ${runId}\`.`)
    await Pipeline.moveToHistory(existing.folder, input.flags.force ? ["trace.txt"] : ["crash.json", "crash.md", "run.log", "trace.txt"])
  }
  const repo = await sessionRepo(rt.ctx, input.sessionID)
  const run = newRun(rt, { runId, source: resolved.source, crashId: resolved.id, sessionID: input.sessionID, flags: input.flags, refExtra: resolved.extra, repo })
  if (existing?.reopened) run.reopened = existing.reopened
  // A pasted trace lives in the run folder; keep pointing at it when the crash is re-run or restarted.
  if (!resolved.extra && existing?.meta?.refExtra) run.meta = { ...run.meta, refExtra: existing.meta.refExtra }
  if (existing?.title && run.title === run.runId) run.title = existing.title
  // A forced re-run is a new attempt: a new branch name, the old one is left for inspection.
  if (existing && input.flags.force) run.counters.restarts = (existing.counters?.restarts ?? 0) + 1
  await mkdir(run.folder, { recursive: true })
  await saveRun(rt.ctx, run)
  return run
}

export async function runFix(rt: Runtime, input: StartInput): Promise<RunRecord> {
  await warnLegacyOnce(rt, input.sessionID)
  const run = await prepareRun(rt, input)
  return startPipeline(rt, run, { from: "detect" })
}

export async function runPaste(rt: Runtime, input: { sessionID: string; file: string; title?: string; platform?: string; language?: string; flags: Flags }): Promise<RunRecord> {
  await warnLegacyOnce(rt, input.sessionID)
  const where = await sessionRepo(rt.ctx, input.sessionID)
  const path = input.file.startsWith("/") ? input.file : join(where.directory, input.file)
  if (!existsSync(path)) throw new FixoraStop(`File not found: ${path}`)
  const { crashFromText } = await import("./sources/manual.js")
  const text = await Bun.file(path).text()
  const crash = crashFromText({ text, title: input.title, platform: input.platform, language: input.language as never, appPackage: rt.opts.appPackage, inAppPrefixes: rt.opts.inAppPackages })
  if (crash.frames.length === 0) throw new FixoraStop("Could not parse any stack frame from the file. Supported: Dart/Flutter, Kotlin/Java, Swift/Objective-C, JavaScript/TypeScript, Python, Go, .NET, or any lines with path:line.")
  const runId = runIdFor("manual", crash.id)
  const folder = folderFor(where.repo, runId)
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

export async function runTop(rt: Runtime, input: { sessionID: string; count: number; minUsers?: number; source?: Source; platform?: string; maxMinutes?: number; flags: Flags }): Promise<{ started: string[]; errors: string[] }> {
  const list = await runList(rt, { sessionID: input.sessionID, top: input.count * 3, minUsers: input.minUsers, source: input.source, platform: input.platform })
  const candidates = list.crashes.filter((c) => isFixCandidate(c.state)).slice(0, input.count)
  if (candidates.length === 0) throw new FixoraStop(`No new crashes to fix: ${describeTally(tallyFixes(list.crashes))}. Run \`/fixora\` to see the links, or \`/fixora fix <ref> --force\` to fix one again.`)
  await notify(rt.ctx, input.sessionID, `fixora: fixing ${candidates.length} crash(es) one after the other: ${candidates.map((c) => c.ref ?? `${c.source}:${c.id}`).join(", ")}`)
  const deadline = input.maxMinutes ? Date.now() + input.maxMinutes * 60_000 : undefined
  const started: string[] = []
  const errors: string[] = []
  for (const c of candidates) {
    if (deadline && Date.now() > deadline) {
      errors.push(`time budget of ${input.maxMinutes} minutes exhausted before ${c.source}:${c.id}`)
      break
    }
    try {
      const run = await runFix(rt, { sessionID: input.sessionID, ref: c.ref ?? `${c.source}:${c.id}`, flags: input.flags })
      started.push(`${run.runId} (${run.status})`)
    } catch (error) {
      errors.push(`${c.source}:${c.id}: ${describeError(error).split("\n")[0]}`)
    }
  }
  return { started, errors }
}

// ---------- status / report / doctor / sync ----------

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

export async function runDoctor(rt: Runtime, input: { sessionID: string; all?: boolean; probe?: boolean; tool?: string }) {
  await refreshServices(rt)
  const [servers, tools] = await Promise.all([listServers(rt.ctx), rt.ctx.tool.list()])
  if (input.tool) {
    const markdown = renderToolSchema(input.tool, tools.find((t) => t.id === input.tool) as never)
    await tell(rt.ctx, input.sessionID, `fixora doctor --tool ${input.tool}`, markdown)
    return markdown
  }
  let markdown = renderDoctor({ servers, toolIds: tools.map((t) => t.id), services: rt.services, options: rt.opts, all: input.all, warnings: legacyOptionWarnings(rt.ctx.options), version: rt.version, eventFailures: rt.emitFailures ? `${rt.emitFailures} panel event(s) were refused by the host — last error: ${rt.lastEmitError ?? "?"}` : undefined })
  if (input.probe) markdown += `\n\n${await probeSources(rt, input.sessionID)}`
  await tell(rt.ctx, input.sessionID, "fixora doctor", markdown)
  return markdown
}

/** `/fixora doctor --probe`: the lister makes one real call per crash source and app; the raw replies are shown. */
export async function probeSources(rt: Runtime, sessionID: string): Promise<string> {
  const L: string[] = ["### Probe (one live call per source, made by the agent)", ""]
  const clip = (v: unknown) => {
    const text = typeof v === "string" ? v : JSON.stringify(v, null, 1)
    return text.length > 1800 ? `${text.slice(0, 1800)}\n… (${text.length - 1800} more chars)` : text
  }
  let list: Awaited<ReturnType<typeof runList>>
  try {
    list = await runList(rt, { sessionID, top: 3, probe: true })
  } catch (error) {
    return [...L, `- ${describeError(error)}`].join("\n")
  }
  const raw = (list.record?.result?.raw ?? []) as Array<{ source: string; toolId: string; appId?: string; raw?: unknown; error?: string }>
  for (const r of raw) {
    const call = list.record?.plans.find((p) => p.source === r.source)?.calls.find((c) => c.toolId === r.toolId && (!r.appId || c.appId === r.appId))
    L.push(`**${r.source}${r.appId ? ` · ${r.appId}` : ""}** → \`${r.toolId}\` with input:`, "", "```json", JSON.stringify(call?.input ?? {}), "```")
    if (r.error) L.push("", `Error: ${r.error}`)
    else L.push("", `Reply (${typeof r.raw === "string" ? "text" : "object"}):`, "", "```", clip(r.raw), "```")
    L.push("")
  }
  if (raw.length === 0) L.push(`- the lister reported nothing${list.errors.length ? `: ${list.errors.join("; ")}` : ""}`)
  return L.join("\n")
}

/** One ops prompt for an existing run (outside the pipeline): sync / close-mr / jira-comment / clean / restore. */
export async function opsRound(rt: Runtime, run: RunRecord, o: { phase: WorkerPhase; grants?: WorkerGrants; op: string; title: string; steps: OpStep[]; report: string; minutes?: number }): Promise<{ ok: boolean; errors: string[]; results: Record<string, unknown> } | undefined> {
  const sessionID = await ensureWorker(rt, run, "fixer", { phase: o.phase, grants: o.grants })
  const token = `${o.op}:${rand()}`
  run.meta = { ...run.meta, expect: token, received: null }
  await saveRun(rt.ctx, run)
  const r = await awaitSubmission(rt, run, sessionID, opsPrompt({ runId: run.runId, op: o.op, title: o.title, steps: o.steps, report: o.report, repo: run.repo }), {
    minutes: o.minutes ?? rt.opts.worker.maxPhaseMinutes.restore,
    label: o.title,
    pick: (fresh) => (fresh.meta?.received === token ? fresh : undefined),
    nudge: nudgePrompt("fixora_submit_ops", run.runId, [SKILLS.ops], `op "${o.op}", ok true/false, results, errors`),
  })
  if (!r.value) return undefined
  const { timings, step, ...rest } = r.value
  void timings
  void step
  Object.assign(run, rest)
  try {
    return JSON.parse(String(run.meta?.opsResult ?? "")) as { ok: boolean; errors: string[]; results: Record<string, unknown> }
  } catch {
    return undefined
  }
}

function mrTargetOf(rt: Runtime, run: RunRecord) {
  const remote = run.base.remoteUrl ? parseRemote(run.base.remoteUrl, rt.opts.mr.forge) : undefined
  return remote ? { remote, base: rt.opts.mr.target ?? run.base.branch, branch: run.branch! } : undefined
}

export async function runSync(rt: Runtime, input: { sessionID: string }) {
  await refreshServices(rt)
  const runs = (await listRuns(rt.ctx)).filter((r) => r.mrUrl && r.mrProvider && r.mrProvider !== "url" && r.mrStatus !== "merged" && r.mrStatus !== "closed")
  let updated = 0
  for (const r of runs) {
    await ensureRunRepo(rt.ctx, r)
    const target = mrTargetOf(rt, r)
    const op = target ? renderMrOp({ provider: r.mrProvider as MrProvider, op: "view", target, id: r.mrId, url: r.mrUrl!, services: rt.services, toolProps: (id) => toolProps(rt, id) }) : undefined
    if (!op) continue
    const before = r.mrStatus
    const result = await opsRound(rt, r, { phase: "sync", op: "sync", title: `read the state of merge request ${r.mrUrl}`, steps: [op.toolId ? { call: { toolId: op.toolId, namespace: op.namespace, input: op.input ?? {} } } : { command: op.command }], report: '{ status: "draft" | "open" | "merged" | "closed" }' })
    if (result?.ok && r.mrStatus !== before) {
      updated++
      await saveRun(rt.ctx, r)
      if (r.mrStatus === "merged") await notify(rt.ctx, input.sessionID, `fixora ${r.runId}: MR merged 🎉 — mark the release with /fixora fixed ${r.runId} --release <version>`)
    }
  }
  await notify(rt.ctx, input.sessionID, `fixora sync: ${runs.length} open MR(s) checked, ${updated} status change(s)`)
  return updated
}

// ---------- recover (merge requests → run records) ----------

export interface RecoverInput {
  sessionID: string
  dryRun?: boolean
  force?: boolean
  state?: MrListState
  limit?: number
  label?: string
}

/**
 * `/fixora recover`: rebuilds the run records (and the crash index) from the merge requests Fixora
 * opened, after a reset or on a machine that never ran them. A worker session lists the MRs that
 * carry the `fixora` label (GitLab / GitHub MCP, else `glab` / `gh`) and reads the `Fixora-Run` /
 * `Fixora-Fingerprint` commit trailers; the plugin parses the descriptions Fixora wrote. Known
 * runs are kept unless `--force`; nothing is written on `--dry-run`, and the write is approved first.
 */
export async function runRecover(rt: Runtime, input: RecoverInput): Promise<RecoverOutcome> {
  await refreshServices(rt)
  const where = await sessionRepo(rt.ctx, input.sessionID)
  const label = input.label ?? rt.opts.mr.labels[0] ?? "fixora"
  const state: MrListState = input.state ?? "all"
  const limit = input.limit ?? 200
  const remoteUrl = await readRemoteUrl(where.repo, rt.opts.remote)
  const remote = remoteUrl ? parseRemote(remoteUrl, rt.opts.mr.forge) : undefined
  const requestId = `recover-${rand()}`
  const folder = join(where.repo, ".dxcoder", "fixora", "recover")
  const outFile = join(folder, requestId)
  const commitsFile = join(folder, `${requestId}.commits.txt`)
  const order = mrListProviderOrder(rt.services, remote, { forge: rt.opts.mr.forge })
  let plan: MrListPlan | undefined
  for (const provider of order) {
    plan = renderMrList({ provider, remote, label, state, limit, services: rt.services, toolProps: (id) => toolProps(rt, id), outFile })
    if (plan) break
  }
  if (!plan) throw new FixoraStop("No way to list merge requests: connect a GitLab / GitHub MCP server with a list tool, or install `glab` / `gh`.")
  await mkdir(folder, { recursive: true })
  const record: RecoverRecord = { requestId, originSessionID: input.sessionID, createdAt: now(), label, state, limit, plan, remoteUrl }
  await setJson(rt.ctx, keys.recover(requestId), record)
  const sessionID = await ensureRecoverSession(rt, input.sessionID, where.repo, requestId)
  await notify(rt.ctx, input.sessionID, `fixora recover: the agent is listing the merge requests labelled \`${label}\` via ${plan.provider}${remote ? ` for ${remote.owner}/${remote.repo}` : ""} (session ${sessionID})`)
  const prompt = recoverPrompt({ requestId, repo: where.repo, remote: rt.opts.remote, remoteUrl, label, plan, commitsFile, outFile })
  const minutes = rt.opts.worker.maxPhaseMinutes.list
  let outcome = await promptSession(rt, sessionID, prompt, { minutes })
  let fresh = (await getJson<RecoverRecord>(rt.ctx, keys.recover(requestId))) ?? record
  if (!fresh.result && outcome === "done") {
    outcome = await promptSession(rt, sessionID, nudgePrompt("fixora_submit_recover", undefined, [SKILLS.ops], `requestId "${requestId}", provider "${plan.provider}", the listing (raw or rawFile), commitsFile "${commitsFile}" and every error you got`), { minutes: 3 })
    fresh = (await getJson<RecoverRecord>(rt.ctx, keys.recover(requestId))) ?? record
  }
  if (!fresh.result) throw new FixoraStop(outcome === "timeout" ? `Listing the merge requests exceeded ${minutes} minutes. See the worker session ${sessionID} and try again.` : `The worker session ${sessionID} did not report the merge requests. See that session, then run \`/fixora recover\` again.`)
  const result = fresh.result
  const provider = result.provider
  const resolvedRemote = result.remoteUrl ?? remoteUrl
  const { picks, skipped } = rankCandidates(result.mrs, { label })
  const trailers = new Map(Object.entries(result.trailers ?? {}))
  const existing = new Map((await listRuns(rt.ctx)).map((r) => [r.runId, r] as const))
  const at = now()
  const recovered: RunRecord[] = []
  const known: RecoverOutcome["known"] = []
  for (const candidate of picks) {
    const old = existing.get(candidate.facts.runId)
    if (old && !input.force) {
      known.push({ runId: old.runId, mrUrl: candidate.mr.url })
      continue
    }
    if (old && rt.inflight.has(old.runId)) {
      skipped.push({ mr: candidate.mr, reason: `run ${old.runId} is in progress right now` })
      continue
    }
    recovered.push(rebuildRun({ candidate, repo: where.repo, sessionID: input.sessionID, provider, remote: rt.opts.remote, remoteUrl: resolvedRemote ?? undefined, baseBranch: rt.opts.baseBranch, trailers, at, folder: folderFor(where.repo, candidate.facts.runId) }))
  }
  const outcomeReport: RecoverOutcome = { label, provider, listed: result.mrs.length, recovered, known, skipped, errors: [...result.errors], dryRun: !!input.dryRun }
  if (input.dryRun || recovered.length === 0) {
    await present(rt.ctx, input.sessionID, `fixora recover: ${recovered.length} run(s) ${input.dryRun ? "would be" : ""} recovered from ${result.mrs.length} MR(s)`.replace(/\s+/g, " "), renderRecoverReport(outcomeReport))
    return outcomeReport
  }
  const byStatus: Record<string, number> = {}
  for (const r of recovered) byStatus[r.mrStatus ?? "open"] = (byStatus[r.mrStatus ?? "open"] ?? 0) + 1
  await rt.ctx.permission.assert({
    sessionID: input.sessionID as never,
    action: "fixora.recover",
    resources: [
      `write ${recovered.length} run record(s) rebuilt from merge requests (${Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(", ")})${recovered.filter((r) => r.jiraKey).length ? `, ${recovered.filter((r) => r.jiraKey).length} with a Jira ticket` : ""}`,
      ...(input.force && recovered.some((r) => existing.has(r.runId)) ? [`⚠ overwrite ${recovered.filter((r) => existing.has(r.runId)).length} existing run record(s) (--force)`] : []),
      ...(known.length ? [`keep ${known.length} run(s) already recorded`] : []),
      "merge requests, branches, commits and Jira tickets are only read, never changed",
    ],
    metadata: { requestId, provider, dryRun: false, force: !!input.force },
  })
  for (const run of recovered) {
    await mkdir(run.folder, { recursive: true }).catch(() => {})
    const mr = picks.find((p) => p.facts.runId === run.runId)?.mr
    if (mr) await writeFile(join(run.folder, "mr.md"), `# ${mr.title}\n\n${mr.body}\n`).catch(() => {})
    await saveRun(rt.ctx, run)
    const index = rebuildIndex(run, run.fingerprint ? await loadCrashIndex(rt.ctx, run.fingerprint) : undefined)
    if (index) await saveCrashIndex(rt.ctx, index)
  }
  await present(rt.ctx, input.sessionID, `fixora recover: ${recovered.length} run(s) recovered from ${result.mrs.length} MR(s)`, renderRecoverReport(outcomeReport))
  return outcomeReport
}

// ---------- retry / feedback / restart / fixed / clean ----------

export async function runRetry(rt: Runtime, input: { sessionID: string; runId: string; from?: Step; fresh: boolean; flags: Flags }): Promise<RunRecord> {
  const run = await loadRun(rt.ctx, input.runId)
  if (!run) throw new FixoraStop(`No run ${input.runId}.`)
  await ensureRunRepo(rt.ctx, run)
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
  if (input.fresh) run.sessions = {}
  let from = resumePoint(run, input.from)
  if (run.status === "done" && !input.from) throw new FixoraStop(`Run ${run.runId} is already done. Use \`/fixora feedback\` or \`/fixora restart\`.`)
  if (run.status === "skipped" && !input.from) from = run.triage ? "analyse" : "fetch"
  if (run.status === "blocked" && !input.from) from = run.blockedReason === "dirty-worktree" || run.blockedReason === "not-a-repo" || run.blockedReason === "base-missing" ? "prepare" : "fix"
  if (input.fresh) from = "detect"
  // The fix stage ran out of time (usually the full test suite): the retry runs only the mapped tests unless --tests says otherwise.
  const narrowTests = !input.flags.tests && from === "fix" && run.status === "timeout" && run.step === "fix" && run.meta?.tests !== "skip"
  if (narrowTests) run.meta = { ...run.meta, tests: "mapped" }
  // A branch left checked out by a dead host (or kept on purpose with an uncommitted fix) is verified again by the prepare phase (same branch, recorded previous branch / stash).
  if (run.checkout?.active) run.checkout = { ...run.checkout, active: false }
  run.error = undefined
  run.blockedReason = undefined
  run.skipReason = undefined
  await notify(rt.ctx, input.sessionID, `fixora ${run.runId}: retrying from ${from}${narrowTests ? " — the fix stage timed out last time, so this attempt runs only the mapped tests (--tests full to override)" : ""}`)
  return startPipeline(rt, run, { from })
}

export async function runFeedback(rt: Runtime, input: { sessionID: string; runId: string; message: string }): Promise<RunRecord> {
  const run = await loadRun(rt.ctx, input.runId)
  if (!run) throw new FixoraStop(`No run ${input.runId}.`)
  await ensureRunRepo(rt.ctx, run)
  if (rt.inflight.has(run.runId)) throw new FixoraStop(`Run ${run.runId} is still in progress.`)
  if (!run.branch) throw new FixoraStop(`Run ${run.runId} has no fix branch yet. \`/fixora retry ${run.runId}\` first.`)
  await refreshServices(rt)
  run.originSessionID = input.sessionID
  run.counters.feedback++
  run.error = undefined
  await mkdir(run.folder, { recursive: true })
  await writeFile(join(run.folder, "feedback.md"), `# Feedback ${run.counters.feedback}\n\n${input.message}\n`)
  if (run.checkout?.active) run.checkout = { ...run.checkout, active: false }
  await saveRun(rt.ctx, run)
  await notify(rt.ctx, input.sessionID, `fixora ${run.runId}: feedback ${run.counters.feedback} — the agent checks the branch out again and answers or changes the fix`)
  return startPipeline(rt, run, { from: "fix", feedback: input.message })
}

export async function runRestart(rt: Runtime, input: { sessionID: string; runId: string; flags: Flags }): Promise<RunRecord> {
  const run = await loadRun(rt.ctx, input.runId)
  if (!run) throw new FixoraStop(`No run ${input.runId}.`)
  await ensureRunRepo(rt.ctx, run)
  await refreshServices(rt)
  const inflight = rt.inflight.get(run.runId)
  if (inflight) {
    inflight.controller.abort()
    for (const s of [run.sessions.fixer, run.sessions.reviewer]) if (s) await rt.ctx.session.interrupt({ sessionID: s as never }).catch(() => {})
    await notify(rt.ctx, input.sessionID, `fixora ${run.runId}: cancelling the running pipeline and restoring the checkout first`)
    await inflight.done.catch(() => {})
  }
  const latest = (await loadRun(rt.ctx, run.runId)) ?? run
  Object.assign(run, latest)
  await releaseLock(rt.ctx, keys.lockCrash(run.runId)).catch(() => {})
  if (run.checkout?.active) await restoreNow(rt, run)
  if (run.mrUrl && run.mrProvider && run.mrProvider !== "url") {
    const target = mrTargetOf(rt, run)
    const op = target ? renderMrOp({ provider: run.mrProvider as MrProvider, op: "close", target, id: run.mrId, url: run.mrUrl, services: rt.services, toolProps: (id) => toolProps(rt, id) }) : undefined
    if (op) await opsRound(rt, run, { phase: "clean", grants: { closeMr: true }, op: "close-mr", title: `close the merge request ${run.mrUrl} (the fix cycle restarts)`, steps: [op.toolId ? { call: { toolId: op.toolId, namespace: op.namespace, input: op.input ?? {} } } : { command: op.command }], report: "{ closed: true }" }).catch(() => undefined)
  }
  const jira = rt.services.jira
  if (run.jiraKey && connected(jira) && jira.capabilities.addComment) {
    await opsRound(rt, run, { phase: "close-loop", grants: { jiraWrite: true }, op: "jira-comment", title: `comment on Jira ${run.jiraKey}`, steps: [{ call: { toolId: jira.capabilities.addComment, namespace: jira.namespace, input: jiraCommentInput(run.jiraKey, renderJiraComment("restart", run)) } }], report: "{ commented: true }" }).catch(() => undefined)
  }
  await Pipeline.moveToHistory(run.folder)
  run.originSessionID = input.sessionID
  run.counters.restarts++
  run.counters.fixRounds = 0
  run.counters.reviewRounds = 0
  run.counters.feedback = 0
  run.branch = undefined
  run.checkout = { active: false }
  run.toolchain = undefined
  run.change = undefined
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

/** Restores a checkout left behind by a dead host (outside the pipeline). */
async function restoreNow(rt: Runtime, run: RunRecord) {
  const result = await opsRound(rt, run, { phase: "restore", op: "restore", title: `restore the checkout to \`${run.checkout.previousBranch ?? run.checkout.previousHeadSha ?? "the previous branch"}\`${run.checkout.stashRef ? " and pop the stash" : ""}`, steps: restoreSteps(run), report: '{ branch: "<branch now checked out>", stashPopped: true/false }' }).catch(() => undefined)
  await saveRun(rt.ctx, run)
  return result
}

export async function runFixed(rt: Runtime, input: { sessionID: string; runId: string; release: string; platform?: string }) {
  const run = await loadRun(rt.ctx, input.runId)
  if (!run) throw new FixoraStop(`No run ${input.runId}.`)
  await ensureRunRepo(rt.ctx, run)
  const index = (await loadCrashIndex(rt.ctx, run.fingerprint)) ?? { fingerprint: run.fingerprint, runIds: [run.runId], reopened: { count: 0 } }
  index.fixedIn = { release: input.release, platform: input.platform, markedBy: input.sessionID, at: now(), runId: run.runId }
  index.reopened = { count: 0 }
  await saveCrashIndex(rt.ctx, index)
  run.meta = { ...run.meta, fixedIn: input.release, fixedPlatform: input.platform ?? null }
  await saveRun(rt.ctx, run)
  if (run.jiraKey) {
    await refreshServices(rt)
    const jira = rt.services.jira
    if (connected(jira) && jira.capabilities.addComment) {
      run.originSessionID = input.sessionID
      await opsRound(rt, run, { phase: "close-loop", grants: { jiraWrite: true }, op: "jira-comment", title: `comment on Jira ${run.jiraKey}`, steps: [{ call: { toolId: jira.capabilities.addComment, namespace: jira.namespace, input: jiraCommentInput(run.jiraKey, renderJiraComment("fixed", run, { release: input.release })) } }], report: "{ commented: true }" }).catch(() => undefined)
      await saveRun(rt.ctx, run)
    }
  }
  await present(rt.ctx, input.sessionID, `fixora ${run.runId}: marked fixed in ${input.release}`, `Marked \`${run.runId}\` (${run.title}) as fixed in release **${input.release}**${input.platform ? ` (${input.platform})` : ""}. If the same crash fingerprint shows up again, Fixora will flag it as reopened.`)
}

export async function runClean(rt: Runtime, input: { sessionID: string; runId: string; remote: boolean }) {
  const run = await loadRun(rt.ctx, input.runId)
  if (!run) throw new FixoraStop(`No run ${input.runId}.`)
  await ensureRunRepo(rt.ctx, run)
  if (rt.inflight.has(run.runId)) throw new FixoraStop(`Run ${run.runId} is in progress; restart or wait first.`)
  await refreshServices(rt)
  run.originSessionID = input.sessionID
  const notes: string[] = []
  if (run.checkout?.active) {
    const r = await restoreNow(rt, run)
    notes.push(r?.ok && !run.checkout.active ? `restored the checkout to ${run.checkout.previousBranch ?? "the previous branch"}` : `restore failed: ${r?.errors.join("; ") ?? "no report"} — see the final report of the run for the manual commands`)
  }
  if (run.branch) {
    const grants: WorkerGrants = {}
    const steps: OpStep[] = [{ command: `git branch -D ${shellQuote(run.branch)}`, note: "skip (and say so) when the branch is checked out or does not exist" }]
    if (input.remote && run.pipeline.pushed) {
      await rt.ctx.permission.assert({ sessionID: input.sessionID as never, action: "fixora.delete-branch", resources: [`delete remote branch ${run.base.remote}/${run.branch}`], metadata: { runId: run.runId } })
      run.approvals["delete-branch"] = "approved"
      grants.deleteBranch = true
      steps.push({ command: `git push ${shellQuote(run.base.remote)} --delete ${shellQuote(run.branch)}` })
    }
    const r = await opsRound(rt, run, { phase: "clean", grants, op: "clean", title: `delete the run's branch ${run.branch}${grants.deleteBranch ? " locally and on the remote" : " locally"}`, steps, report: "{ localDeleted: true/false, remoteDeleted: true/false }" })
    notes.push(r ? `${r.ok ? "deleted" : "could not delete"} ${run.branch}${r.errors.length ? ` (${r.errors.join("; ")})` : ""}` : "the worker did not report the cleanup")
  }
  run.sessions = {}
  await saveRun(rt.ctx, run)
  await present(rt.ctx, input.sessionID, `fixora ${run.runId}: cleaned`, notes.map((n) => `- ${n}`).join("\n") || "Nothing to clean.")
}

/**
 * `/fixora reset`: forgets every stored record (runs, crash index, worker records, locks, cached
 * crash lists). Refused while a run is in flight; runs that still have their branch checked out are
 * listed in the approval so the user restores them by hand. `--files` also removes the plugin's own
 * folder `<repo>/.dxcoder/fixora` of the current checkout. Branches, commits, MRs and tickets on
 * remotes are never touched.
 */
export async function runReset(rt: Runtime, input: { sessionID: string; files: boolean }) {
  if (rt.inflight.size > 0) throw new FixoraStop(`${rt.inflight.size} run(s) are in progress (${[...rt.inflight.keys()].join(", ")}). Wait for them or \`/fixora restart\` / cancel them first.`)
  const runs = await listRuns(rt.ctx)
  const pending = runs.filter((r) => r.checkout?.active)
  const keysNow = await listKeys(rt.ctx)
  const where = await sessionRepo(rt.ctx, input.sessionID)
  const folder = join(where.repo, ".dxcoder", "fixora")
  const resources = [
    `forget ${runs.length} run record(s) and ${keysNow.length - runs.length} other record(s) (crash index, caches, locks)`,
    ...(pending.length ? [`⚠ ${pending.length} run(s) still have their branch checked out: ${pending.map((r) => `${r.runId} (${r.branch}${r.checkout.stashRef ? ", stash pending" : ""})`).join(", ")} — restore by hand afterwards`] : []),
    ...(input.files ? [`delete the folder ${folder}`] : []),
    "branches, commits, merge requests and Jira tickets are kept",
  ]
  await rt.ctx.permission.assert({ sessionID: input.sessionID as never, action: "fixora.reset", resources, metadata: { files: input.files } })
  const counts = await wipeStorage(rt.ctx)
  const notes = Object.entries(counts).map(([kind, n]) => `${kind}: ${n}`)
  if (input.files) {
    await rm(folder, { recursive: true, force: true })
    notes.push(`deleted ${folder}`)
  }
  if (pending.length) notes.push(`restore these checkouts by hand: ${pending.map((r) => `\`git checkout ${r.checkout.previousBranch ?? "<branch>"}\`${r.checkout.stashRef ? ` + \`git stash pop\` (fixora/${r.runId})` : ""}`).join("; ")}`)
  await present(rt.ctx, input.sessionID, `fixora reset: ${keysNow.length} record(s) removed`, notes.length ? notes.map((n) => `- ${n}`).join("\n") : "Nothing to remove.")
  return counts
}
