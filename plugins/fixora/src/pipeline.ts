// The per-crash pipeline: detect → fetch → prepare → analyse → ticket → fix → validate → review →
// publish → close-loop → (restore) → done. The plugin only decides and validates; every git command,
// check, MCP call and CLI is run by a worker session (the host's coding agent) inside the user's
// checkout. Each step is idempotent and resumable from storage; restore runs on every exit path.

import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { needsCheckout } from "./checkout.js"
import { describeError } from "./errors.js"
import { detectReopen } from "./fingerprint.js"
import { ApprovalRejected, approve, decideApproval, gateKinds } from "./gate.js"
import { branchName, compareUrl, parseRemote, type ParsedRemote } from "./git.js"
import { dedupeJql, jiraAvailable, jiraBaseUrl, jiraCommentInput, jiraCreateInput, jiraSearchInput, jiraTransitionsInput, schemaParamType } from "./jira.js"
import { connected } from "./mcp.js"
import { mrProviderOrder, renderMrAttempts, renderMrOp, type MrProvider } from "./mr.js"
import { crashFetchPrompt, feedbackPrompt, fixFollowUpPrompt, fixPrompt, nudgePrompt, opsPrompt, preparePrompt, publishPrompt, renderTestFailureText, restoreSteps, SKILLS, ticketPrompt, triagePrompt, type Prompt, type PublishPlan } from "./prompts.js"
import { appendLog, FixoraStop, notify, present, progress, sourceContext, stageBegin, stageEnd, toolProps, type Runtime } from "./progress.js"
import { manualRestoreText, renderApprovalPreview, renderCommitMessage, renderCrashMarkdown, renderFinalReport, renderJiraComment, renderJiraIssue, renderMr, renderTriageCard, renderValidationCard } from "./render.js"
import { ensureRunRepo } from "./repo.js"
import { latestFixAttempt, runReview } from "./review.js"
import { scanAddedLines } from "./secrets.js"
import { sourceById } from "./sources/index.js"
import { crashFromFile } from "./sources/manual.js"
import { loadCrashIndex, loadRun, saveCrashIndex, saveRun } from "./state.js"
import type { Crash, CrashIndexEntry, RunRecord, Step, WorkerGrants } from "./types.js"
import { checkChangedFiles, failedChecks, summarizeChecks } from "./validate.js"
import { awaitSubmission, ensureWorker, lastAssistantText, type Outcome } from "./worker.js"

export interface PipelineOptions {
  from: Step
  signal: AbortSignal
  /** Feedback text when resuming after `/fixora feedback`. */
  feedback?: string
}

const FEEDBACK_ORDER: Step[] = ["fix", "validate", "review", "publish", "close-loop", "done"]
const FULL_ORDER: Step[] = ["detect", "fetch", "prepare", "analyse", "ticket", "fix", "validate", "review", "publish", "close-loop", "done"]

const rand = () => Math.random().toString(36).slice(2, 10)

export class Pipeline {
  private crash?: Crash
  private remote?: ParsedRemote
  private notes: string[] = []

  constructor(
    private readonly rt: Runtime,
    readonly run: RunRecord,
    private readonly o: PipelineOptions,
  ) {}

  private get ctx() {
    return this.rt.ctx
  }
  private get opts() {
    return this.rt.opts
  }
  private log(line: string) {
    return appendLog(this.run.folder, line)
  }
  private crashUrl() {
    return this.crash?.url ?? (typeof this.run.meta?.crashUrl === "string" ? this.run.meta.crashUrl : undefined)
  }
  private get extra(): Record<string, string> | undefined {
    return this.run.meta?.refExtra ? (JSON.parse(String(this.run.meta.refExtra)) as Record<string, string>) : undefined
  }

  async execute(): Promise<RunRecord> {
    const run = this.run
    const order = this.o.feedback ? FEEDBACK_ORDER : FULL_ORDER
    let i = Math.max(0, order.indexOf(this.o.from))
    try {
      await this.reload()
      while (i < order.length) {
        if (this.o.signal.aborted) throw new FixoraStop(`run ${run.runId} was cancelled`)
        const step = order[i]!
        if (step !== "prepare" && needsCheckout(step) && !run.checkout.active) {
          const r = await this.prepare()
          if (r === "stop") break
        }
        const next = await this.runStep(step)
        if (next === "stop") break
        if (next === "loop") {
          i = order.indexOf("validate")
          continue
        }
        i++
      }
    } catch (error) {
      await this.fail(error)
    } finally {
      await this.restore()
      await this.finish()
    }
    return run
  }

  // ---------- bookkeeping ----------

  private async reload() {
    await ensureRunRepo(this.ctx, this.run)
    await mkdir(this.run.folder, { recursive: true })
    const file = join(this.run.folder, "crash.json")
    if (existsSync(file)) this.crash = JSON.parse(await readFile(file, "utf8")) as Crash
    this.remote = this.run.base.remoteUrl ? parseRemote(this.run.base.remoteUrl, this.opts.mr.forge) : undefined
  }

  /** Marks the submission the next prompt must produce; the submit tools echo it into `meta.received`. */
  private async expect(kind: string): Promise<string> {
    const token = `${kind}:${rand()}`
    this.run.meta = { ...this.run.meta, expect: token, received: null }
    await saveRun(this.ctx, this.run)
    return token
  }

  /** Takes over what the submit tools persisted (everything but the pipeline's own bookkeeping). */
  private adopt(fresh: RunRecord) {
    const { timings, step, ...rest } = fresh
    void timings
    void step
    Object.assign(this.run, rest)
  }

  private async fail(error: unknown) {
    const run = this.run
    const step = run.step
    if (error instanceof ApprovalRejected) {
      run.status = "rejected"
      await stageEnd(this.rt, run, step, "failed", error.message)
      this.notes.push(`${error.message} Nothing was sent. Re-run \`/fixora retry ${run.runId} --from ${step}\` when ready.`)
      return
    }
    if (error instanceof FixoraStop) {
      if (run.status === "running" || run.status === "awaiting-approval") run.status = this.o.signal.aborted ? "cancelled" : "failed"
      run.error = error.message
      await stageEnd(this.rt, run, step, run.status === "skipped" ? "skipped" : "failed", undefined, error.message)
      return
    }
    const message = error instanceof Error ? `${error.name}: ${error.message}` : describeError(error)
    run.status = "failed"
    run.error = message.slice(0, 2000)
    await this.log(`error at ${step}: ${message}`)
    await stageEnd(this.rt, run, step, "failed", undefined, message)
  }

  private async finish() {
    const run = this.run
    await saveRun(this.ctx, run)
    const compare = typeof run.meta?.compareUrl === "string" ? run.meta.compareUrl : undefined
    const report = renderFinalReport(run, { crashUrl: this.crashUrl(), compareUrl: compare, notes: this.notes })
    if (run.status === "done") {
      await this.rt.emit("run.done", { runId: run.runId, sessionID: run.originSessionID, mrUrl: run.mrUrl, jiraKey: run.jiraKey, branch: run.branch, totalMs: run.totalMs, report })
    } else {
      await this.rt.emit("run.failed", { runId: run.runId, sessionID: run.originSessionID, step: run.step, status: run.status, error: run.error })
    }
    await present(this.ctx, run.originSessionID, `fixora ${run.runId}: ${run.status}${run.mrUrl ? ` — ${run.mrUrl}` : ""}`, report)
  }

  private async runStep(step: Step): Promise<"next" | "stop" | "loop"> {
    switch (step) {
      case "detect":
        return this.detect()
      case "fetch":
        return this.fetch()
      case "prepare":
        return this.prepare()
      case "analyse":
        return this.analyse()
      case "ticket":
        return this.ticket()
      case "fix":
        return this.fix()
      case "validate":
        return this.validate()
      case "review":
        return this.review()
      case "publish":
        return this.publish()
      case "close-loop":
        return this.closeLoop()
      case "restore":
        return "next"
      case "done":
        return this.done()
    }
  }

  private stopFor(outcome: Outcome, what: string, budgetMinutes: number, retryFrom: Step): never {
    const run = this.run
    if (outcome === "aborted") throw new FixoraStop(`run ${run.runId} was cancelled during ${what}`)
    if (outcome === "timeout") {
      run.status = "timeout"
      throw new FixoraStop(`${what} exceeded ${budgetMinutes} minutes and was interrupted. \`/fixora retry ${run.runId} --from ${retryFrom}\` resumes the same session.`)
    }
    throw new FixoraStop(`The worker did not report back from ${what}. See the worker session (${run.sessions.fixer ?? "?"}), then \`/fixora retry ${run.runId} --from ${retryFrom}\`.`)
  }

  // ---------- steps ----------

  private async detect(): Promise<"next"> {
    const run = this.run
    await stageBegin(this.rt, run, "detect")
    await mkdir(run.folder, { recursive: true })
    if (this.opts.gitignore) {
      const root = join(run.repo, ".dxcoder", "fixora")
      await mkdir(root, { recursive: true })
      const gi = join(root, ".gitignore")
      if (!existsSync(gi)) await writeFile(gi, "*\n")
    }
    const services = Object.keys(this.rt.services).filter((k) => connected(this.rt.services[k as keyof typeof this.rt.services]))
    await stageEnd(this.rt, run, "detect", "ok", `${services.join(", ") || "no MCP"} · checkout ${run.repo}`)
    return "next"
  }

  private async fetch(): Promise<"next"> {
    const run = this.run
    await stageBegin(this.rt, run, "fetch")
    const file = join(run.folder, "crash.json")
    if (existsSync(file) && !run.flags.force) {
      this.crash = JSON.parse(await readFile(file, "utf8")) as Crash
    } else if (run.source === "manual") {
      const extra = this.extra
      this.crash = await crashFromFile({ file: extra?.file ?? run.crashId, title: extra?.title, platform: extra?.platform, language: extra?.language, appPackage: this.opts.appPackage, inAppPrefixes: this.opts.inAppPackages })
      await writeFile(file, `${JSON.stringify(this.crash, null, 2)}\n`)
      run.title = this.crash.title
      run.fingerprint = this.crash.fingerprint
      run.meta = { ...run.meta, crashUrl: null, platform: this.crash.platform ?? null, appVersion: null, language: this.crash.language, symbolication: this.crash.symbolication, userCount: null, eventCount: null }
    } else {
      const source = sourceById(run.source)
      const plan = source.fetchPlan!(sourceContext(this.rt), run.crashId, this.extra)
      const sessionID = await ensureWorker(this.rt, run, "fixer", { phase: "crash" })
      const token = await this.expect("crash")
      const r = await awaitSubmission(this.rt, run, sessionID, crashFetchPrompt(run, plan), {
        minutes: this.opts.worker.maxPhaseMinutes.crash,
        signal: this.o.signal,
        label: "fetching the crash through the agent",
        pick: (fresh) => (fresh.meta?.received === token ? fresh : undefined),
        nudge: nudgePrompt("fixora_submit_crash", run.runId, SKILLS.crashes, "the replies you received"),
      })
      if (!r.value) this.stopFor(r.outcome, "the crash fetch", this.opts.worker.maxPhaseMinutes.crash, "fetch")
      this.adopt(r.value)
      this.crash = JSON.parse(await readFile(file, "utf8")) as Crash
    }
    const crash = this.crash
    run.title = crash.title
    run.fingerprint = crash.fingerprint
    // Crash index: dedupe across sources, reopen detection.
    const index: CrashIndexEntry = (await loadCrashIndex(this.ctx, crash.fingerprint)) ?? { fingerprint: crash.fingerprint, runIds: [], reopened: { count: 0 } }
    const others = index.runIds.filter((id) => id !== run.runId)
    if (others.length > 0 && !run.flags.force) {
      for (const id of others) {
        const other = await loadRun(this.ctx, id)
        if (other && (other.mrUrl || other.status === "running" || other.status === "awaiting-approval")) {
          run.status = "skipped"
          run.skipReason = `same crash fingerprint as run ${id} (${other.status}${other.mrUrl ? `, MR ${other.mrUrl}` : ""})`
          throw new FixoraStop(`This crash has the same fingerprint as run \`${id}\` (${other.status}${other.mrUrl ? `, MR ${other.mrUrl}` : ""}). Use \`/fixora feedback ${id} "…"\` or \`/fixora restart ${id}\`, or re-run with --force to fix it separately.`)
        }
      }
    }
    const reopen = detectReopen(index, crash, new Date().toISOString())
    if (reopen.reopened) {
      index.reopened = { count: index.reopened.count + 1, lastAt: new Date().toISOString(), reason: reopen.reason }
      run.reopened = { count: index.reopened.count, previousRunId: index.fixedIn?.runId, fixedIn: index.fixedIn?.release, reason: reopen.reason }
      await this.rt.emit("crash.reopened", { runId: run.runId, fingerprint: crash.fingerprint, reason: reopen.reason, previousRunId: index.fixedIn?.runId })
      await notify(this.ctx, run.originSessionID, `fixora ${run.runId}: ⚠ reopened crash — fixed in ${index.fixedIn?.release}, seen again (${reopen.reason})`)
    }
    if (!index.runIds.includes(run.runId)) index.runIds.push(run.runId)
    index.title = crash.title
    index.lastSeen = crash.lastSeen ?? index.lastSeen
    await saveCrashIndex(this.ctx, index)
    // No frame mapping or in-app / symbolication judgement here: the agent investigates the frames
    // itself in the analyse phase and classifies (fixable, third_party_only, needs_symbolication…).
    await writeFile(join(run.folder, "crash.md"), `${renderCrashMarkdown(crash, { reopened: run.reopened ? { ...run.reopened } : undefined })}\n`)
    await stageEnd(this.rt, run, "fetch", "ok", `${crash.exceptionType ?? crash.title} · ${crash.frames.length} frames · ${crash.language}${crash.symbolication !== "ok" ? ` · symbolication: ${crash.symbolication}` : ""}`)
    return "next"
  }

  /** The worker checks out the fix branch in the user's checkout (stashing after approval when dirty). */
  private async prepare(): Promise<"next" | "stop"> {
    const run = this.run
    if (run.checkout.active) {
      if (run.step !== "prepare") return "next"
      await stageBegin(this.rt, run, "prepare")
      await stageEnd(this.rt, run, "prepare", "ok", `already on ${run.branch}`)
      return "next"
    }
    await stageBegin(this.rt, run, "prepare")
    const sessionID = await ensureWorker(this.rt, run, "fixer", { phase: "prepare" })
    const fallbackBranch = run.branch ?? branchName(this.opts.branchPrefix, run.runId, run.title, run.counters.restarts)
    const budget = this.opts.worker.maxPhaseMinutes.prepare
    const ask = async (prompt: Prompt, label: string) => {
      const token = await this.expect("prepare")
      const r = await awaitSubmission(this.rt, run, sessionID, prompt, {
        minutes: budget,
        signal: this.o.signal,
        label,
        pick: (fresh) => (fresh.meta?.received === token ? fresh : undefined),
        nudge: nudgePrompt("fixora_submit_prepare", run.runId, SKILLS.prepare, `stage "inspect" with what you found, or stage "ready" if the branch is checked out`),
      })
      if (!r.value) this.stopFor(r.outcome, "the prepare phase", budget, "prepare")
      this.adopt(r.value)
      return String(run.meta?.prepareStage ?? "")
    }
    let stage = await ask(preparePrompt(run, this.opts, { stage: "inspect", fallbackBranch }), "the agent is inspecting the checkout")
    if (stage === "blocked") throw new FixoraStop(blockedHelp(run))
    if (stage === "inspect") {
      const dirty = run.meta?.prepareDirty === true
      if (dirty) {
        const files = Number(run.meta?.prepareDirtyFiles ?? 0)
        const status = String(run.meta?.prepareStatus ?? "")
        const decision = decideApproval("stash", run, this.opts, { serviceAvailable: true })
        if (decision.decision === "ask") {
          await writeFile(join(run.folder, "stash-preview.md"), `${renderApprovalPreview(run, { kind: "stash", branch: fallbackBranch, stash: { files, status }, crashUrl: this.crashUrl() })}\n`)
          try {
            await approve(this.rt, run, "stash", {
              resources: [`stash ${files} uncommitted change(s) in ${run.repo} (git stash push -u)`, `work on branch ${fallbackBranch}, then pop the stash and check out ${run.checkout.previousBranch ?? "your branch"} again`],
              summary: `stash ${files} local change(s) before fixing`,
              previewPath: join(run.folder, "stash-preview.md"),
              preview: { branch: fallbackBranch, stash: { files, status: status.split("\n").slice(0, 20).join("\n") }, rootCause: run.triage?.rootCause, crashUrl: this.crashUrl(), previewPath: join(run.folder, "stash-preview.md") },
            })
          } catch (error) {
            if (error instanceof ApprovalRejected) {
              run.status = "blocked"
              run.blockedReason = "dirty-worktree"
              throw new FixoraStop(`The checkout ${run.repo} has ${files} uncommitted change(s) and stashing was declined. Nothing was touched. Commit or stash them yourself, then \`/fixora retry ${run.runId}\`.`)
            }
            throw error
          }
        } else run.approvals.stash = "auto"
        stage = await ask(preparePrompt(run, this.opts, { stage: "apply", fallbackBranch, stashApproved: true }), "the agent is stashing your changes and creating the branch")
      } else stage = await ask(preparePrompt(run, this.opts, { stage: "apply", fallbackBranch, stashApproved: false }), "the agent is creating the branch")
    }
    if (stage === "blocked") throw new FixoraStop(blockedHelp(run))
    if (stage !== "ready" || !run.checkout.active || !run.branch) throw new FixoraStop(`The prepare phase did not end with a checked-out branch (stage ${stage || "none"}). See the worker session, then \`/fixora retry ${run.runId} --from prepare\`.`)
    this.remote = run.base.remoteUrl ? parseRemote(run.base.remoteUrl, this.opts.mr.forge) : undefined
    if (!run.base.remoteUrl) await notify(this.ctx, run.originSessionID, `fixora ${run.runId}: no remote "${run.base.remote}" — push and MR will be skipped`)
    await stageEnd(this.rt, run, "prepare", "ok", `${run.branch} from ${run.base.remote}/${run.base.branch}${run.base.sha ? `@${run.base.sha.slice(0, 8)}` : ""}${run.checkout.stashRef ? " · changes stashed" : ""}`)
    return "next"
  }

  private async analyse(): Promise<"next" | "stop"> {
    const run = this.run
    await stageBegin(this.rt, run, "analyse")
    const sessionID = await ensureWorker(this.rt, run, "fixer", { phase: "triage" })
    const token = await this.expect("triage")
    const budget = this.opts.worker.maxPhaseMinutes.triage
    const r = await awaitSubmission(this.rt, run, sessionID, triagePrompt(run), {
      minutes: budget,
      signal: this.o.signal,
      label: "the agent is analysing the crash",
      pick: (fresh) => (fresh.meta?.received === token && fresh.triage ? fresh : undefined),
      nudge: nudgePrompt("fixora_submit_triage", run.runId, SKILLS.triage, "the analysis you reached (classification, mappedFrames with existing files, rootCause, confidence, fixStrategy, alternatives)"),
    })
    if (!r.value) this.stopFor(r.outcome, "the analysis", budget, "analyse")
    this.adopt(r.value)
    const t = run.triage!
    const sc = t.suspectCommits[0]
    await this.rt.emit("run.card", { runId: run.runId, sessionID: run.originSessionID, kind: "triage", data: { rootCause: t.rootCause, confidence: t.confidence, category: t.category, risk: t.risk.level, classification: t.classification, introducedBy: sc ? `${sc.sha.slice(0, 10)} ${sc.subject}${t.introducedInRelease ? ` · ${t.introducedInRelease}` : ""}` : undefined, reopened: run.reopened ? (t.reopenReason ?? run.reopened.reason) : undefined } })
    await present(this.ctx, run.originSessionID, `fixora ${run.runId}: root cause — ${t.classification}, ${Math.round(t.confidence * 100)}%`, renderTriageCard(run, this.crash!))
    if (t.classification !== "fixable" || t.confidence < this.opts.confidence.minToFix) {
      const why = t.classification !== "fixable" ? `classified as ${t.classification}` : `confidence ${Math.round(t.confidence * 100)}% is below minToFix ${Math.round(this.opts.confidence.minToFix * 100)}%`
      run.status = "skipped"
      run.skipReason = why
      await stageEnd(this.rt, run, "analyse", "ok", why)
      if (this.opts.jira.ticketOnSkip && run.flags.ticket) await this.ticket().catch(() => {})
      throw new FixoraStop(`Fixora stopped after the analysis: ${why}. ${t.classification === "needs_human" ? "A human decision is needed; see analysis.md. " : ""}See analysis.md in ${run.folder}; \`/fixora retry ${run.runId} --from analyse\` runs the analysis again, or lower "confidence.minToFix".`)
    }
    await stageEnd(this.rt, run, "analyse", "ok", `${t.category} · confidence ${Math.round(t.confidence * 100)}% · risk ${t.risk.level}`)
    return "next"
  }

  private async ticket(): Promise<"next"> {
    const run = this.run
    if (run.jiraKey) return "next"
    await stageBegin(this.rt, run, "ticket")
    const jira = this.rt.services.jira
    const available = jiraAvailable(jira, this.opts)
    const decision = decideApproval("ticket", run, this.opts, { serviceAvailable: available })
    if (decision.decision === "skip") {
      run.approvals.ticket = "skipped"
      const why = !jira || jira.status !== "connected" ? "no connected Jira MCP server" : !this.opts.jira.project ? 'set "jira": { "project": "KEY" } in the plugin options' : decision.reason
      await stageEnd(this.rt, run, "ticket", "skipped", why)
      return "next"
    }
    const project = this.opts.jira.project!
    const issue = renderJiraIssue(run, this.crash!)
    const parent = this.opts.jira.parent
    const jiraPreview = { project, issueType: this.opts.jira.issueType, summary: issue.summary, parent }
    await writeFile(join(run.folder, "ticket-preview.md"), `${renderApprovalPreview(run, { kind: "ticket", jira: jiraPreview, crashUrl: this.crashUrl() })}\n\n${issue.description}\n`)
    if (decision.decision === "ask") {
      await approve(this.rt, run, "ticket", {
        resources: [`create Jira ${this.opts.jira.issueType} in ${project}${parent ? ` under ${parent}` : ""}: ${issue.summary}`, `labels: ${[...this.opts.jira.labels, "fixora"].join(", ")}`],
        summary: `create a Jira ${this.opts.jira.issueType} in ${project}${parent ? ` under ${parent}` : ""}`,
        previewPath: join(run.folder, "ticket-preview.md"),
        preview: { jira: jiraPreview, rootCause: run.triage?.rootCause, confidence: run.triage?.confidence, risk: run.triage?.risk.level, crashUrl: this.crashUrl(), previewPath: join(run.folder, "ticket-preview.md") },
      })
    } else run.approvals.ticket = "auto"
    const createTool = jira!.capabilities.createIssue!
    const prompt = ticketPrompt(run, {
      namespace: jira!.namespace,
      searchTool: jira!.capabilities.search!,
      searchInput: jiraSearchInput(dedupeJql(project, run.fingerprint), 5),
      createTool,
      createInput: jiraCreateInput({ project, issueType: this.opts.jira.issueType, summary: issue.summary, description: issue.description, labels: [...new Set([...this.opts.jira.labels, "fixora"])], parent }, { additionalFieldsType: schemaParamType({ properties: toolProps(this.rt, createTool) }, "additional_fields") }),
      commentTool: jira!.capabilities.addComment,
      reopenComment: run.reopened && jira!.capabilities.addComment ? jiraCommentInput("<key>", renderJiraComment("reopened", run, { reason: run.reopened.reason })) : undefined,
      browseBase: jiraBaseUrl(jira),
    })
    const sessionID = await ensureWorker(this.rt, run, "fixer", { phase: "ticket", grants: { jiraWrite: true } })
    const token = await this.expect("ticket")
    const budget = this.opts.worker.maxPhaseMinutes.crash
    const r = await awaitSubmission(this.rt, run, sessionID, prompt, {
      minutes: budget,
      signal: this.o.signal,
      label: "the agent is creating the Jira ticket",
      pick: (fresh) => (fresh.meta?.received === token ? fresh : undefined),
      nudge: nudgePrompt("fixora_submit_ticket", run.runId, SKILLS.ops, 'action "created" / "reused" with the key, or "failed" with the error'),
    })
    if (!r.value) this.stopFor(r.outcome, "the ticket phase", budget, "ticket")
    this.adopt(r.value)
    if (!run.jiraKey) throw new FixoraStop(`The Jira ticket could not be created: ${run.meta?.ticketError ?? "no key reported"}. \`/fixora retry ${run.runId} --from ticket\` or \`--no-ticket\`.`)
    await this.rt.emit("run.card", { runId: run.runId, sessionID: run.originSessionID, kind: "ticket", data: { jiraKey: run.jiraKey, jiraUrl: run.jiraUrl } })
    await stageEnd(this.rt, run, "ticket", "ok", `${run.meta?.ticketAction === "reused" ? "reused " : ""}${run.jiraKey}${run.jiraUrl ? ` ${run.jiraUrl}` : ""}`)
    return "next"
  }

  private async fix(): Promise<"next" | "stop"> {
    const run = this.run
    await stageBegin(this.rt, run, "fix")
    const feedback = this.o.feedback
    const sessionID = await ensureWorker(this.rt, run, "fixer", { phase: feedback ? "feedback" : "fix" })
    const attempt = latestFixAttempt(run)
    const checks = run.toolchain?.checks ?? []
    const prompt = feedback ? feedbackPrompt(run, { attempt, message: feedback, checks }) : fixPrompt(run, this.opts, { attempt, checks, testsScope: typeof run.meta?.tests === "string" ? run.meta.tests : undefined })
    const budget = this.opts.worker.maxPhaseMinutes.fix
    const r = await awaitSubmission(this.rt, run, sessionID, prompt, {
      minutes: budget,
      signal: this.o.signal,
      label: feedback ? `the agent is handling your feedback (attempt ${attempt})` : `the agent is fixing (attempt ${attempt})`,
      pick: (fresh) => (fresh.fix?.attempt === attempt ? fresh : undefined),
      nudge: nudgePrompt("fixora_submit_fix", run.runId, SKILLS.fix, `attempt ${attempt}, with \`status\` and \`diff\` from git`),
    })
    if (!r.value) {
      if (feedback && r.outcome === "done") {
        const answer = await lastAssistantText(this.rt, sessionID)
        run.status = "done"
        await stageEnd(this.rt, run, "fix", "ok", "answered")
        await present(this.ctx, run.originSessionID, `fixora ${run.runId}: answer`, answer || "The worker finished without changes and without a report.")
        return "stop"
      }
      this.stopFor(r.outcome, "the fix phase", budget, feedback ? "fix" : "fix")
    }
    this.adopt(r.value)
    if (!run.fix!.changesMade) {
      if (feedback) {
        const answer = await lastAssistantText(this.rt, sessionID)
        run.status = "done"
        await stageEnd(this.rt, run, "fix", "ok", "answered without changes")
        await present(this.ctx, run.originSessionID, `fixora ${run.runId}: answer`, answer || run.fix!.rationale)
        return "stop"
      }
      throw new FixoraStop(`The worker made no changes: ${run.fix!.unresolved.join("; ") || run.fix!.summary}. See the worker session, then \`/fixora retry ${run.runId} --from fix\`.`)
    }
    if (feedback) {
      // A new change set: validate, review, commit and push again (the MR, when any, is updated).
      run.pipeline.validated = false
      run.pipeline.reviewed = false
      run.pipeline.committed = false
      run.pipeline.pushed = false
      run.tests = undefined
    }
    await stageEnd(this.rt, run, "fix", "ok", `${run.fix!.filesChanged.length} file(s): ${run.fix!.summary}`)
    return "next"
  }

  private async validate(): Promise<"next" | "loop"> {
    const run = this.run
    await stageBegin(this.rt, run, "validate")
    const attempt = latestFixAttempt(run)
    const change = run.change
    if (!change || change.paths.length === 0) throw new FixoraStop(`The fix report carries no changes to validate. \`/fixora retry ${run.runId} --from fix\`.`)
    const problems = checkChangedFiles(change, { denyPaths: this.opts.validate.denyPaths, maxFiles: this.opts.validate.maxFilesChanged, maxLines: this.opts.validate.maxDiffLines })
    if (problems.length > 0) {
      if (run.counters.fixRounds < this.opts.maxFixRounds) {
        run.counters.fixRounds++
        await saveRun(this.ctx, run)
        await stageEnd(this.rt, run, "validate", "failed", `change set rejected: ${problems[0]}`)
        await this.feedbackToFixer(`The change set is not acceptable:\n- ${problems.join("\n- ")}\nRevert or reduce the changes accordingly, re-run the checks, then call fixora_submit_fix again (attempt ${latestFixAttempt(run)}).`)
        return "loop"
      }
      run.status = "blocked"
      run.blockedReason = problems.some((p) => /protected pattern/.test(p)) ? "forbidden-path" : "limits"
      throw new FixoraStop(`The change set is blocked after ${run.counters.fixRounds} rounds:\n- ${problems.join("\n- ")}\nEdit the checkout by hand and \`/fixora retry ${run.runId} --from fix\`, or raise "validate.maxFilesChanged" / "validate.maxDiffLines".`)
    }
    const diff = await readFile(join(run.folder, `diff.${attempt}.patch`), "utf8").catch(() => "")
    const secrets = scanAddedLines(diff, this.opts.allowSecretPatterns)
    if (secrets.length > 0) {
      run.status = "blocked"
      run.blockedReason = "secret"
      throw new FixoraStop(`Refusing to continue: possible secrets in the diff:\n${secrets.map((s) => `- ${s.file}:${s.line} ${s.pattern} (${s.masked})`).join("\n")}\nRemove them in the checkout and \`/fixora retry ${run.runId} --from fix\` (or add a false positive to "allowSecretPatterns").`)
    }
    const report = run.tests
    const failed = report ? failedChecks(report) : []
    if (report && failed.length > 0) {
      if (run.counters.fixRounds < this.opts.maxFixRounds) {
        run.counters.fixRounds++
        await saveRun(this.ctx, run)
        await stageEnd(this.rt, run, "validate", "failed", summarizeChecks(report))
        await this.feedbackToFixer(renderTestFailureText(report, run.counters.fixRounds, this.opts.maxFixRounds))
        return "loop"
      }
      throw new FixoraStop(`Checks still fail after ${run.counters.fixRounds} fix rounds: ${summarizeChecks(report)}. Fix by hand in the checkout and \`/fixora retry ${run.runId} --from fix\`.`)
    }
    run.pipeline.validated = true
    await stageEnd(this.rt, run, "validate", "ok", report ? summarizeChecks(report) : `${change.paths.length} file(s), +${change.added} −${change.deleted}`)
    return "next"
  }

  private async feedbackToFixer(text: string) {
    const run = this.run
    const sessionID = await ensureWorker(this.rt, run, "fixer", { phase: this.o.feedback ? "feedback" : "fix" })
    const attempt = latestFixAttempt(run)
    const budget = this.opts.worker.maxPhaseMinutes.fix
    const r = await awaitSubmission(this.rt, run, sessionID, fixFollowUpPrompt(run, { attempt, problems: text }), {
      minutes: budget,
      signal: this.o.signal,
      label: `asking the agent to fix the problems (attempt ${attempt})`,
      pick: (fresh) => (fresh.fix?.attempt === attempt ? fresh : undefined),
      nudge: nudgePrompt("fixora_submit_fix", run.runId, SKILLS.fix, `attempt ${attempt}, with \`status\` and \`diff\` from git`),
    })
    if (!r.value) this.stopFor(r.outcome, `fix attempt ${attempt}`, budget, "fix")
    this.adopt(r.value)
  }

  private async review(): Promise<"next" | "loop"> {
    const run = this.run
    if (this.opts.maxReviewRounds === 0) {
      run.pipeline.reviewed = true
      return "next"
    }
    await stageBegin(this.rt, run, "review")
    const attempt = run.reviews.length + 1
    const verdict = await runReview(this.rt, run, { signal: this.o.signal })
    if (!verdict) throw new FixoraStop(`The reviewer produced no verdict (round ${attempt}). \`/fixora retry ${run.runId} --from review\`.`)
    if (verdict.verdict === "reject") {
      const important = verdict.findings.filter((f) => f.severity !== "minor")
      if (run.counters.reviewRounds < this.opts.maxReviewRounds - 1) {
        run.counters.reviewRounds++
        await saveRun(this.ctx, run)
        await stageEnd(this.rt, run, "review", "failed", `rejected: ${verdict.summary}`)
        await this.feedbackToFixer(`An independent review rejected the fix (round ${run.counters.reviewRounds}/${this.opts.maxReviewRounds}): ${verdict.summary}\nAddress each item:\n${important.map((f) => `- [${f.severity}/${f.category}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}${f.suggestion ? ` → ${f.suggestion}` : ""}`).join("\n")}\nRe-run the checks afterwards.`)
        return "loop"
      }
      run.status = "review-exhausted"
      throw new FixoraStop(`The reviewer rejected the fix ${run.reviews.length} time(s); last reasons: ${important.map((f) => `${f.file}: ${f.message}`).join("; ") || verdict.summary}. The change stays uncommitted on \`${run.branch}\` (the checkout is restored to your branch; switch back with \`git checkout ${run.branch}\` to inspect it). Fix by hand and \`/fixora retry ${run.runId} --from fix\`, or \`/fixora restart ${run.runId}\`.`)
    }
    run.pipeline.reviewed = true
    await stageEnd(this.rt, run, "review", "ok", `${verdict.verdict} — ${verdict.summary.slice(0, 100)}`)
    await this.rt.emit("run.card", { runId: run.runId, sessionID: run.originSessionID, kind: "validation", data: { files: run.fix?.filesChanged ?? [], checks: run.tests ? summarizeChecks(run.tests) : "", review: `${verdict.verdict} (round ${run.reviews.length})` } })
    await present(this.ctx, run.originSessionID, `fixora ${run.runId}: fix verified and reviewed (${verdict.verdict})`, renderValidationCard(run))
    return "next"
  }

  /** Commit, push and MR by the worker after the approval gate(s). Re-entrant: only missing parts are prompted. */
  private async publish(): Promise<"next" | "stop"> {
    const run = this.run
    await stageBegin(this.rt, run, "publish")
    const target = this.opts.mr.target ?? run.base.branch
    const mr = renderMr(run, { crash: this.crash, draft: this.opts.mr.draft, base: target })
    const commitMessageFile = join(run.folder, "commit-message.txt")
    const mrBodyFile = join(run.folder, "mr.md")
    await writeFile(mrBodyFile, `# ${mr.title}\n\n${mr.body}\n`)
    await writeFile(commitMessageFile, renderCommitMessage(run, { crashUrl: this.crashUrl() }))
    if (run.flags.dryRun) {
      run.status = "done"
      await stageEnd(this.rt, run, "publish", "skipped", "dry run: commit message and MR body written to the run folder")
      this.notes.push(`Dry run: nothing committed. The change stays uncommitted on \`${run.branch}\` (see ${mrBodyFile} and commit-message.txt).`)
      return "stop"
    }
    const files = run.fix?.filesChanged ?? run.change?.paths ?? []
    const needCommit = !run.pipeline.committed
    const gates = gateKinds(this.opts)
    const pushDecision = decideApproval(gates.push, run, this.opts, { serviceAvailable: !!run.base.remoteUrl })
    const needPush = pushDecision.decision !== "skip" && !run.pipeline.pushed
    const wantMr = run.flags.mr && !!this.remote && !run.mrUrl && pushDecision.decision !== "skip"
    const order = this.remote ? mrProviderOrder(this.rt.services, this.remote, { forge: this.opts.mr.forge }) : []
    const provider: MrProvider = order[0] ?? "url"
    const mrTarget = this.remote ? { remote: this.remote, base: target, branch: run.branch! } : undefined
    const preview = renderApprovalPreview(run, { kind: gates.push, branch: run.branch, remote: this.remote?.web ?? run.base.remoteUrl ?? undefined, target, mr: gates.push === "publish" && wantMr ? { ...mr, provider } : undefined, crashUrl: this.crashUrl() })
    await writeFile(join(run.folder, "publish-preview.md"), `${preview}\n`)

    const grants: WorkerGrants = { commit: needCommit }
    if (pushDecision.decision === "skip") {
      run.approvals[gates.push] = "skipped"
      this.notes.push(`Push skipped (${pushDecision.reason}). The fix is committed on \`${run.branch}\`.`)
    } else if (needPush || wantMr) {
      if (pushDecision.decision === "ask") {
        const resources = [
          `push branch ${run.branch} to ${run.base.remote} (${this.remote?.web ?? run.base.remoteUrl})`,
          `${files.length} file(s)${run.change ? `, +${run.change.added} −${run.change.deleted}` : ""}`,
          run.tests ? `checks: ${summarizeChecks(run.tests)}` : "checks: none",
          `review: ${run.reviews[run.reviews.length - 1]?.verdict ?? "none"} · confidence ${Math.round((run.triage?.confidence ?? 0) * 100)}%`,
        ]
        if (gates.push === "publish" && wantMr) resources.push(`open ${this.opts.mr.draft ? "draft " : ""}MR via ${provider} → ${target}: ${mr.title}`)
        await approve(this.rt, run, gates.push, {
          resources,
          summary: gates.push === "publish" ? `push ${run.branch} and open a ${this.opts.mr.draft ? "draft " : ""}MR` : `push ${run.branch}`,
          previewPath: join(run.folder, "publish-preview.md"),
          preview: this.gatePreview({ mrTitle: gates.push === "publish" && wantMr ? mr.title : undefined, mrBody: gates.push === "publish" && wantMr ? mr.body : undefined, target, provider }),
        })
      } else {
        run.approvals[gates.push] = "auto"
        await notify(this.ctx, run.originSessionID, `fixora ${run.runId}: auto-approved (${pushDecision.reason})`)
      }
      grants.push = needPush
      if (gates.push === "publish") grants.mr = wantMr
    }
    // With approvals: "each", the MR has its own gate after the push.
    const plan = (g: WorkerGrants): PublishPlan => ({
      commit: !!g.commit,
      push: !!g.push,
      mr: !!g.mr,
      files,
      commitMessageFile,
      mrBodyFile,
      signoff: this.opts.signoff,
      remote: run.base.remote,
      branch: run.branch!,
      target,
      attempts: g.mr && mrTarget ? renderMrAttempts({ order, target: mrTarget, mr: { ...mr, draft: this.opts.mr.draft, labels: this.opts.mr.labels, reviewers: this.opts.mr.reviewers }, services: this.rt.services, toolProps: (id) => toolProps(this.rt, id), bodyFile: mrBodyFile }) : [],
      committedSha: run.commitShas[run.commitShas.length - 1],
      pushedAlready: run.pipeline.pushed,
    })
    if (grants.commit || grants.push || grants.mr) await this.publishWith(grants, plan(grants))
    if (gates.mr && wantMr && !run.mrUrl && run.pipeline.pushed) {
      await approve(this.rt, run, "mr", { resources: [`open ${this.opts.mr.draft ? "draft " : ""}MR via ${provider} → ${target}: ${mr.title}`], summary: `open a merge request via ${provider}`, previewPath: mrBodyFile, preview: this.gatePreview({ mrTitle: mr.title, mrBody: mr.body, target, provider }) })
      await this.publishWith({ mr: true }, plan({ mr: true }))
    }
    // An existing MR (feedback round) gets its body refreshed by the worker.
    if (run.mrUrl && run.mrProvider && run.mrProvider !== "url" && mrTarget && this.o.feedback && run.pipeline.pushed) {
      const op = renderMrOp({ provider: run.mrProvider as MrProvider, op: "update", target: mrTarget, id: run.mrId, url: run.mrUrl, title: mr.title, bodyFile: mrBodyFile, services: this.rt.services, toolProps: (id) => toolProps(this.rt, id) })
      if (op) await this.runOp({ phase: "publish", grants: { mr: true }, op: "close-mr", title: `update the merge request ${run.mrUrl} with the new body`, steps: [op.toolId ? { call: { toolId: op.toolId, namespace: op.namespace, input: op.input ?? {} }, note: `send the contents of ${mrBodyFile} as the description/body` } : { command: op.command }], report: "{ updated: true }", minutes: this.opts.worker.maxPhaseMinutes.publish, fatal: false })
    }
    if (pushDecision.decision === "skip") {
      run.status = "done"
      await stageEnd(this.rt, run, "publish", "ok", `committed ${run.commitShas[run.commitShas.length - 1]?.slice(0, 10) ?? ""} (push skipped)`)
      return "stop"
    }
    if (!run.pipeline.pushed) throw new FixoraStop(`The branch was not pushed: ${run.meta?.publishErrors ?? "no push reported"}. \`/fixora retry ${run.runId} --from publish\`.`)
    if (wantMr && !run.mrUrl) {
      const compare = typeof run.meta?.compareUrl === "string" ? run.meta.compareUrl : this.remote ? compareUrl(this.remote, target, run.branch!) : undefined
      run.meta = { ...run.meta, compareUrl: compare ?? null }
      this.notes.push(`No merge request was opened (${run.meta?.mrSkippedReason ?? run.meta?.publishErrors ?? "no provider worked"})${compare ? `; open it at ${compare}` : ""}.`)
    } else if (!run.flags.mr && this.remote) run.meta = { ...run.meta, compareUrl: compareUrl(this.remote, target, run.branch!) }
    await stageEnd(this.rt, run, "publish", "ok", `${run.commitShas[run.commitShas.length - 1]?.slice(0, 10) ?? ""} → ${run.base.remote}/${run.branch}${run.mrUrl ? ` · ${run.mrUrl}` : ""}`)
    return "next"
  }

  private async publishWith(grants: WorkerGrants, plan: PublishPlan) {
    const run = this.run
    const sessionID = await ensureWorker(this.rt, run, "fixer", { phase: "publish", grants })
    const token = await this.expect("publish")
    const budget = this.opts.worker.maxPhaseMinutes.publish
    const r = await awaitSubmission(this.rt, run, sessionID, publishPrompt(run, plan), {
      minutes: budget,
      signal: this.o.signal,
      label: `the agent is publishing (${[grants.commit && "commit", grants.push && "push", grants.mr && "MR"].filter(Boolean).join(" + ")})`,
      pick: (fresh) => (fresh.meta?.received === token ? fresh : undefined),
      nudge: nudgePrompt("fixora_submit_publish", run.runId, SKILLS.publish, "what succeeded so far (committed / pushed / mr) and the errors"),
    })
    if (!r.value) this.stopFor(r.outcome, "the publish phase", budget, "publish")
    this.adopt(r.value)
    if (grants.commit && !run.pipeline.committed) throw new FixoraStop(`The fix was not committed: ${run.meta?.publishErrors ?? "no commit reported"}. \`/fixora retry ${run.runId} --from publish\`.`)
  }

  private async closeLoop(): Promise<"next"> {
    const run = this.run
    await stageBegin(this.rt, run, "close-loop")
    const jira = this.rt.services.jira
    const steps: Array<{ call?: { toolId: string; namespace?: string; input: Record<string, unknown>; note?: string }; note?: string }> = []
    const grants: WorkerGrants = {}
    if (run.jiraKey && connected(jira) && jira.capabilities.addComment) {
      grants.jiraWrite = true
      const kind = this.o.feedback ? "feedback" : "mr"
      if (run.mrUrl || this.o.feedback) steps.push({ call: { toolId: jira.capabilities.addComment, namespace: jira.namespace, input: jiraCommentInput(run.jiraKey, renderJiraComment(kind, run, { mrUrl: run.mrUrl, message: this.o.feedback })) } })
      if (this.opts.jira.transitionOnMr && run.mrUrl && !this.o.feedback && jira.capabilities.getTransitions && jira.capabilities.transition) {
        steps.push({ call: { toolId: jira.capabilities.getTransitions, namespace: jira.namespace, input: jiraTransitionsInput(run.jiraKey) }, note: `then pick the transition whose name matches "${this.opts.jira.transitionOnMr}" (case and punctuation insensitive) and apply it with \`${jira.capabilities.transition}\` { issue_key: "${run.jiraKey}", transition_id: "<id>" }; skip when no transition matches and say so in results.transition` })
      }
    }
    if (this.opts.sourceWriteBack && run.source !== "manual") {
      const call = sourceById(run.source).annotatePlan?.(sourceContext(this.rt), run.crashId, { text: `Fixora opened ${run.mrUrl ?? `branch ${run.branch}`}${run.jiraKey ? ` (Jira ${run.jiraKey})` : ""}. Root cause: ${run.triage?.rootCause.slice(0, 300) ?? ""}`, mrUrl: run.mrUrl, jiraKey: run.jiraKey }, this.extra)
      if (call) {
        grants.sourceWrite = true
        steps.push({ call })
      }
    }
    if (steps.length === 0) {
      run.pipeline.loopClosed = true
      await stageEnd(this.rt, run, "close-loop", "ok", "nothing to link")
      return "next"
    }
    const result = await this.runOp({ phase: "close-loop", grants, op: "close-loop", title: `link the result on ${[run.jiraKey && `Jira ${run.jiraKey}`, this.opts.sourceWriteBack && run.source].filter(Boolean).join(" and ")}`, steps, report: "{ comment: true/false, transition: \"<name or none>\", note: true/false }", minutes: this.opts.worker.maxPhaseMinutes.crash, fatal: false })
    run.pipeline.loopClosed = true
    await stageEnd(this.rt, run, "close-loop", "ok", result?.ok === false ? `partly: ${result.errors.join("; ")}` : run.jiraKey ? `Jira ${run.jiraKey} updated` : "source annotated")
    return "next"
  }

  /** Always runs in `finally`: the worker checks the previous branch out again and pops the stash. */
  private async restore() {
    const run = this.run
    if (!run.checkout?.active) return
    // The run's outcome is already decided; the restore stage must not reset it to "running".
    const outcome = { status: run.status, error: run.error, step: run.step }
    await stageBegin(this.rt, run, "restore")
    run.status = outcome.status
    const result = await this.runOp({ phase: "restore", op: "restore", title: `restore the checkout to \`${run.checkout.previousBranch ?? run.checkout.previousHeadSha ?? "the previous branch"}\`${run.checkout.stashRef ? " and pop the stash" : ""}`, steps: restoreSteps(run), report: `{ branch: "<branch now checked out>", stashPopped: true/false }`, minutes: this.opts.worker.maxPhaseMinutes.restore, fatal: false, signal: undefined }).catch(() => undefined)
    run.status = outcome.status
    run.error = outcome.error
    if (result?.ok && !run.checkout.active) {
      await stageEnd(this.rt, run, "restore", "ok", `${run.checkout.previousBranch ?? "previous branch"}${run.checkout.stashRef ? " · stash popped" : ""}`)
      run.step = outcome.step
      return
    }
    await stageEnd(this.rt, run, "restore", "failed", result?.errors.join("; ") || "the worker did not report back")
    run.step = outcome.step
    run.error = outcome.error
    this.notes.push(`⚠ Your checkout is still on \`${run.branch}\`${run.checkout.stashRef ? " and your changes are stashed" : ""}. Restore by hand:\n\`\`\`\n${manualRestoreText(run)}\n\`\`\``)
  }

  /** One ops prompt in the fixer session: close-loop / restore / MR update. Never throws when `fatal` is false. */
  private async runOp(o: { phase: "close-loop" | "restore" | "publish" | "clean"; grants?: WorkerGrants; op: string; title: string; steps: Array<{ call?: { toolId: string; namespace?: string; input: Record<string, unknown>; note?: string }; command?: string; note?: string }>; report: string; minutes: number; fatal: boolean; signal?: AbortSignal | undefined }): Promise<{ ok: boolean; errors: string[]; results: Record<string, unknown> } | undefined> {
    const run = this.run
    const sessionID = await ensureWorker(this.rt, run, "fixer", { phase: o.phase, grants: o.grants })
    const token = await this.expect(o.op)
    const prompt = opsPrompt({ runId: run.runId, op: o.op, title: o.title, steps: o.steps, report: o.report, repo: run.repo })
    const r = await awaitSubmission(this.rt, run, sessionID, prompt, {
      minutes: o.minutes,
      signal: "signal" in o ? o.signal : this.o.signal,
      label: o.title,
      pick: (fresh) => (fresh.meta?.received === token ? fresh : undefined),
      nudge: nudgePrompt("fixora_submit_ops", run.runId, SKILLS.ops, `op "${o.op}", ok true/false, results, errors`),
    })
    if (!r.value) {
      if (o.fatal) this.stopFor(r.outcome, o.title, o.minutes, run.step)
      return undefined
    }
    this.adopt(r.value)
    try {
      return JSON.parse(String(run.meta?.opsResult ?? "")) as { ok: boolean; errors: string[]; results: Record<string, unknown> }
    } catch {
      return undefined
    }
  }

  private async done(): Promise<"stop"> {
    const run = this.run
    run.status = "done"
    run.step = "done"
    run.timings.done = { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 0, attempts: 1, status: "ok" }
    run.totalMs = Object.values(run.timings).reduce((s, x) => s + (x?.durationMs ?? 0), 0)
    return "stop"
  }

  /** What the TUI approval dialog shows; the markdown preview file stays the source for the permission fallback. */
  private gatePreview(o: { mrTitle?: string; mrBody?: string; target: string; provider: string }) {
    const run = this.run
    const review = run.reviews[run.reviews.length - 1]
    return {
      branch: run.branch,
      remote: this.remote?.web ?? run.base.remoteUrl ?? undefined,
      target: o.target,
      files: run.fix?.filesChanged ?? [],
      additions: run.change?.added,
      deletions: run.change?.deleted,
      checks: run.tests ? summarizeChecks(run.tests) : undefined,
      review: review ? `${review.verdict} (round ${run.reviews.length})` : undefined,
      confidence: run.triage?.confidence,
      rootCause: run.triage?.rootCause,
      risk: run.fix?.risk.level ?? run.triage?.risk.level,
      mrTitle: o.mrTitle,
      mrBody: o.mrBody ? o.mrBody.slice(0, 6000) : undefined,
      mrProvider: o.provider,
      jiraKey: run.jiraKey,
      crashUrl: this.crashUrl(),
      previewPath: join(run.folder, "publish-preview.md"),
    }
  }

  // ---------- helpers used by flows ----------

  static async moveToHistory(folder: string, keep: string[] = ["crash.json", "crash.md", "run.log", "trace.txt"]) {
    if (!existsSync(folder)) return
    const entries = (await readdir(folder)).filter((e) => e !== ".history" && !keep.includes(e))
    if (entries.length === 0) return
    const history = join(folder, ".history", new Date().toISOString().replace(/[:.]/g, "-"))
    await mkdir(history, { recursive: true })
    for (const e of entries) await rename(join(folder, e), join(history, e))
  }
}

function blockedHelp(run: RunRecord): string {
  const detail = run.error ? ` (${run.error})` : ""
  if (run.blockedReason === "not-a-repo") return `Fixora needs a git repository: ${run.repo} is not one${detail}. Open the project checkout in DXcoder and run the command again.`
  if (run.blockedReason === "base-missing") return `Base branch "${run.base.branch}" was not found on remote "${run.base.remote}" nor locally${detail}. Set "baseBranch" in the plugin options or pass --base <branch>, check that \`git fetch\` works in a terminal, then \`/fixora retry ${run.runId}\`.`
  return `The prepare phase was blocked${detail}. \`/fixora retry ${run.runId}\` after fixing the cause.`
}
