// The per-crash pipeline in three agent turns: WORK (fetch → prepare → analyse → fix in one fixer
// session; the submit tools steer the agent from stage to stage and flip its permission phase),
// REVIEW (a fresh session) and PUBLISH (ticket → commit → push → MR → links → restore, after one
// approval). The plugin only decides and validates; every git command, check, MCP call and CLI is
// run by the agent inside the user's checkout. Steps are idempotent and resumable; the checkout is
// restored on every exit path.

import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { duplicateMessage, indexCrash } from "./crashindex.js"
import { describeError } from "./errors.js"
import { ApprovalRejected, approve, decideApproval } from "./gate.js"
import { branchFromTemplate, branchName, compareUrl, parseRemote, slug, type ParsedRemote } from "./git.js"
import { dedupeJql, jiraAvailable, jiraBaseUrl, jiraCommentInput, jiraCreateInput, jiraSearchInput, jiraTransitionsInput, schemaParamType } from "./jira.js"
import { connected } from "./mcp.js"
import { mrProviderOrder, renderLabelSteps, renderMrAttempts, renderMrOp, type MrProvider } from "./mr.js"
import { fixFollowUpPrompt, nudgePrompt, opsPrompt, publishPrompt, renderTestFailureText, restorePlan, restoreSteps, SKILLS, workPrompt, type OpStep, type PublishPlan, type TicketPlan, type WorkStage } from "./prompts.js"
import { appendLog, FixoraStop, notify, present, sourceContext, stageBegin, stageEnd, stageMark, toolProps, type Runtime } from "./progress.js"
import { renderApprovalPreview, renderCommitMessage, renderCrashMarkdown, renderFinalReport, renderJiraComment, renderJiraIssue, renderMr, renderTriageCard, renderValidationCard } from "./render.js"
import { ensureRunRepo } from "./repo.js"
import { latestFixAttempt, runReview } from "./review.js"
import { scanAddedLines } from "./secrets.js"
import { sourceById } from "./sources/index.js"
import { crashFromFile } from "./sources/manual.js"
import { fixInProgress, saveRun } from "./state.js"
import { STEPS, type Crash, type RunRecord, type Step, type WorkerGrants, type WorkerPhase } from "./types.js"
import { checkChangedFiles, failedChecks, summarizeChecks } from "./validate.js"
import { awaitSubmission, ensureWorker, lastAssistantText, type Outcome } from "./worker.js"

export interface PipelineOptions {
  from: Step
  signal: AbortSignal
  /** Feedback text when resuming after `/fixora feedback`. */
  feedback?: string
}

type Phase = "detect" | "fetch" | "work" | "validate" | "review" | "publish" | "done"
const PHASES: Phase[] = ["detect", "fetch", "work", "validate", "review", "publish", "done"]
const PHASE_OF: Record<Step, Phase> = { detect: "detect", fetch: "fetch", prepare: "work", analyse: "work", ticket: "publish", fix: "work", validate: "validate", review: "review", publish: "publish", "close-loop": "publish", restore: "done", done: "done" }

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
  /** What the worker said last (its final message), for failures where it stopped without a report. */
  private async lastWords(sessionID: string): Promise<string> {
    const text = (await lastAssistantText(this.rt, sessionID)).replace(/\s+/g, " ").trim()
    return text ? ` The worker's last message: "${text.slice(0, 500)}${text.length > 500 ? "…" : ""}".` : ""
  }
  /** The reason the last report of this run was refused, for failure messages. */
  private lastRejection(): string {
    const r = this.run.meta?.lastRejection
    return typeof r === "string" && r ? ` Last report refused — ${r}.` : ""
  }
  private crashUrl() {
    return this.crash?.url ?? (typeof this.run.meta?.crashUrl === "string" ? this.run.meta.crashUrl : undefined)
  }
  private get extra(): Record<string, string> | undefined {
    return this.run.meta?.refExtra ? (JSON.parse(String(this.run.meta.refExtra)) as Record<string, string>) : undefined
  }

  async execute(): Promise<RunRecord> {
    const run = this.run
    const from: Step = this.o.feedback ? "fix" : this.o.from
    let i = Math.max(0, PHASES.indexOf(PHASE_OF[from]))
    try {
      await this.reload()
      while (i < PHASES.length) {
        if (this.o.signal.aborted) throw new FixoraStop(`run ${run.runId} was cancelled`)
        const phase = PHASES[i]!
        // Re-entry after a restore (retry, feedback): the checkout has to be prepared again first.
        if ((phase === "validate" || phase === "review" || phase === "publish") && !run.checkout.active) {
          const r = await this.work(["prepare"])
          if (r === "stop") break
        }
        const next = await this.runPhase(phase, from)
        if (next === "stop") break
        if (next === "loop") {
          i = PHASES.indexOf("validate")
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

  private async runPhase(phase: Phase, from: Step): Promise<"next" | "stop" | "loop"> {
    switch (phase) {
      case "detect":
        return this.detect()
      case "fetch":
        return this.fetch()
      case "work":
        return this.work(this.stagesFor(from))
      case "validate":
        return this.validate()
      case "review":
        return this.review()
      case "publish":
        return this.publish()
      case "done":
        return this.done()
    }
  }

  /** Which stages the work turn still has to do when the pipeline enters it at `from`. */
  private stagesFor(from: Step): WorkStage[] {
    if (this.o.feedback) return ["fix"]
    return from === "fix" ? ["fix"] : from === "analyse" ? ["triage", "fix"] : ["prepare", "triage", "fix"]
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
    this.run.meta = { ...this.run.meta, expect: token, received: null, lastRejection: null }
    await saveRun(this.ctx, this.run)
    return token
  }

  /** Takes over what the submit tools persisted (they also record stage events and phases). */
  private adopt(fresh: RunRecord) {
    Object.assign(this.run, fresh)
    const file = join(this.run.folder, "crash.json")
    if (!this.crash && existsSync(file)) this.crash = JSON.parse(readFileSync(file, "utf8")) as Crash
    this.remote = this.run.base.remoteUrl ? parseRemote(this.run.base.remoteUrl, this.opts.mr.forge) : undefined
  }

  private async fail(error: unknown) {
    const run = this.run
    const step = run.step
    if (error instanceof Error && !(error instanceof FixoraStop) && !(error instanceof ApprovalRejected) && error.stack) await this.log(`unexpected error at ${step}: ${error.stack}`).catch(() => {})
    if (error instanceof ApprovalRejected) {
      run.status = "rejected"
      await stageEnd(this.rt, run, step, "failed", error.message)
      this.notes.push(`${error.message} Nothing was sent. Re-run \`/fixora retry ${run.runId} --from ${step}\` when ready.`)
      return
    }
    if (error instanceof FixoraStop) {
      if (run.status === "running" || run.status === "awaiting-approval") run.status = this.o.signal.aborted ? "cancelled" : "failed"
      run.error = error.message
      if (run.timings[step]?.status === "running") await stageEnd(this.rt, run, step, run.status === "skipped" ? "skipped" : "failed", undefined, error.message)
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
    if (run.status === "done") await this.settle()
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

  private stopFor(outcome: Outcome, what: string, budgetMinutes: number, retryFrom: Step): never {
    const run = this.run
    if (outcome === "aborted") throw new FixoraStop(`run ${run.runId} was cancelled during ${what}`)
    if (outcome === "timeout") {
      run.status = "timeout"
      throw new FixoraStop(`${what} exceeded ${budgetMinutes} minutes and was interrupted. \`/fixora retry ${run.runId} --from ${retryFrom}\` resumes the same session.`)
    }
    throw new FixoraStop(`The worker did not report back from ${what}. See the worker session (${run.sessions.fixer ?? "?"}), then \`/fixora retry ${run.runId} --from ${retryFrom}\`.`)
  }

  // ---------- phases ----------

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
    await stageEnd(this.rt, run, "detect", "ok", `${services.join(", ") || "no MCP"} · checkout ${run.repo} · fixora ${this.rt.version ?? "dev"}`)
    return "next"
  }

  /** Pasted traces are parsed here; crashes from a source are fetched by the agent as the first stage of the work turn. */
  private async fetch(): Promise<"next"> {
    const run = this.run
    const file = join(run.folder, "crash.json")
    if (existsSync(file) && !run.flags.force) {
      this.crash = JSON.parse(await readFile(file, "utf8")) as Crash
      return "next"
    }
    if (run.source !== "manual") return "next"
    await stageBegin(this.rt, run, "fetch")
    const extra = this.extra
    this.crash = await crashFromFile({ file: extra?.file ?? run.crashId, title: extra?.title, platform: extra?.platform, language: extra?.language, appPackage: this.opts.appPackage, inAppPrefixes: this.opts.inAppPackages })
    await writeFile(file, `${JSON.stringify(this.crash, null, 2)}\n`)
    run.title = this.crash.title
    run.fingerprint = this.crash.fingerprint
    run.meta = { ...run.meta, crashUrl: null, platform: this.crash.platform ?? null, appVersion: null, language: this.crash.language, symbolication: this.crash.symbolication, userCount: null, eventCount: null }
    const index = await indexCrash(this.ctx, run, this.crash)
    if (index.reopened) {
      await this.rt.emit("crash.reopened", { runId: run.runId, fingerprint: this.crash.fingerprint, reason: index.reopened.reason, previousRunId: index.reopened.previousRunId })
      await notify(this.ctx, run.originSessionID, `fixora ${run.runId}: ⚠ reopened crash — fixed in ${index.reopened.fixedIn}, seen again (${index.reopened.reason})`)
    }
    await writeFile(join(run.folder, "crash.md"), `${renderCrashMarkdown(this.crash, { reopened: run.reopened ? { ...run.reopened } : undefined })}\n`)
    if (index.duplicateOf) {
      run.status = "skipped"
      run.skipReason = `same crash fingerprint as run ${index.duplicateOf.runId}`
      throw new FixoraStop(duplicateMessage(index.duplicateOf))
    }
    await stageEnd(this.rt, run, "fetch", "ok", `${this.crash.exceptionType ?? this.crash.title} · ${this.crash.frames.length} frames · ${this.crash.language}${this.crash.symbolication !== "ok" ? ` · symbolication: ${this.crash.symbolication}` : ""}`)
    return "next"
  }

  /**
   * The WORK turn. One prompt lists the stages still to do; the submit tools move the session from
   * stage to stage (and record the stage events). The plugin steps in only for the stash approval.
   */
  private async work(wanted: WorkStage[]): Promise<"next" | "stop"> {
    const run = this.run
    const stages: WorkStage[] = [...wanted]
    if (!run.checkout.active && !stages.includes("prepare")) stages.unshift("prepare")
    const needFetch = run.source !== "manual" && !existsSync(join(run.folder, "crash.json"))
    if (needFetch && !stages.includes("fetch")) stages.unshift("fetch")
    const stepOf = (s: WorkStage): Step => (s === "fetch" ? "fetch" : s === "prepare" ? "prepare" : s === "triage" ? "analyse" : "fix")
    const phaseOf = (s: WorkStage): WorkerPhase => (s === "fetch" ? "crash" : s === "prepare" ? "prepare" : s === "triage" ? "triage" : this.o.feedback ? "feedback" : "fix")
    let firstStep: Step = stepOf(stages[0]!)
    await stageBegin(this.rt, run, firstStep)
    run.meta = { ...run.meta, workStages: stages.join(","), feedback: this.o.feedback ? true : null }
    const attempt = latestFixAttempt(run)
    const fetch = needFetch ? sourceById(run.source).fetchPlan!(sourceContext(this.rt), run.crashId, this.extra) : undefined
    const m = this.opts.worker.maxPhaseMinutes
    const budgetOf = (list: WorkStage[]) => list.reduce((sum, s) => sum + (s === "fetch" ? m.crash : s === "prepare" ? m.prepare : s === "triage" ? m.triage : m.fix), 0)
    let budget = budgetOf(stages)
    const checks = run.toolchain?.checks ?? []
    let sessionID = await ensureWorker(this.rt, run, "fixer", { phase: phaseOf(stages[0]!) })
    const turn = async (prompt: ReturnType<typeof workPrompt>, label: string) => {
      const token = await this.expect("work")
      const r = await awaitSubmission(this.rt, run, sessionID, prompt, {
        minutes: budget,
        signal: this.o.signal,
        label,
        pick: (fresh) => (fresh.meta?.received === token ? fresh : undefined),
        nudge: nudgePrompt("the next fixora_submit_* tool of the stage you are in", run.runId, prompt.skills, "what you have"),
      })
      if (!r.value) this.stopFor(r.outcome, "the work turn", budget, firstStep)
      this.adopt(r.value)
      return r.outcome
    }
    const afterFetch = async (outcome: Outcome) => {
      if (run.status === "skipped") throw new FixoraStop(run.error ?? run.skipReason ?? "skipped")
      if (run.status === "blocked") throw new FixoraStop(blockedHelp(run))
      if (run.reopened) await this.rt.emit("crash.reopened", { runId: run.runId, fingerprint: run.fingerprint, reason: run.reopened.reason, previousRunId: run.reopened.previousRunId })
      if (!this.crash && stages.includes("prepare")) {
        if (outcome !== "done") this.stopFor(outcome, "the crash fetch", budget, "fetch")
        throw new FixoraStop(`The agent did not submit the crash. See the worker session, then \`/fixora retry ${run.runId}\`.`)
      }
    }
    let outcome: Outcome = "done"
    // The branch name needs the Jira key and the ticket needs the crash: fetch first, in its own turn.
    if (needFetch && stages.includes("prepare") && this.ticketBeforeBranchWanted()) {
      run.meta = { ...run.meta, workStages: "fetch" }
      outcome = await turn(workPrompt(run, this.opts, { stages: ["fetch"], fetch, fallbackBranch: "", attempt, checks }), "the agent is fetching the crash")
      await afterFetch(outcome)
      stages.splice(stages.indexOf("fetch"), 1)
      firstStep = "prepare"
      budget = budgetOf(stages)
      await stageBegin(this.rt, run, "prepare")
      run.meta = { ...run.meta, workStages: stages.join(",") }
    }
    const naming = await this.planBranch(stages.includes("prepare"))
    const fallbackBranch = naming.branch
    sessionID = await ensureWorker(this.rt, run, "fixer", { phase: phaseOf(stages[0]!), grants: naming.ticket ? { jiraWrite: true } : {} })
    const branchInput = { fallbackBranch, exactBranch: naming.exact, ticket: naming.ticket, ticketFallback: naming.ticketFallback }
    outcome = await turn(workPrompt(run, this.opts, { stages, fetch: stages.includes("fetch") ? fetch : undefined, ...branchInput, attempt, checks, feedback: this.o.feedback }), `the agent is working (${stages.join(" → ")})`)
    // Outcomes the tools recorded.
    if (stages.includes("fetch")) await afterFetch(outcome)
    else if (run.status === "skipped") throw new FixoraStop(run.error ?? run.skipReason ?? "skipped")
    else if (run.status === "blocked") throw new FixoraStop(blockedHelp(run))
    // Dirty checkout: ask, then let the same session continue from the stash onward.
    if (run.meta?.prepareStage === "inspect" && run.meta?.prepareDirty === true && !run.checkout.active) {
      const files = Number(run.meta?.prepareDirtyFiles ?? 0)
      const status = String(run.meta?.prepareStatus ?? "")
      if (run.branch) {
        // Re-entry: the prompt told the agent to carry uncommitted changes onto the fix branch; a dirty
        // report here means it could not (a conflicting checkout). Never stash a fix in progress.
        run.status = "blocked"
        run.blockedReason = "dirty-worktree"
        throw new FixoraStop(`The checkout ${run.repo} has ${files} uncommitted change(s) that could not be carried onto \`${run.branch}\`${this.lastRejection()}. If they are the fix of this run, \`git checkout ${run.branch}\` with them (resolve what git refuses); if they are your own work, commit or stash it; then \`/fixora retry ${run.runId} --from fix\`.`)
      }
      const decision = decideApproval("stash", run, this.opts, { serviceAvailable: true })
      if (decision.decision === "ask") {
        await writeFile(join(run.folder, "stash-preview.md"), `${renderApprovalPreview(run, { kind: "stash", branch: fallbackBranch, stash: { files, status }, crashUrl: this.crashUrl() })}\n`)
        try {
          await approve(this.rt, run, "stash", {
            resources: [`stash ${files} uncommitted change(s) in ${run.repo} (git stash push -u)`, `work on branch ${fallbackBranch}, then pop the stash and check out ${run.checkout.previousBranch ?? "your branch"} again`],
            summary: `stash ${files} local change(s) before fixing`,
            previewPath: join(run.folder, "stash-preview.md"),
            preview: { branch: fallbackBranch, stash: { files, status: status.split("\n").slice(0, 20).join("\n") }, crashUrl: this.crashUrl(), previewPath: join(run.folder, "stash-preview.md") },
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
      const rest = stages.filter((s) => s !== "fetch")
      run.meta = { ...run.meta, workStages: rest.join(",") }
      await stageBegin(this.rt, run, "prepare")
      outcome = await turn(workPrompt(run, this.opts, { stages: rest, ...branchInput, stashApproved: true, attempt, checks, feedback: this.o.feedback }), "the agent is stashing your changes and continuing")
      if ((run.status as string) === "blocked") throw new FixoraStop(blockedHelp(run))
    }
    if (!run.checkout.active || !run.branch) throw new FixoraStop(`The prepare stage did not end with a checked-out branch.${this.lastRejection()} See the worker session, then \`/fixora retry ${run.runId} --from prepare\`.`)
    if (!run.base.remoteUrl && stages.includes("prepare")) await notify(this.ctx, run.originSessionID, `fixora ${run.runId}: no remote "${run.base.remote}" — push and MR will be skipped`)
    if (stages.includes("triage")) {
      if (!run.triage) {
        if (outcome !== "done") this.stopFor(outcome, "the analysis", budget, "analyse")
        throw new FixoraStop(`The worker ended its turn without a triage report.${this.lastRejection()}${await this.lastWords(sessionID)} \`/fixora retry ${run.runId} --from analyse\` continues in the same session.`)
      }
      const t = run.triage
      const sc = t.suspectCommits[0]
      await this.rt.emit("run.card", { runId: run.runId, sessionID: run.originSessionID, kind: "triage", data: { rootCause: t.rootCause, confidence: t.confidence, category: t.category, risk: t.risk.level, classification: t.classification, introducedBy: sc ? `${sc.sha.slice(0, 10)} ${sc.subject}${t.introducedInRelease ? ` · ${t.introducedInRelease}` : ""}` : undefined, reopened: run.reopened ? (t.reopenReason ?? run.reopened.reason) : undefined } })
      await present(this.ctx, run.originSessionID, `fixora ${run.runId}: root cause — ${t.classification}, ${Math.round(t.confidence * 100)}%`, renderTriageCard(run, this.crash!))
      if (t.classification !== "fixable" || t.confidence < this.opts.confidence.minToFix) {
        const why = t.classification !== "fixable" ? `classified as ${t.classification}` : `confidence ${Math.round(t.confidence * 100)}% is below minToFix ${Math.round(this.opts.confidence.minToFix * 100)}%`
        run.status = "skipped"
        run.skipReason = why
        if (this.opts.jira.ticketOnSkip && run.flags.ticket) await this.ticketOnSkip().catch(() => {})
        throw new FixoraStop(`Fixora stopped after the analysis: ${why}. ${t.classification === "needs_human" ? "A human decision is needed; see analysis.md. " : ""}See analysis.md in ${run.folder}; \`/fixora retry ${run.runId} --from analyse\` runs the analysis again, or lower "confidence.minToFix".`)
      }
    }
    if (stages.includes("fix")) {
      if (!run.fix || run.fix.attempt !== attempt) {
        if (this.o.feedback && outcome === "done") return this.answerOnly(sessionID)
        if (outcome !== "done") this.stopFor(outcome, "the fix stage", budget, "fix")
        throw new FixoraStop(`The worker ended its turn without a fix report.${this.lastRejection()}${await this.lastWords(sessionID)} \`/fixora retry ${run.runId} --from fix\` continues in the same session.`)
      }
      if (!run.fix.changesMade) {
        if (this.o.feedback) return this.answerOnly(sessionID)
        throw new FixoraStop(`The worker made no changes: ${run.fix.unresolved.join("; ") || run.fix.summary}. See the worker session, then \`/fixora retry ${run.runId} --from fix\`.`)
      }
      if (this.o.feedback) {
        run.pipeline.validated = false
        run.pipeline.reviewed = false
        run.pipeline.committed = false
        run.pipeline.pushed = false
      }
    }
    await saveRun(this.ctx, run)
    return "next"
  }

  /** `/fixora feedback` that was a question: show the answer, nothing to validate or publish. */
  private async answerOnly(sessionID: string): Promise<"stop"> {
    const run = this.run
    const answer = await lastAssistantText(this.rt, sessionID)
    run.status = "done"
    if (run.timings.fix?.status === "running") await stageEnd(this.rt, run, "fix", "ok", "answered")
    await present(this.ctx, run.originSessionID, `fixora ${run.runId}: answer`, answer || run.fix?.rationale || "The worker finished without changes and without a report.")
    return "stop"
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
    await stageBegin(this.rt, run, "fix")
    const r = await awaitSubmission(this.rt, run, sessionID, fixFollowUpPrompt(run, { attempt, problems: text }, this.opts), {
      minutes: budget,
      signal: this.o.signal,
      label: `asking the agent to fix the problems (attempt ${attempt})`,
      pick: (fresh) => (fresh.fix?.attempt === attempt ? fresh : undefined),
      nudge: nudgePrompt("fixora_submit_fix", run.runId, [SKILLS.fix], `attempt ${attempt}, with \`status\` and \`diff\` from git`),
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
      throw new FixoraStop(`The reviewer rejected the fix ${run.reviews.length} time(s); last reasons: ${important.map((f) => `${f.file}: ${f.message}`).join("; ") || verdict.summary}. The change stays uncommitted on \`${run.branch}\`, which stays checked out. Fix by hand and \`/fixora retry ${run.runId} --from fix\`, or \`/fixora restart ${run.runId}\`.`)
    }
    run.pipeline.reviewed = true
    await stageEnd(this.rt, run, "review", "ok", `${verdict.verdict} — ${verdict.summary.slice(0, 100)}`)
    await this.rt.emit("run.card", { runId: run.runId, sessionID: run.originSessionID, kind: "validation", data: { files: run.fix?.filesChanged ?? [], checks: run.tests ? summarizeChecks(run.tests) : "", review: `${verdict.verdict} (round ${run.reviews.length})` } })
    await present(this.ctx, run.originSessionID, `fixora ${run.runId}: fix verified and reviewed (${verdict.verdict})`, renderValidationCard(run))
    return "next"
  }

  /** The PUBLISH turn: ticket, commit, push, MR, links and restore in one prompt after one approval. */
  private async publish(): Promise<"next" | "stop"> {
    const run = this.run
    await stageBegin(this.rt, run, "publish")
    const target = this.opts.mr.target ?? run.base.branch
    const jira = this.rt.services.jira
    const ticketWanted = !run.jiraKey && run.flags.ticket && !run.flags.dryRun && jiraAvailable(jira, this.opts)
    const mr = renderMr(run, { crash: this.crash, draft: this.opts.mr.draft, base: target, jiraPlaceholder: ticketWanted })
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
    const decision = decideApproval("publish", run, this.opts, { serviceAvailable: !!run.base.remoteUrl })
    const wantPush = decision.decision !== "skip" && !run.pipeline.pushed
    const wantMr = decision.decision !== "skip" && run.flags.mr && !!this.remote && !run.mrUrl
    const order = this.remote ? mrProviderOrder(this.rt.services, this.remote, { forge: this.opts.mr.forge }) : []
    const provider: MrProvider = order[0] ?? "url"
    const mrTarget = this.remote ? { remote: this.remote, base: target, branch: run.branch! } : undefined
    const preview = renderApprovalPreview(run, { kind: "publish", branch: run.branch, remote: this.remote?.web ?? run.base.remoteUrl ?? undefined, target, mr: wantMr ? { ...mr, provider } : undefined, crashUrl: this.crashUrl(), ticket: ticketWanted ? { project: this.opts.jira.project, issueType: this.opts.jira.issueType, parent: this.opts.jira.parent } : undefined })
    await writeFile(join(run.folder, "publish-preview.md"), `${preview}\n`)
    if (decision.decision === "skip") {
      run.approvals.publish = "skipped"
      this.notes.push(`Push skipped (${decision.reason}). The fix is committed on \`${run.branch}\`.`)
    } else if (decision.decision === "ask") {
      const resources = [
        ...(ticketWanted ? [`create Jira ${this.opts.jira.issueType} in ${this.opts.jira.project}${this.opts.jira.parent ? ` under ${this.opts.jira.parent}` : ""}`] : []),
        `push branch ${run.branch} to ${run.base.remote} (${this.remote?.web ?? run.base.remoteUrl})`,
        `${files.length} file(s)${run.change ? `, +${run.change.added} −${run.change.deleted}` : ""}`,
        run.tests ? `checks: ${summarizeChecks(run.tests)}` : "checks: none",
        `review: ${run.reviews[run.reviews.length - 1]?.verdict ?? "none"} · confidence ${Math.round((run.triage?.confidence ?? 0) * 100)}%`,
        ...(wantMr ? [`open ${this.opts.mr.draft ? "draft " : ""}MR via ${provider} → ${target}: ${mr.title}`] : []),
      ]
      await approve(this.rt, run, "publish", {
        resources,
        summary: `${ticketWanted ? "create the Jira ticket, " : ""}push ${run.branch}${wantMr ? ` and open a ${this.opts.mr.draft ? "draft " : ""}MR` : ""}`,
        previewPath: join(run.folder, "publish-preview.md"),
        preview: this.gatePreview({ mrTitle: wantMr ? mr.title : undefined, mrBody: wantMr ? mr.body : undefined, target, provider, ticket: ticketWanted }),
      })
    } else {
      run.approvals.publish = "auto"
      await notify(this.ctx, run.originSessionID, `fixora ${run.runId}: auto-approved (${decision.reason})`)
    }
    if (ticketWanted) run.approvals.ticket = run.approvals.publish ?? "approved"
    // Everything the turn may do, with the matching grants.
    const grants: WorkerGrants = { commit: !run.pipeline.committed, push: wantPush, mr: wantMr, jiraWrite: ticketWanted || (!!run.jiraKey && connected(jira) && !!jira.capabilities.addComment), sourceWrite: this.opts.sourceWriteBack && run.source !== "manual" }
    const ticket = ticketWanted ? await this.ticketPlan() : undefined
    const closeLoop: OpStep[] = []
    if ((ticketWanted || run.jiraKey) && connected(jira) && jira.capabilities.addComment && (wantMr || run.mrUrl || this.o.feedback)) {
      const key = run.jiraKey ?? "<key>"
      closeLoop.push({ call: { toolId: jira.capabilities.addComment, namespace: jira.namespace, input: jiraCommentInput(key, renderJiraComment(this.o.feedback ? "feedback" : "mr", run, { mrUrl: run.mrUrl ?? "<mrUrl>", message: this.o.feedback })) } })
      if (this.opts.jira.transitionOnMr && !this.o.feedback && jira.capabilities.getTransitions && jira.capabilities.transition) {
        closeLoop.push({ call: { toolId: jira.capabilities.getTransitions, namespace: jira.namespace, input: jiraTransitionsInput(key) }, note: `then pick the transition whose name matches "${this.opts.jira.transitionOnMr}" (case and punctuation insensitive) and apply it with \`${jira.capabilities.transition}\` { issue_key: "${key}", transition_id: "<id>" }; skip when no transition matches and say so in results.transition` })
      }
    }
    if (grants.sourceWrite) {
      const call = sourceById(run.source).annotatePlan?.(sourceContext(this.rt), run.crashId, { text: `Fixora opened <mrUrl>${ticketWanted || run.jiraKey ? " (Jira <key>)" : ""}. Root cause: ${run.triage?.rootCause.slice(0, 300) ?? ""}`, mrUrl: run.mrUrl, jiraKey: run.jiraKey }, this.extra)
      if (call) closeLoop.push({ call })
    }
    // An MR from an earlier round (feedback) gets its body refreshed instead of a new one.
    const update = run.mrUrl && run.mrProvider && run.mrProvider !== "url" && mrTarget && this.o.feedback ? renderMrOp({ provider: run.mrProvider as MrProvider, op: "update", target: mrTarget, id: run.mrId, url: run.mrUrl, title: mr.title, bodyFile: mrBodyFile, services: this.rt.services, toolProps: (id) => toolProps(this.rt, id) }) : undefined
    if (update) {
      grants.mr = true
      closeLoop.unshift(update.toolId ? { call: { toolId: update.toolId, namespace: update.namespace, input: update.input ?? {} }, note: `update the existing merge request ${run.mrUrl} with the new body (send the contents of ${mrBodyFile} as the description/body)` } : { command: update.command, note: `update the existing merge request ${run.mrUrl}` })
    }
    const plan: PublishPlan = {
      ticket,
      commit: !run.pipeline.committed,
      push: wantPush,
      mr: wantMr,
      files,
      commitMessageFile,
      mrBodyFile,
      signoff: this.opts.signoff,
      remote: run.base.remote,
      branch: run.branch!,
      target,
      attempts: wantMr && mrTarget ? renderMrAttempts({ order, target: mrTarget, mr: { ...mr, draft: this.opts.mr.draft, labels: this.opts.mr.labels, reviewers: this.opts.mr.reviewers }, services: this.rt.services, toolProps: (id) => toolProps(this.rt, id), bodyFile: mrBodyFile }) : [],
      labels: this.opts.mr.labels,
      labelSteps: wantMr && mrTarget ? renderLabelSteps({ order, target: mrTarget, labels: this.opts.mr.labels, services: this.rt.services, toolProps: (id) => toolProps(this.rt, id) }) : [],
      closeLoop,
      restore: restorePlan(run),
      committedSha: run.commitShas[run.commitShas.length - 1],
      pushedAlready: run.pipeline.pushed,
    }
    const sessionID = await ensureWorker(this.rt, run, "fixer", { phase: "publish", grants })
    const token = await this.expect("publish")
    const budget = this.opts.worker.maxPhaseMinutes.publish + this.opts.worker.maxPhaseMinutes.restore
    const r = await awaitSubmission(this.rt, run, sessionID, publishPrompt(run, plan), {
      minutes: budget,
      signal: this.o.signal,
      label: `the agent is publishing (${[ticketWanted && "ticket", grants.commit && "commit", wantPush && "push", wantMr && "MR", closeLoop.length && "links", "restore"].filter(Boolean).join(" + ")})`,
      pick: (fresh) => (fresh.meta?.received === token ? fresh : undefined),
      nudge: nudgePrompt("fixora_submit_publish (then the links and restore steps)", run.runId, [SKILLS.publish], "what succeeded so far (committed / pushed / mr) and the errors"),
    })
    if (!r.value) this.stopFor(r.outcome, "the publish turn", budget, "publish")
    this.adopt(r.value)
    if (ticketWanted) {
      if (run.jiraKey) await this.rt.emit("run.card", { runId: run.runId, sessionID: run.originSessionID, kind: "ticket", data: { jiraKey: run.jiraKey, jiraUrl: run.jiraUrl } })
      else this.notes.push(`No Jira ticket was created: ${run.meta?.ticketError ?? "the agent did not report one"}.`)
    }
    if (grants.commit && !run.pipeline.committed) throw new FixoraStop(`The fix was not committed: ${run.meta?.publishErrors ?? "no commit reported"}. \`/fixora retry ${run.runId} --from publish\`.`)
    if (decision.decision === "skip") {
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
    await stageEnd(this.rt, run, "publish", "ok", `${run.commitShas[run.commitShas.length - 1]?.slice(0, 10) ?? ""} → ${run.base.remote}/${run.branch}${run.mrUrl ? ` · ${run.mrUrl}` : ""}${run.jiraKey ? ` · ${run.jiraKey}` : ""}`)
    if (closeLoop.length) {
      let r2: { ok?: boolean; errors?: string[] } = {}
      try {
        r2 = JSON.parse(String(run.meta?.closeLoopResult ?? "{}")) as { ok?: boolean; errors?: string[] }
      } catch {
        // no report
      }
      run.pipeline.loopClosed = true
      await stageBegin(this.rt, run, "close-loop")
      await stageEnd(this.rt, run, "close-loop", r2.ok === false ? "failed" : "ok", r2.ok === false ? `partly: ${(r2.errors ?? []).join("; ")}` : run.jiraKey ? `Jira ${run.jiraKey} updated` : "linked")
    }
    return "next"
  }

  /** The exact Jira calls for this crash's ticket (search for a duplicate, then create); writes ticket-preview.md. */
  private async ticketPlan(): Promise<TicketPlan> {
    const run = this.run
    const jira = this.rt.services.jira!
    if (!this.crash) throw new Error(`cannot plan the Jira ticket before the crash was fetched (run ${run.runId})`)
    const issue = renderJiraIssue(run, this.crash)
    await writeFile(join(run.folder, "ticket-preview.md"), `${issue.description}\n`)
    const createTool = jira.capabilities.createIssue!
    return {
      namespace: jira.namespace,
      searchTool: jira.capabilities.search!,
      searchInput: jiraSearchInput(dedupeJql(this.opts.jira.project, run.fingerprint), 5),
      createTool,
      createInput: jiraCreateInput({ project: this.opts.jira.project!, issueType: this.opts.jira.issueType, summary: issue.summary, description: issue.description, labels: [...new Set([...this.opts.jira.labels, "fixora"])], parent: this.opts.jira.parent }, { additionalFieldsType: schemaParamType({ properties: toolProps(this.rt, createTool) }, "additional_fields") }),
      commentTool: jira.capabilities.addComment,
      reopenComment: run.reopened && jira.capabilities.addComment ? jiraCommentInput("<key>", renderJiraComment("reopened", run, { reason: run.reopened.reason })) : undefined,
      browseBase: jiraBaseUrl(jira),
    }
  }

  /**
   * The branch name for the work turn. With `branchNaming.template` the plugin renders the exact
   * name; a `{ticket}` placeholder means the Jira ticket is created first (after the ticket
   * approval, unless auto), so the branch carries its key. Without a template the agent infers a
   * name from the repository and the default name is the fallback.
   */
  private async planBranch(preparing: boolean): Promise<{ branch: string; exact: boolean; ticket?: TicketPlan; ticketFallback?: string }> {
    const run = this.run
    const template = this.opts.branchNaming.template
    if (run.branch) return { branch: run.branch, exact: false }
    if (!template || !preparing) return { branch: branchName(this.opts.branchPrefix, run.runId, run.title, run.counters.restarts), exact: false }
    const ticketFallback = slug(run.crashId, 12)
    const ticket = template.includes("{ticket}") && !run.jiraKey ? await this.ticketBeforeBranch() : undefined
    const key = run.jiraKey ?? (ticket ? "<key>" : ticketFallback)
    const branch = branchFromTemplate(this.opts.branchPrefix, template, { type: this.opts.branchNaming.type, ticket: key, slug: slug(run.title, 32), runId: run.runId, crashId: run.crashId }, run.counters.restarts)
    run.meta = { ...run.meta, plannedBranch: branch, ticketFallback }
    await saveRun(this.ctx, run)
    return { branch, exact: true, ticket, ticketFallback }
  }

  /** `branchNaming.template` has `{ticket}` and a ticket can still be created for this run. */
  private ticketBeforeBranchWanted(): boolean {
    const run = this.run
    const template = this.opts.branchNaming.template
    if (!template?.includes("{ticket}") || run.jiraKey || run.branch) return false
    return decideApproval("ticket", run, this.opts, { serviceAvailable: jiraAvailable(this.rt.services.jira, this.opts) }).decision !== "skip"
  }

  /** The ticket approval for a branch name that needs the key; declined → no ticket this run, the crash id is used instead. */
  private async ticketBeforeBranch(): Promise<TicketPlan | undefined> {
    const run = this.run
    const jira = this.rt.services.jira
    const available = jiraAvailable(jira, this.opts)
    const decision = decideApproval("ticket", run, this.opts, { serviceAvailable: available })
    if (decision.decision === "skip") {
      if (run.flags.ticket && !run.flags.dryRun) this.notes.push(`Branch named with the crash id: ${decision.reason}.`)
      return undefined
    }
    if (!this.crash) {
      this.notes.push("Branch named with the crash id: the crash was not fetched before the branch was needed.")
      return undefined
    }
    const plan = await this.ticketPlan()
    if (decision.decision === "ask") {
      try {
        await approve(this.rt, run, "ticket", {
          resources: [`create Jira ${this.opts.jira.issueType} in ${this.opts.jira.project}: ${run.title}`, `name the branch ${this.opts.branchPrefix}${this.opts.branchNaming.template} with its key`],
          summary: `create the Jira ticket first (the branch name needs its key)`,
          previewPath: join(run.folder, "ticket-preview.md"),
          preview: { jira: { project: this.opts.jira.project, issueType: this.opts.jira.issueType, summary: run.title }, previewPath: join(run.folder, "ticket-preview.md") },
        })
      } catch (error) {
        if (!(error instanceof ApprovalRejected)) throw error
        run.flags = { ...run.flags, ticket: false }
        run.approvals.ticket = "rejected"
        run.status = "running"
        this.notes.push("Jira ticket declined; the branch is named with the crash id.")
        return undefined
      }
    } else run.approvals.ticket = "auto"
    run.status = "running"
    return plan
  }

  /** `jira.ticketOnSkip`: a ticket for a crash the analysis classified as not fixable. */
  private async ticketOnSkip() {
    const run = this.run
    const jira = this.rt.services.jira
    if (!jiraAvailable(jira, this.opts) || run.jiraKey) return
    const ticket = await this.ticketPlan()
    const issue = { summary: `[Crash] ${run.title}` }
    const decision = decideApproval("ticket", run, this.opts, { serviceAvailable: true })
    if (decision.decision === "ask") await approve(this.rt, run, "ticket", { resources: [`create Jira ${this.opts.jira.issueType} in ${this.opts.jira.project}: ${issue.summary}`], summary: `create a Jira ${this.opts.jira.issueType} for the skipped crash`, previewPath: join(run.folder, "ticket-preview.md"), preview: { jira: { project: this.opts.jira.project, issueType: this.opts.jira.issueType, summary: issue.summary }, previewPath: join(run.folder, "ticket-preview.md") } })
    await this.runOp({ phase: "ticket", grants: { jiraWrite: true }, op: "jira-comment", title: "create the Jira ticket for this crash (the analysis found nothing to fix here)", steps: [{ call: { toolId: ticket.searchTool, namespace: ticket.namespace, input: ticket.searchInput }, note: "reuse a hit (fixora_submit_ticket action reused), else create it with the next call" }, { call: { toolId: ticket.createTool, namespace: ticket.namespace, input: ticket.createInput }, note: 'then fixora_submit_ticket with action "created", key and url, and finally fixora_submit_ops' }], report: "{ key }", minutes: this.opts.worker.maxPhaseMinutes.crash, fatal: false })
  }

  /** Runs in `finally` for every path that did not restore inside the publish turn. */
  private async restore() {
    const run = this.run
    if (!run.checkout?.active) {
      // The publish turn restores as its last step (fixora_submit_ops restore): close the row for it.
      const at = run.checkout?.restoredAt
      const t = run.timings.restore
      if (at && (!t?.endedAt || t.endedAt < at)) await stageMark(this.rt, run, "restore", "ok", `${run.checkout.previousBranch ?? "previous branch"}${run.checkout.stashRef ? " · stash popped" : ""}`)
      return
    }
    const outcome = { status: run.status, error: run.error, step: run.step }
    // A run that stopped with its fix uncommitted (fix / validate / review) keeps the fix branch checked
    // out: `git checkout <previous>` would carry the half-done change onto the user's branch, where the
    // next retry could not tell it from their own work.
    const keepFix = fixInProgress(run)
    await stageBegin(this.rt, run, "restore")
    run.status = outcome.status
    const title = keepFix
      ? `restore the checkout to \`${run.checkout.previousBranch ?? run.checkout.previousHeadSha ?? "the previous branch"}\`${run.checkout.stashRef ? " and pop the stash" : ""}, unless the fix of this run is still uncommitted on \`${run.branch}\` (then keep that branch checked out)`
      : `restore the checkout to \`${run.checkout.previousBranch ?? run.checkout.previousHeadSha ?? "the previous branch"}\`${run.checkout.stashRef ? " and pop the stash" : ""}`
    const result = await this.runOp({ phase: "restore", op: "restore", title, steps: restoreSteps(run, { keepFix }), report: keepFix ? `{ branch: "<branch now checked out>", stashPopped: true/false, kept: true/false }` : `{ branch: "<branch now checked out>", stashPopped: true/false }`, minutes: this.opts.worker.maxPhaseMinutes.restore, fatal: false, signal: undefined }).catch(() => undefined)
    run.status = outcome.status
    run.error = outcome.error
    if (result?.ok && !run.checkout.active) {
      await stageEnd(this.rt, run, "restore", "ok", `${run.checkout.previousBranch ?? "previous branch"}${run.checkout.stashRef ? " · stash popped" : ""}`)
      run.step = outcome.step
      return
    }
    if (result?.ok && run.checkout.active && run.meta?.restoreKept === true) {
      await stageEnd(this.rt, run, "restore", "ok", `kept on ${run.branch} (uncommitted fix)`)
      run.step = outcome.step
      this.notes.push(`The fix stays uncommitted on \`${run.branch}\`, which is still checked out${run.checkout.stashRef ? ` (your own changes stay in stash \`${run.checkout.stashRef.slice(0, 10)}\`)` : ""}. \`/fixora retry ${run.runId} --from fix\` continues there; \`/fixora clean ${run.runId}\` puts your branch back instead.`)
      return
    }
    const why = result?.errors.join("; ") || "the worker did not report back"
    await stageEnd(this.rt, run, "restore", "failed", why)
    run.step = outcome.step
    run.error = outcome.error
    this.notes.push(`⚠ The agent could not restore your checkout (${why}); it is still on \`${run.branch}\`${run.checkout.stashRef ? " and your changes are stashed" : ""}. The commands to run by hand are below.`)
  }

  /** One ops prompt in the fixer session (restore on failure paths, ticket on skip). Never throws when `fatal` is false. */
  private async runOp(o: { phase: "restore" | "ticket" | "clean"; grants?: WorkerGrants; op: string; title: string; steps: OpStep[]; report: string; minutes: number; fatal: boolean; signal?: AbortSignal | undefined }): Promise<{ ok: boolean; errors: string[]; results: Record<string, unknown> } | undefined> {
    const run = this.run
    const sessionID = await ensureWorker(this.rt, run, "fixer", { phase: o.phase, grants: o.grants })
    const token = await this.expect(o.op)
    const prompt = opsPrompt({ runId: run.runId, op: o.op, title: o.title, steps: o.steps, report: o.report, repo: run.repo })
    const r = await awaitSubmission(this.rt, run, sessionID, prompt, {
      minutes: o.minutes,
      signal: "signal" in o ? o.signal : this.o.signal,
      label: o.title,
      pick: (fresh) => (fresh.meta?.received === token ? fresh : undefined),
      nudge: nudgePrompt("fixora_submit_ops", run.runId, [SKILLS.ops], `op "${o.op}", ok true/false, results, errors`),
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

  /** A done run closes every row the panel shows: the steps it never needed are recorded as skipped. */
  private async settle() {
    const run = this.run
    for (const step of STEPS) {
      if (step === "done" || run.timings[step]) continue
      if (step === "ticket" && run.jiraKey) {
        await stageMark(this.rt, run, step, "ok", `Jira ${run.jiraKey}`)
        continue
      }
      const detail = step === "ticket" ? (run.approvals.ticket === "rejected" ? "declined" : "no ticket this run") : step === "close-loop" ? "nothing to link" : step === "restore" ? "no checkout to restore" : "not needed"
      await stageMark(this.rt, run, step, "skipped", detail)
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
  private gatePreview(o: { mrTitle?: string; mrBody?: string; target: string; provider: string; ticket: boolean }) {
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
      jira: o.ticket ? { project: this.opts.jira.project, issueType: this.opts.jira.issueType } : undefined,
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
  return `The prepare stage was blocked${detail}. \`/fixora retry ${run.runId}\` after fixing the cause.`
}
