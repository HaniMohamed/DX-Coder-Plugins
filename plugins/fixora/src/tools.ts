// Plugin-registered tools: the structured submissions the worker sessions end their phases with
// (validated on receipt and persisted) and `fixora_start` for the interactive picker in the origin
// session. The tools are the only channel from the agent back to the plugin.

import type { Plugin } from "@opencode/plugin"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { markPrepared, markRestored } from "./checkout.js"
import { validateFix, validateOps, validatePrepare, validatePublish, validateReview, validateTicket, validateTriage } from "./contracts.js"
import { describeError } from "./errors.js"
import { forbiddenReason } from "./permissions.js"
import { sourceContext, type Runtime } from "./progress.js"
import { renderCrashMarkdown, renderProject } from "./render.js"
import { interpretCrashList, sourceById } from "./sources/index.js"
import type { ListResult } from "./sources/types.js"
import { getJson, keys, loadRun, loadWorker, now, saveRun, setJson } from "./state.js"
import { applyOverrides, hasTestRunner, isTestFile, normalizeChecks, normalizeEcosystems, requiredChecks } from "./toolchain.js"
import type { Crash, FixReport, ReviewVerdict, Source, Triage, Validation, WorkerInfo, WorkerPhase } from "./types.js"
import { reportFromCommands, summaryFromSubmission } from "./validate.js"
import { FORBIDDEN_GLOBS } from "./permissions.js"

export interface ToolDeps {
  rt: () => Runtime
  /** Starts runs from the origin session (interactive picker). Returns the run ids. */
  start: (input: { sessionID: string; refs: string[]; flags?: Record<string, unknown> }) => Promise<{ started: string[]; errors: string[] }>
  isWorkerSession: (sessionID: string) => Promise<boolean>
}

/** Stored under `fixora/crashes/<requestId>`: the plan the lister works from and, later, its result. */
export interface CrashListRecord {
  requestId: string
  originSessionID: string
  createdAt: string
  query: { top: number; minUsers?: number; source?: Source }
  plans: Array<{ source: Source; calls: Array<{ toolId: string; input: Record<string, unknown>; appId?: string; label?: string }> }>
  planErrors: string[]
  result?: { crashes: import("./types.js").CrashSummary[]; errors: string[]; raw?: unknown; at: string }
}

const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: true })
const S = { type: "string" }
const N = { type: "number" }
const B = { type: "boolean" }
const ANY = {}
const A = (items: unknown) => ({ type: "array", items })

const TRIAGE_SCHEMA = schema(
  {
    version: { type: "number", const: 1 },
    runId: S,
    classification: { type: "string", enum: ["fixable", "needs_symbolication", "third_party_only", "not_in_repo", "env_or_data", "needs_human", "duplicate_of"] },
    mappedFrames: A(schema({ index: N, file: S, line: N, function: S, evidence: S }, ["index", "file", "evidence"])),
    rootCause: S,
    category: { type: "string", enum: ["null-deref", "race", "state", "api-contract", "parsing", "config", "ui-lifecycle", "resource", "other"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    confidenceReasons: A(S),
    suspectCommits: A(schema({ sha: S, subject: S, date: S, why: S }, ["sha", "subject", "why"])),
    introducedInRelease: { type: ["string", "null"] },
    fixStrategy: S,
    alternatives: A(schema({ strategy: S, rejectedBecause: S }, ["strategy", "rejectedBecause"])),
    risk: schema({ level: { type: "string", enum: ["low", "medium", "high"] }, notes: A(S) }, ["level", "notes"]),
    suggestedTests: A(S),
    relatedCrashes: A(S),
    reopenReason: { type: "string", enum: ["incomplete-fix", "new-code-path", "regression", "fix-not-shipped"] },
    flaggedContent: A(S),
  },
  ["version", "runId", "classification", "mappedFrames", "rootCause", "category", "confidence", "confidenceReasons", "suspectCommits", "introducedInRelease", "fixStrategy", "alternatives", "risk", "suggestedTests", "relatedCrashes", "flaggedContent"],
)

const FIX_SCHEMA = schema(
  {
    version: { type: "number", const: 1 },
    runId: S,
    attempt: N,
    summary: S,
    filesChanged: A(S),
    rationale: S,
    alternativesRejected: A(schema({ strategy: S, reason: S }, ["strategy", "reason"])),
    testsAdded: A(schema({ file: S, name: S, kind: { type: "string", enum: ["regression", "unit", "integration"] } }, ["file", "name", "kind"])),
    commandsRun: A(schema({ command: S, exitCode: N, durationMs: N, summary: S, kind: { type: "string", enum: ["setup", "syntax", "lint", "typecheck", "unit", "integration", "build"] }, cwd: S, outputTail: S }, ["command", "exitCode", "durationMs", "summary"])),
    reproduction: schema({ mode: { type: "string", enum: ["test-first", "fix"] }, failingBefore: B, passingAfter: B }, ["mode"]),
    risk: schema({ level: { type: "string", enum: ["low", "medium", "high"] }, publicApiChange: B, behaviourChange: S, rollback: S }, ["level", "publicApiChange", "behaviourChange", "rollback"]),
    notesForReviewer: S,
    changesMade: B,
    unresolved: A(S),
    status: { description: "Verbatim output of `git status --porcelain=v1 --untracked-files=all` after `git add -N .`", type: "string" },
    diff: { description: "Verbatim output of `git diff HEAD`", type: "string" },
  },
  ["version", "runId", "attempt", "summary", "filesChanged", "rationale", "alternativesRejected", "testsAdded", "commandsRun", "risk", "changesMade", "unresolved"],
)

const REVIEW_SCHEMA = schema(
  {
    version: { type: "number", const: 1 },
    runId: S,
    attempt: N,
    verdict: { type: "string", enum: ["approve", "approve_with_nits", "reject"] },
    rootCauseAddressed: B,
    regressionTestPresent: B,
    findings: A(schema({ category: { type: "string", enum: ["correctness", "scope", "risk", "tests", "style", "security"] }, severity: { type: "string", enum: ["blocker", "major", "minor"] }, file: S, line: N, message: S, suggestion: S }, ["category", "severity", "file", "message"])),
    summary: S,
  },
  ["version", "runId", "attempt", "verdict", "rootCauseAddressed", "regressionTestPresent", "findings", "summary"],
)

const CRASHES_SCHEMA = schema({ version: { type: "number", const: 1 }, requestId: S, results: A(schema({ source: { type: "string", enum: ["sentry", "crashlytics"] }, appId: S, toolId: S, raw: ANY, error: S }, ["source", "toolId"])) }, ["version", "requestId", "results"])

const CRASH_SCHEMA = schema({ version: { type: "number", const: 1 }, runId: S, source: { type: "string", enum: ["sentry", "crashlytics"] }, appId: S, issue: { description: "the primary reply, verbatim (object or text)" }, events: { description: "the follow-up reply, verbatim, when one was made" }, extraCalls: A(schema({ toolId: S, raw: ANY }, ["toolId"])), error: S }, ["version", "runId", "source"])

const PREPARE_SCHEMA = schema(
  {
    version: { type: "number", const: 1 },
    runId: S,
    stage: { type: "string", enum: ["inspect", "ready"] },
    repoRoot: S,
    previousBranch: S,
    previousHeadSha: S,
    dirty: B,
    status: S,
    dirtyFiles: N,
    stashRef: { type: ["string", "null"] },
    blocked: { type: "string", enum: ["not-a-repo", "base-missing"] },
    blockedDetail: S,
    baseRef: S,
    baseSha: S,
    remoteUrl: { type: ["string", "null"] },
    branch: S,
    created: B,
    toolchain: schema({ ecosystems: A(schema({ id: S, root: S }, ["id"])), checks: A(schema({ kind: S, command: S, cwd: S, optional: B }, ["kind", "command"])), setup: A(schema({ command: S, exitCode: N, summary: S }, ["command", "exitCode"])) }, ["ecosystems", "checks"]),
    conventionFiles: A(S),
    notes: A(S),
  },
  ["version", "runId", "stage"],
)

const TICKET_SCHEMA = schema({ version: { type: "number", const: 1 }, runId: S, action: { type: "string", enum: ["created", "reused", "failed"] }, key: S, url: S, error: S, raw: ANY }, ["version", "runId", "action"])

const PUBLISH_SCHEMA = schema(
  {
    version: { type: "number", const: 1 },
    runId: S,
    committed: schema({ sha: S, files: A(S) }, ["sha"]),
    pushed: schema({ remote: S, branch: S, remoteSha: S }, ["remote", "branch"]),
    mr: schema({ url: S, id: S, provider: { type: "string", enum: ["gitlab-mcp", "github-mcp", "glab", "gh"] }, status: { type: "string", enum: ["draft", "open"] }, raw: ANY }, ["url", "provider"]),
    mrSkipped: schema({ reason: S, compareUrl: S }, ["reason"]),
    errors: A(S),
  },
  ["version", "runId", "errors"],
)

const OPS_SCHEMA = schema({ version: { type: "number", const: 1 }, runId: S, op: { type: "string", enum: ["close-loop", "restore", "sync", "close-mr", "jira-comment", "clean", "annotate"] }, ok: B, results: ANY, errors: A(S) }, ["version", "op", "ok", "errors"])

const START_SCHEMA = schema({ refs: A(S), flags: schema({ dryRun: B, ticket: B, mr: B, push: B, auto: B, force: B, testFirst: B }, []) }, ["refs"])

function failure(errors: string[], what: string) {
  const text = `${what} was NOT accepted. Fix these problems and call the tool again:\n- ${errors.join("\n- ")}`
  return { output: { ok: false, errors }, content: text }
}

const ok = (content: string, extra: Record<string, unknown> = {}) => ({ output: { ok: true, ...extra }, content })

export async function registerPluginTools(ctx: Plugin.Context, deps: ToolDeps): Promise<void> {
  const worker = async (sessionID: string, role: WorkerInfo["role"], phases?: WorkerPhase[]): Promise<{ info: WorkerInfo } | { error: string }> => {
    const info = await loadWorker(ctx, sessionID)
    if (!info) return { error: "this tool can only be called from a Fixora worker session" }
    if (info.role !== role) return { error: `this tool is for the ${role} session, not the ${info.role}` }
    if (phases && !phases.includes(info.phase)) return { error: `this tool belongs to the ${phases.join(" / ")} phase; the session is in the ${info.phase} phase` }
    return { info }
  }
  const persist = async (folder: string, file: string, value: unknown) => {
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, file), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`)
  }
  /** Marks the submission the pipeline is waiting for (see `Pipeline.expect`). */
  const received = (run: { meta?: Record<string, unknown> }) => {
    run.meta = { ...run.meta, received: typeof run.meta?.expect === "string" ? run.meta.expect : null }
  }

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "submit_crashes",
      description: "Fixora lister: submit the raw replies of the crash-source calls you were asked to make (one entry per call, the reply value passed through unchanged). Call it from the same execute script that made the calls, passing the reply variables. Then stop.",
      input: CRASHES_SCHEMA,
      options: { namespace: "fixora", codemode: true },
      async execute(input, c) {
        const w = await worker(c.sessionID, "lister")
        if ("error" in w) return failure([w.error], "crash list")
        const raw = input as { requestId?: string; results?: unknown }
        const requestId = typeof raw.requestId === "string" ? raw.requestId : w.info.requestId
        if (!requestId || requestId !== w.info.requestId) return failure([`requestId must be "${w.info.requestId}"`], "crash list")
        const record = await getJson<CrashListRecord>(ctx, keys.crashes(requestId))
        if (!record) return failure([`unknown request ${requestId}`], "crash list")
        if (!Array.isArray(raw.results)) return failure(["results must be an array"], "crash list")
        const results: Array<ListResult & { source: Source }> = []
        for (const r of raw.results as Array<Record<string, unknown>>) {
          if (!r || typeof r !== "object" || typeof r.toolId !== "string" || (r.source !== "sentry" && r.source !== "crashlytics")) continue
          results.push({ source: r.source, toolId: r.toolId, appId: typeof r.appId === "string" ? r.appId : undefined, raw: r.raw, error: typeof r.error === "string" ? r.error : undefined })
        }
        const planned = record.plans.reduce((n, p) => n + p.calls.length, 0)
        const { crashes, errors } = interpretCrashList(results, sourceContext(deps.rt()), record.query)
        if (results.length < planned) errors.push(`${planned - results.length} planned call(s) were not reported`)
        record.result = { crashes, errors: [...record.planErrors, ...errors], raw: results.map((r) => ({ source: r.source, toolId: r.toolId, appId: r.appId, raw: r.raw, error: r.error })), at: now() }
        await setJson(ctx, keys.crashes(requestId), record)
        return ok(`Crash list recorded: ${crashes.length} crash(es)${errors.length ? `, ${errors.length} error(s)` : ""}. Stop here.`, { count: crashes.length })
      },
    })

    editor.add({
      name: "submit_crash",
      description: "Fixora worker (crash phase): submit the raw replies of the crash fetch (issue, and the sample event when one was fetched), passed through unchanged from the same execute script that made the calls. Validated on receipt; errors tell you which follow-up call to make.",
      input: CRASH_SCHEMA,
      options: { namespace: "fixora", codemode: true },
      async execute(input, c) {
        const w = await worker(c.sessionID, "fixer", ["crash"])
        if ("error" in w) return failure([w.error], "crash")
        const run = await loadRun(ctx, w.info.runId!)
        if (!run) return failure([`run ${w.info.runId} not found`], "crash")
        const raw = input as { source?: string; appId?: string; issue?: unknown; events?: unknown; extraCalls?: unknown; error?: string }
        if (raw.source !== run.source) return failure([`source must be "${run.source}"`], "crash")
        if (raw.error && raw.issue === undefined) return failure([`the crash could not be fetched: ${raw.error}. Check the tool id / input in the prompt and try again; if the server keeps failing, report it in your final message and stop.`], "crash")
        const rt = deps.rt()
        const sc = sourceContext(rt)
        const source = sourceById(run.source)
        const extra = (run.meta?.refExtra ? JSON.parse(String(run.meta.refExtra)) : undefined) as Record<string, string> | undefined
        let crash: Crash
        try {
          crash = source.mapCrash!({ appId: raw.appId, issue: raw.issue, events: raw.events, extraCalls: Array.isArray(raw.extraCalls) ? (raw.extraCalls as never) : undefined }, sc, run.crashId, extra)
        } catch (error) {
          return failure([describeError(error)], "crash")
        }
        if (crash.frames.length === 0 && raw.events === undefined) {
          const plan = source.fetchPlan!(sc, run.crashId, extra)
          if (plan.followUps.length) return failure([`no stack frames could be read from the issue reply. Make a follow-up call (${plan.followUps.map((f) => `\`${f.toolId}\``).join(" or ")}) as the prompt describes and resubmit with its reply as \`events\``], "crash")
        }
        await mkdir(run.folder, { recursive: true })
        await persist(run.folder, "crash.json", crash)
        await persist(run.folder, "crash.md", `${renderCrashMarkdown(crash, { reopened: run.reopened ? { ...run.reopened } : undefined })}\n`)
        run.title = crash.title
        run.fingerprint = crash.fingerprint
        run.meta = { ...run.meta, crashUrl: crash.url ?? null, platform: crash.platform ?? null, appVersion: crash.appVersion ?? null, language: crash.language, symbolication: crash.symbolication, userCount: crash.userCount ?? null, eventCount: crash.eventCount ?? null, crashFetchedAt: now() }
        if (crash.appId && extra?.appId !== crash.appId) run.meta.refExtra = JSON.stringify({ ...extra, appId: crash.appId })
        received(run)
        await saveRun(ctx, run)
        return ok(`Crash recorded: ${crash.exceptionType ?? crash.title}, ${crash.frames.length} frame(s), ${crash.language}. Stop here.`)
      },
    })

    editor.add({
      name: "submit_prepare",
      description: "Fixora worker (prepare phase): report the checkout (stage inspect when it is dirty, so Fixora can ask the user before stashing; stage ready after the fix branch is checked out and the toolchain detected).",
      input: PREPARE_SCHEMA,
      options: { namespace: "fixora", codemode: false },
      async execute(input, c) {
        const w = await worker(c.sessionID, "fixer", ["prepare"])
        if ("error" in w) return failure([w.error], "prepare report")
        const run = await loadRun(ctx, w.info.runId!)
        if (!run) return failure([`run ${w.info.runId} not found`], "prepare report")
        const rt = deps.rt()
        const result = validatePrepare(input, { runId: run.runId, branchPrefix: rt.opts.branchPrefix, baseBranch: run.base.branch, existingBranch: run.branch })
        if (!result.ok) return failure(result.errors, "prepare report")
        const p = result.value
        if (p.blocked) {
          run.status = "blocked"
          run.blockedReason = p.blocked
          run.error = p.blockedDetail ?? p.blocked
          run.meta = { ...run.meta, prepareStage: "blocked" }
          received(run)
          await saveRun(ctx, run)
          return ok(`Reported: ${p.blocked}. Stop here.`)
        }
        if (p.stage === "inspect") {
          run.checkout = { ...run.checkout, active: false, previousBranch: p.previousBranch, previousHeadSha: p.previousHeadSha }
          run.gitRoot = p.repoRoot || run.gitRoot
          run.meta = { ...run.meta, prepareStage: "inspect", prepareDirty: p.dirty, prepareStatus: (p.status ?? "").slice(0, 20_000), prepareDirtyFiles: p.dirtyFiles ?? (p.status ? p.status.split("\n").filter(Boolean).length : 0) }
          received(run)
          await saveRun(ctx, run)
          return ok(p.dirty ? "Reported a dirty checkout. Stop here: Fixora will ask the user whether to stash, then prompt you again." : "Reported a clean checkout. Continue with fetch, branch, checkout and toolchain detection, then submit stage \"ready\".")
        }
        markPrepared(run, { previousBranch: p.previousBranch, previousHeadSha: p.previousHeadSha, stashRef: p.stashRef ?? null, branch: p.branch!, gitRoot: p.repoRoot, baseSha: p.baseSha, remoteUrl: p.remoteUrl })
        const checks = applyOverrides(normalizeChecks(p.toolchain?.checks), rt.opts.testCommands)
        run.toolchain = { ecosystems: normalizeEcosystems(p.toolchain?.ecosystems), checks, conventionFiles: p.conventionFiles }
        run.meta = { ...run.meta, prepareStage: "ready", prepareSetup: JSON.stringify(p.toolchain?.setup ?? []).slice(0, 4000), prepareNotes: p.notes.join("; ").slice(0, 2000) }
        await mkdir(run.folder, { recursive: true })
        await persist(run.folder, "project.md", `${renderProject({ toolchain: run.toolchain, forbidden: [...FORBIDDEN_GLOBS, ...rt.opts.validate.denyPaths], limits: rt.opts.validate })}\n`)
        await persist(run.folder, "limits.json", { maxFilesChanged: rt.opts.validate.maxFilesChanged, maxDiffLines: rt.opts.validate.maxDiffLines, testTimeoutSec: rt.opts.testCommands.timeoutSec, mode: run.flags.testFirst ? "test-first" : "fix", maxFixRounds: rt.opts.maxFixRounds })
        received(run)
        await saveRun(ctx, run)
        return ok(`Checkout prepared on ${run.branch} (${run.toolchain.ecosystems.map((e) => e.id).join(", ") || "no ecosystem"}; ${checks.length} check(s)). Stop here.`)
      },
    })

    editor.add({
      name: "submit_triage",
      description: "Fixora worker (triage phase): submit the root-cause analysis for the current run. Validated on receipt; errors are returned so you can correct and resubmit.",
      input: TRIAGE_SCHEMA,
      options: { namespace: "fixora", codemode: false },
      async execute(input, c) {
        const w = await worker(c.sessionID, "fixer", ["triage"])
        if ("error" in w) return failure([w.error], "triage")
        const run = await loadRun(ctx, w.info.runId!)
        if (!run) return failure([`run ${w.info.runId} not found`], "triage")
        const root = run.gitRoot ?? run.repo
        const result: Validation<Triage> = validateTriage(input, { runId: run.runId, fileExists: (p) => existsSync(join(root, p)) })
        if (!result.ok) return failure(result.errors, "triage")
        run.triage = result.value
        run.pipeline.analysed = true
        received(run)
        await saveRun(ctx, run)
        await persist(run.folder, "triage.json", result.value)
        return ok(`Triage accepted: ${result.value.classification}, confidence ${Math.round(result.value.confidence * 100)}%. You may stop now unless asked to continue.`)
      },
    })

    editor.add({
      name: "submit_ticket",
      description: "Fixora worker (ticket phase): report the Jira ticket that was created or reused (or why it failed).",
      input: TICKET_SCHEMA,
      options: { namespace: "fixora", codemode: false },
      async execute(input, c) {
        const w = await worker(c.sessionID, "fixer", ["ticket", "close-loop"])
        if ("error" in w) return failure([w.error], "ticket report")
        const run = await loadRun(ctx, w.info.runId!)
        if (!run) return failure([`run ${w.info.runId} not found`], "ticket report")
        const result = validateTicket(input, { runId: run.runId })
        if (!result.ok) return failure(result.errors, "ticket report")
        const t = result.value
        if (t.action === "failed") run.meta = { ...run.meta, ticketError: t.error ?? "unknown error", ticketAction: "failed" }
        else {
          run.jiraKey = t.key
          run.jiraUrl = t.url ?? run.jiraUrl
          run.pipeline.ticketed = true
          run.meta = { ...run.meta, ticketAction: t.action, ticketError: null }
        }
        received(run)
        await saveRun(ctx, run)
        return ok(t.action === "failed" ? "Failure recorded. Stop here." : `Ticket ${t.key} (${t.action}) recorded. Stop here.`)
      },
    })

    editor.add({
      name: "submit_fix",
      description: "Fixora worker (fix phase): submit the fix report after changing code and running the project's checks, with `status` (git status --porcelain=v1 after git add -N .) and `diff` (git diff HEAD) verbatim. Validated against them, forbidden paths and limits; errors are returned so you can correct and resubmit.",
      input: FIX_SCHEMA,
      options: { namespace: "fixora", codemode: false },
      async execute(input, c) {
        const w = await worker(c.sessionID, "fixer", ["fix", "feedback"])
        if ("error" in w) return failure([w.error], "fix report")
        const run = await loadRun(ctx, w.info.runId!)
        if (!run) return failure([`run ${w.info.runId} not found`], "fix report")
        const rt = deps.rt()
        const opts = rt.opts
        const raw = input as { status?: unknown; diff?: unknown; changesMade?: unknown }
        const changesMade = raw.changesMade !== false
        if (changesMade && (typeof raw.status !== "string" || typeof raw.diff !== "string")) return failure(["`status` and `diff` are required: run `git add -N . && git status --porcelain=v1 --untracked-files=all` and `git diff HEAD` and pass both outputs verbatim"], "fix report")
        if (typeof raw.diff === "string" && raw.diff.length > 1_000_000) return failure(["the diff is larger than 1 MB; reduce the change set (did a build output or lockfile slip in?)"], "fix report")
        const summary = summaryFromSubmission({ status: typeof raw.status === "string" ? raw.status : "", diff: typeof raw.diff === "string" ? raw.diff : "" })
        const checks = run.toolchain?.checks ?? []
        const attempt = run.counters.fixRounds + run.counters.reviewRounds + run.counters.feedback + 1
        const result: Validation<FixReport> = validateFix(input, {
          runId: run.runId,
          attempt,
          changedFiles: summary.paths,
          forbidden: (p) => forbiddenReason(p, opts.validate.denyPaths),
          maxFilesChanged: opts.validate.maxFilesChanged,
          hasTestRunner: hasTestRunner(run.toolchain),
          requireTestChange: opts.validate.requireTestChange,
          isTestFile: (p) => isTestFile(p, run.toolchain?.ecosystems ?? []),
          testFirst: run.flags.testFirst,
          requiredChecks: run.meta?.tests === "skip" ? [] : requiredChecks(checks).map((k) => k.command),
        })
        if (!result.ok) return failure(result.errors, "fix report")
        run.fix = result.value
        run.pipeline.fixed = result.value.changesMade
        if (result.value.changesMade) {
          run.change = { paths: summary.paths, added: summary.added, deleted: summary.deleted, diffHash: summary.diffHash }
          run.tests = reportFromCommands(result.value.commandsRun, summary.diffHash, checks)
          await persist(run.folder, `diff.${attempt}.patch`, summary.diff)
          await persist(run.folder, `verification.${attempt}.json`, run.tests)
        }
        received(run)
        await saveRun(ctx, run)
        await persist(run.folder, `fix.${attempt}.json`, result.value)
        return ok(result.value.changesMade ? "Fix report accepted. Fixora will now check the change set and run an independent review. Stop here." : "Report accepted (no changes). Stop here.")
      },
    })

    editor.add({
      name: "submit_review",
      description: "Fixora reviewer: submit the review verdict for the current diff. Any blocker finding makes the verdict a rejection.",
      input: REVIEW_SCHEMA,
      options: { namespace: "fixora", codemode: false },
      async execute(input, c) {
        const w = await worker(c.sessionID, "reviewer")
        if ("error" in w) return failure([w.error], "review")
        const run = await loadRun(ctx, w.info.runId!)
        if (!run) return failure([`run ${w.info.runId} not found`], "review")
        const attempt = run.reviews.length + 1
        const known = [...(run.fix?.filesChanged ?? []), ...(run.triage?.mappedFrames.map((m) => m.file) ?? [])]
        const result: Validation<ReviewVerdict> = validateReview(input, { runId: run.runId, attempt, knownFiles: known })
        if (!result.ok) return failure(result.errors, "review")
        run.reviews.push(result.value)
        received(run)
        await saveRun(ctx, run)
        await persist(run.folder, `review.${attempt}.json`, result.value)
        return ok(`Review recorded: ${result.value.verdict}. Stop here.`)
      },
    })

    editor.add({
      name: "submit_publish",
      description: "Fixora worker (publish phase): report what was committed, pushed and opened as a merge request (partial results are fine; list errors).",
      input: PUBLISH_SCHEMA,
      options: { namespace: "fixora", codemode: false },
      async execute(input, c) {
        const w = await worker(c.sessionID, "fixer", ["publish"])
        if ("error" in w) return failure([w.error], "publish report")
        const run = await loadRun(ctx, w.info.runId!)
        if (!run) return failure([`run ${w.info.runId} not found`], "publish report")
        const result = validatePublish(input, { runId: run.runId, grants: w.info.grants ?? {}, branch: run.branch ?? "", remote: run.base.remote })
        if (!result.ok) return failure(result.errors, "publish report")
        const p = result.value
        if (p.committed) {
          if (!run.commitShas.includes(p.committed.sha)) run.commitShas.push(p.committed.sha)
          run.pipeline.committed = true
        }
        if (p.pushed) run.pipeline.pushed = true
        if (p.mr) {
          run.mrUrl = p.mr.url
          run.mrId = p.mr.id
          run.mrProvider = p.mr.provider
          run.mrStatus = p.mr.status ?? (deps.rt().opts.mr.draft ? "draft" : "open")
          run.pipeline.mrOpened = true
        }
        if (p.mrSkipped) run.meta = { ...run.meta, compareUrl: p.mrSkipped.compareUrl ?? null, mrSkippedReason: p.mrSkipped.reason }
        run.meta = { ...run.meta, publishErrors: p.errors.join("; ").slice(0, 2000) || null }
        received(run)
        await saveRun(ctx, run)
        return ok(`Publish report recorded (${[p.committed && "committed", p.pushed && "pushed", p.mr && "MR opened", p.mrSkipped && "MR skipped"].filter(Boolean).join(", ") || "nothing"}). Stop here.`)
      },
    })

    editor.add({
      name: "submit_ops",
      description: "Fixora worker: report the outcome of an ops prompt (restore, close-loop, sync, close-mr, jira-comment, clean, annotate).",
      input: OPS_SCHEMA,
      options: { namespace: "fixora", codemode: false },
      async execute(input, c) {
        const info = await loadWorker(ctx, c.sessionID)
        if (!info) return failure(["this tool can only be called from a Fixora worker session"], "ops report")
        const result = validateOps(input, { runId: info.runId })
        if (!result.ok) return failure(result.errors, "ops report")
        const o = result.value
        const at = now()
        if (!info.runId) {
          await setJson(ctx, keys.ops(c.sessionID), { ...o, at })
          return ok(`${o.op} recorded. Stop here.`)
        }
        const run = await loadRun(ctx, info.runId)
        if (!run) return failure([`run ${info.runId} not found`], "ops report")
        switch (o.op) {
          case "restore":
            if (o.ok) markRestored(run, at)
            break
          case "close-loop":
            run.pipeline.loopClosed = true
            break
          case "close-mr":
            if (o.ok && run.mrUrl) run.mrStatus = "closed"
            break
          case "sync": {
            const s = typeof o.results.status === "string" ? o.results.status : undefined
            if (s === "draft" || s === "open" || s === "merged" || s === "closed") run.mrStatus = s
            break
          }
          default:
            break
        }
        run.meta = { ...run.meta, opsResult: JSON.stringify({ op: o.op, ok: o.ok, errors: o.errors, results: o.results, at }).slice(0, 4000) }
        received(run)
        await saveRun(ctx, run)
        return ok(`${o.op} recorded (${o.ok ? "ok" : "with errors"}). Stop here.`)
      },
    })

    editor.add({
      name: "start",
      description: "Start Fixora runs for one or more crash references (e.g. \"sentry:12345\", \"crashlytics:abc\", or a crash URL). Use after the user picked crashes from the /fixora list. Not available inside Fixora worker sessions.",
      input: START_SCHEMA,
      options: { namespace: "fixora", codemode: false },
      async execute(input, c) {
        if (await deps.isWorkerSession(c.sessionID)) return failure(["fixora_start cannot be called from a worker session"], "start")
        const raw = input as { refs?: unknown; flags?: Record<string, unknown> }
        const refs = Array.isArray(raw.refs) ? raw.refs.filter((r): r is string => typeof r === "string" && r.trim().length > 0) : []
        if (refs.length === 0) return failure(["refs must contain at least one crash reference"], "start")
        const res = await deps.start({ sessionID: c.sessionID, refs, flags: raw.flags })
        const lines = [...res.started.map((r) => `started ${r}`), ...res.errors]
        return { output: res, content: lines.join("\n") || "nothing started" }
      },
    })
  })
}
