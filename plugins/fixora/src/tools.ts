// Plugin-registered tools: the structured submissions the worker sessions end their stages with
// (validated on receipt and persisted) and `fixora_start` for the interactive picker in the origin
// session. The tools are the only channel from the agent back to the plugin, and their replies steer
// the agent: CONTINUE with the next stage of the turn, or STOP.

import type { Plugin } from "@opencode/plugin"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { markPrepared, markRestored } from "./checkout.js"
import { validateFix, validateOps, validatePrepare, validatePublish, validateRecover, validateReview, validateTicket, validateTriage } from "./contracts.js"
import { duplicateMessage, indexCrash } from "./crashindex.js"
import { describeError } from "./errors.js"
import { parseRemote } from "./git.js"
import type { MrListPlan, MrListProvider, MrListState } from "./mr.js"
import { FORBIDDEN_GLOBS, forbiddenReason, normalizePath } from "./permissions.js"
import { sourceContext, stageBegin, stageEnd, stageMark, type Runtime } from "./progress.js"
import { normalizeMrList, parseTrailers, type MrListing } from "./recover.js"
import { retitleWorker } from "./worker.js"
import { renderCrashMarkdown, renderProject } from "./render.js"
import { interpretCrashList, sourceById } from "./sources/index.js"
import type { ListResult } from "./sources/types.js"
import { getJson, keys, loadRun, loadWorker, now, saveRun, saveWorker, setJson } from "./state.js"
import { applyOverrides, hasTestRunner, isTestFile, normalizeChecks, normalizeEcosystems, requiredChecks } from "./toolchain.js"
import type { Crash, CrashSummary, FixReport, ReviewVerdict, RunRecord, Source, Triage, Validation, WorkerInfo, WorkerPhase } from "./types.js"
import { reportFromCommands, summaryFromSubmission } from "./validate.js"

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
  query: { top: number; minUsers?: number; source?: Source; platform?: string }
  plans: Array<{ source: Source; calls: Array<{ toolId: string; input: Record<string, unknown>; appId?: string; label?: string }> }>
  planErrors: string[]
  result?: { crashes: CrashSummary[]; errors: string[]; raw?: unknown; at: string }
}

/** Stored under `fixora/recover/<requestId>`: what the recover worker was asked to list and what it reported. */
export interface RecoverRecord {
  requestId: string
  originSessionID: string
  createdAt: string
  label: string
  state: MrListState
  limit: number
  plan: MrListPlan
  remoteUrl?: string
  result?: { provider: MrListProvider; remoteUrl?: string; mrs: MrListing[]; trailers: Record<string, string>; errors: string[]; at: string }
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
    suspectCommits: { description: "Commits that `git log` / `git blame` show introduced the defect. [] when history does not identify one — never a placeholder sha such as \"unknown\".", ...A(schema({ sha: { type: "string", description: "hex commit id (7..40 chars) from git log/blame" }, subject: S, date: S, why: S }, ["sha", "subject", "why"])) },
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

const RECOVER_SCHEMA = schema(
  {
    version: { type: "number", const: 1 },
    requestId: S,
    provider: { type: "string", enum: ["gitlab-mcp", "github-mcp", "glab", "gh"] },
    remoteUrl: { type: "string", description: "the remote url (`git remote get-url <remote>`)" },
    raw: { description: "the listing reply (or the array of page replies), verbatim" },
    rawFile: { type: "string", description: "path of the saved JSON listing (CLI providers); page n is read from <path with .n.json>" },
    commits: { type: "string", description: "the `Fixora-Run:` / `Fixora-Fingerprint:` lines from git log, verbatim" },
    commitsFile: { type: "string", description: "path of the file those lines were written to" },
    errors: A(S),
  },
  ["version", "requestId", "provider", "errors"],
)

const START_SCHEMA = schema({ refs: A(S), flags: schema({ dryRun: B, ticket: B, mr: B, push: B, auto: B, force: B, testFirst: B }, []) }, ["refs"])

/**
 * Declared on every tool: the host refuses a result that carries `output` from a tool without an
 * output schema ("Tool result declared output without an output schema"). The structured value is
 * `{ ok, message, errors?, … }` (`fixora_start`: `{ started, errors }`); the schema stays open. `message`
 * repeats the content text because a CodeMode script receives the output only, and the CONTINUE /
 * STOP instruction must reach the agent that way too.
 */
const RESULT_SCHEMA = { type: "object", properties: { ok: B, message: S, errors: A(S) }, additionalProperties: true }

function failure(errors: string[], what: string) {
  const text = `${what} was NOT accepted. Fix these problems and call the tool again:\n- ${errors.join("\n- ")}`
  return { output: { ok: false, errors, message: text }, content: text }
}

const ok = (content: string, extra: Record<string, unknown> = {}) => ({ output: { ok: true, message: content, ...extra }, content })
const CONTINUE = (what: string) => `\n\nCONTINUE: ${what}`
const STOP = (why = "end your turn now") => `\n\nSTOP: ${why}.`

/** The stages the current work turn still has to do (set by the pipeline before the prompt). */
/** The branch name the naming convention planned for a new run, with `<key>` resolved to the ticket (or its fallback). */
export const plannedBranch = (run: RunRecord): string | undefined => {
  const planned = run.meta?.plannedBranch
  if (typeof planned !== "string" || !planned) return undefined
  return planned.replace("<key>", run.jiraKey ?? String(run.meta?.ticketFallback ?? run.crashId))
}

const plannedStages = (run: RunRecord): string[] => String(run.meta?.workStages ?? "").split(",").filter(Boolean)
const checksText = (run: RunRecord) => (run.toolchain?.checks ?? []).map((c) => `\`${c.command}\`${c.cwd ? ` (in ${c.cwd})` : ""}${c.optional ? " (optional)" : ""}`).join(", ") || "none detected"

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
  /** A submission this turn already accepted (the agent called the tool again): answer the same way, change nothing. */
  const alreadyReceived = (run: { meta?: Record<string, unknown> }) => typeof run.meta?.expect === "string" && run.meta.received === run.meta.expect
  /** Records why a report was refused so the pipeline can show it when the turn ends without a valid one. */
  const rejected = async (run: RunRecord, what: string, errors: string[]) => {
    run.meta = { ...run.meta, lastRejection: `${what}: ${errors.join("; ")}`.slice(0, 600) }
    await saveRun(ctx, run)
    return failure(errors, what)
  }
  /** Moves the worker session to its next phase (the tool hook reads it on every call). */
  const phase = async (sessionID: string, info: WorkerInfo, next: WorkerPhase) => saveWorker(ctx, sessionID, { ...info, phase: next })

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "submit_crashes",
      description: "Fixora lister: submit the raw replies of the crash-source calls you were asked to make (one entry per call, the reply value passed through unchanged). Call it from the same execute script that made the calls, passing the reply variables. Then stop.",
      input: CRASHES_SCHEMA,
      output: RESULT_SCHEMA,
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
        return ok(`Crash list recorded: ${crashes.length} crash(es)${errors.length ? `, ${errors.length} error(s)` : ""}.${STOP()}`, { count: crashes.length })
      },
    })

    editor.add({
      name: "submit_crash",
      description: "Fixora worker (fetch stage): submit the raw replies of the crash fetch (issue, and the sample event when one was fetched), passed through unchanged from the same execute script that made the calls. Validated on receipt; errors tell you which follow-up call to make.",
      input: CRASH_SCHEMA,
      output: RESULT_SCHEMA,
      options: { namespace: "fixora", codemode: true },
      async execute(input, c) {
        const w = await worker(c.sessionID, "fixer", ["crash"])
        if ("error" in w) return failure([w.error], "crash")
        const run = await loadRun(ctx, w.info.runId!)
        if (!run) return failure([`run ${w.info.runId} not found`], "crash")
        if (alreadyReceived(run) && existsSync(join(run.folder, "crash.json"))) return ok(`The crash of run ${run.runId} is already recorded; nothing changed.${plannedStages(run).includes("prepare") && w.info.phase === "crash" ? CONTINUE("the prepare stage") : STOP("do not submit it again")}`)
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
          return rejected(run, "crash", [describeError(error)])
        }
        if (crash.frames.length === 0 && raw.events === undefined) {
          const plan = source.fetchPlan!(sc, run.crashId, extra)
          if (plan.followUps.length) return rejected(run, "crash", [`no stack frames could be read from the issue reply. Make a follow-up call (${plan.followUps.map((f) => `\`${f.toolId}\``).join(" or ")}) as the prompt describes and resubmit with its reply as \`events\``])
        }
        await mkdir(run.folder, { recursive: true })
        await persist(run.folder, "crash.json", crash)
        run.title = crash.title
        await retitleWorker(rt, run)
        run.fingerprint = crash.fingerprint
        run.meta = { ...run.meta, crashUrl: crash.url ?? null, platform: crash.platform ?? null, appVersion: crash.appVersion ?? null, language: crash.language, symbolication: crash.symbolication, userCount: crash.userCount ?? null, eventCount: crash.eventCount ?? null, crashFetchedAt: now() }
        if (crash.appId && extra?.appId !== crash.appId) run.meta.refExtra = JSON.stringify({ ...extra, appId: crash.appId })
        const index = await indexCrash(ctx, run, crash)
        await persist(run.folder, "crash.md", `${renderCrashMarkdown(crash, { reopened: run.reopened ? { ...run.reopened } : undefined })}\n`)
        received(run)
        if (index.duplicateOf) {
          run.skipReason = `same crash fingerprint as run ${index.duplicateOf.runId} (${index.duplicateOf.status}${index.duplicateOf.mrUrl ? `, MR ${index.duplicateOf.mrUrl}` : ""})`
          run.error = duplicateMessage(index.duplicateOf)
          await stageEnd(rt, run, "fetch", "skipped", run.skipReason)
          run.status = "skipped"
          await saveRun(ctx, run)
          return ok(`Crash recorded, but ${run.skipReason}.${STOP("this crash is already being handled")}`)
        }
        await stageEnd(rt, run, "fetch", "ok", `${crash.exceptionType ?? crash.title} · ${crash.frames.length} frames · ${crash.language}${crash.symbolication !== "ok" ? ` · symbolication: ${crash.symbolication}` : ""}`)
        const next = plannedStages(run).includes("prepare")
        if (next) {
          await stageBegin(rt, run, "prepare")
          await phase(c.sessionID, w.info, "prepare")
        }
        await saveRun(ctx, run)
        return ok(`Crash recorded: ${crash.exceptionType ?? crash.title}, ${crash.frames.length} frame(s), ${crash.language}${run.reopened ? " (reopened crash)" : ""}.${next ? CONTINUE("the prepare stage (inspect the checkout first)") : STOP()}`)
      },
    })

    editor.add({
      name: "submit_prepare",
      description: "Fixora worker (prepare stage): report the checkout (stage inspect when it is dirty, so Fixora can ask the user before stashing; stage ready after the fix branch is checked out and the toolchain scanned).",
      input: PREPARE_SCHEMA,
      output: RESULT_SCHEMA,
      options: { namespace: "fixora", codemode: false },
      async execute(input, c) {
        const w = await worker(c.sessionID, "fixer", ["prepare"])
        if ("error" in w) return failure([w.error], "prepare report")
        const run = await loadRun(ctx, w.info.runId!)
        if (!run) return failure([`run ${w.info.runId} not found`], "prepare report")
        const rt = deps.rt()
        if (alreadyReceived(run) && run.checkout.active) return ok(`The checkout of run ${run.runId} is already recorded (branch ${run.branch}); nothing changed.${plannedStages(run).includes("triage") ? CONTINUE("the analyse stage") : STOP("do not submit it again")}`)
        // "ready" on a dirty checkout without an approved stash: the agent went past the inspect step.
        // Take it as the inspect report so the user is asked before anything is stashed.
        const stashApproved = run.approvals.stash === "approved" || run.approvals.stash === "auto"
        const rawP = input as { stage?: unknown; dirty?: unknown; stashRef?: unknown; status?: unknown }
        // On a re-entry (the run already has its branch) uncommitted changes are the fix in progress: carried, never stashed.
        const demoted = rawP.stage === "ready" && rawP.dirty === true && !rawP.stashRef && !stashApproved && !run.branch
        const result = validatePrepare(demoted ? { ...(input as Record<string, unknown>), stage: "inspect" } : input, { runId: run.runId, branchPrefix: rt.opts.branchPrefix, baseBranch: run.base.branch, existingBranch: run.branch, expectedBranch: plannedBranch(run) })
        if (!result.ok) return rejected(run, "prepare report", demoted ? [...result.errors, "the checkout is dirty and stashing was not approved yet: this report is taken as stage \"inspect\""] : result.errors)
        const p = result.value
        if (p.branch && p.branch === p.previousBranch) return rejected(run, "prepare report", [`previousBranch must be the branch that was checked out before the fix branch, not the fix branch itself ("${p.branch}")`])
        received(run)
        if (p.blocked) {
          run.blockedReason = p.blocked
          run.error = p.blockedDetail ?? p.blocked
          run.meta = { ...run.meta, prepareStage: "blocked" }
          await stageEnd(rt, run, "prepare", "failed", p.blocked)
          run.status = "blocked"
          await saveRun(ctx, run)
          return ok(`Reported: ${p.blocked}.${STOP()}`)
        }
        if (p.stage === "inspect") {
          run.checkout = { ...run.checkout, active: false, previousBranch: p.previousBranch, previousHeadSha: p.previousHeadSha }
          run.gitRoot = p.repoRoot || run.gitRoot
          run.meta = { ...run.meta, prepareStage: "inspect", prepareDirty: p.dirty, prepareStatus: (p.status ?? "").slice(0, 20_000), prepareDirtyFiles: p.dirtyFiles ?? (p.status ? p.status.split("\n").filter(Boolean).length : 0) }
          await saveRun(ctx, run)
          return ok(p.dirty ? `Reported a dirty checkout.${STOP("Fixora asks the user whether to stash, then prompts you again")}` : `Reported a clean checkout.${CONTINUE('fetch the base branch, create / check out the fix branch, scan the toolchain, then call fixora_submit_prepare with stage "ready"')}`)
        }
        markPrepared(run, { previousBranch: p.previousBranch, previousHeadSha: p.previousHeadSha, stashRef: p.stashRef ?? null, branch: p.branch!, gitRoot: p.repoRoot, baseSha: p.baseSha, remoteUrl: p.remoteUrl })
        const checks = applyOverrides(normalizeChecks(p.toolchain?.checks), rt.opts.testCommands)
        run.toolchain = { ecosystems: normalizeEcosystems(p.toolchain?.ecosystems), checks, conventionFiles: p.conventionFiles }
        run.meta = { ...run.meta, prepareStage: "ready", prepareNotes: p.notes.join("; ").slice(0, 2000) }
        await mkdir(run.folder, { recursive: true })
        await persist(run.folder, "project.md", `${renderProject({ toolchain: run.toolchain, forbidden: [...FORBIDDEN_GLOBS, ...rt.opts.validate.denyPaths], limits: rt.opts.validate })}\n`)
        await persist(run.folder, "limits.json", { maxFilesChanged: rt.opts.validate.maxFilesChanged, maxDiffLines: rt.opts.validate.maxDiffLines, testTimeoutSec: rt.opts.testCommands.timeoutSec, fullSuiteMaxMinutes: rt.opts.testCommands.fullSuiteMaxMinutes, tests: run.meta?.tests ?? "auto", fixMinutes: rt.opts.worker.maxPhaseMinutes.fix, mode: run.flags.testFirst ? "test-first" : "fix", maxFixRounds: rt.opts.maxFixRounds })
        await stageEnd(rt, run, "prepare", "ok", `${run.branch} from ${run.base.remote}/${run.base.branch}${run.base.sha ? `@${run.base.sha.slice(0, 8)}` : ""}${run.checkout.stashRef ? " · changes stashed" : ""}`)
        const stages = plannedStages(run)
        let next: string | undefined
        if (stages.includes("triage")) {
          await stageBegin(rt, run, "analyse")
          await phase(c.sessionID, w.info, "triage")
          next = `the analyse stage (read-only): read ${join(run.folder, "crash.md")} and ${join(run.folder, "project.md")}, find the root cause, write analysis.md, then call fixora_submit_triage`
        } else if (stages.includes("fix")) {
          await stageBegin(rt, run, "fix")
          await phase(c.sessionID, w.info, run.meta?.feedback ? "feedback" : "fix")
          next = `the fix stage as the prompt describes; checks to run: ${checksText(run)}`
        }
        await saveRun(ctx, run)
        return ok(`Checkout prepared on ${run.branch} (${run.toolchain.ecosystems.map((e) => e.id).join(", ") || "no ecosystem"}; checks: ${checksText(run)}).${next ? CONTINUE(next) : STOP()}`)
      },
    })

    editor.add({
      name: "submit_triage",
      description: "Fixora worker (analyse stage): submit the root-cause analysis for the current run. Validated on receipt; errors are returned so you can correct and resubmit.",
      input: TRIAGE_SCHEMA,
      output: RESULT_SCHEMA,
      options: { namespace: "fixora", codemode: false },
      async execute(input, c) {
        const w = await worker(c.sessionID, "fixer", ["triage"])
        if ("error" in w) return failure([w.error], "triage")
        const run = await loadRun(ctx, w.info.runId!)
        if (!run) return failure([`run ${w.info.runId} not found`], "triage")
        const rt = deps.rt()
        const root = run.gitRoot ?? run.repo
        const result: Validation<Triage> = validateTriage(input, { runId: run.runId, fileExists: (p) => existsSync(join(root, p)) })
        if (!result.ok) return rejected(run, "triage", result.errors)
        run.triage = result.value
        run.pipeline.analysed = true
        received(run)
        await persist(run.folder, "triage.json", result.value)
        const t = result.value
        const fixable = t.classification === "fixable" && t.confidence >= rt.opts.confidence.minToFix
        await stageEnd(rt, run, "analyse", "ok", `${t.classification} · confidence ${Math.round(t.confidence * 100)}% · risk ${t.risk.level}`)
        const next = fixable && plannedStages(run).includes("fix")
        if (next) {
          await stageBegin(rt, run, "fix")
          await phase(c.sessionID, w.info, "fix")
        }
        await saveRun(ctx, run)
        const attempt = run.counters.fixRounds + run.counters.reviewRounds + run.counters.feedback + 1
        if (next) return ok(`Triage accepted: ${t.classification}, confidence ${Math.round(t.confidence * 100)}%.${CONTINUE(`the fix stage (attempt ${attempt}): implement the strategy you submitted, add the regression test, run the checks (${checksText(run)}), then \`git add -N . && git status --porcelain=v1 --untracked-files=all\` and \`git diff HEAD\`, and call fixora_submit_fix with attempt ${attempt} and both outputs as status / diff`)}`)
        return ok(`Triage accepted: ${t.classification}, confidence ${Math.round(t.confidence * 100)}%.${STOP(fixable ? "end your turn" : `Fixora stops here (${t.classification !== "fixable" ? `classified as ${t.classification}` : "confidence below the threshold"})`)}`)
      },
    })

    editor.add({
      name: "submit_ticket",
      description: "Fixora worker (publish turn): report the Jira ticket that was created or reused (or why it failed).",
      input: TICKET_SCHEMA,
      output: RESULT_SCHEMA,
      options: { namespace: "fixora", codemode: false },
      async execute(input, c) {
        const w = await worker(c.sessionID, "fixer", ["prepare", "ticket", "publish", "close-loop"])
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
        // The ticket row of the panel: the ticket is made inside the prepare or publish turn, so no stage of its own runs.
        await stageMark(deps.rt(), run, "ticket", t.action === "failed" ? "failed" : "ok", t.action === "failed" ? `not created: ${(t.error ?? "unknown error").slice(0, 120)}` : `${t.key} ${t.action}`)
        if (t.action !== "failed") await retitleWorker(deps.rt(), run)
        await saveRun(ctx, run)
        if (w.info.phase === "prepare") {
          const branch = plannedBranch(run)
          return ok(t.action === "failed" ? `Ticket failure recorded.${CONTINUE(`the prepare stage; the branch name is now \`${branch}\``)}` : `Ticket ${t.key} (${t.action}) recorded.${CONTINUE(`the prepare stage with branch \`${branch}\``)}`)
        }
        return ok(t.action === "failed" ? `Ticket failure recorded.${CONTINUE("the next step of the prompt")}` : `Ticket ${t.key} (${t.action}) recorded.${CONTINUE(`the next step of the prompt (use ${t.key} wherever it says <key>)`)}`)
      },
    })

    editor.add({
      name: "submit_fix",
      description: "Fixora worker (fix stage): submit the fix report after changing code and running the project's checks, with `status` (git status --porcelain=v1 after git add -N .) and `diff` (git diff HEAD) verbatim. Validated against them, forbidden paths and limits; errors are returned so you can correct and resubmit.",
      input: FIX_SCHEMA,
      output: RESULT_SCHEMA,
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
        if (!result.ok) return rejected(run, "fix report", result.errors)
        run.fix = result.value
        run.pipeline.fixed = result.value.changesMade
        if (result.value.changesMade) {
          run.change = { paths: summary.paths, added: summary.added, deleted: summary.deleted, diffHash: summary.diffHash }
          run.tests = reportFromCommands(result.value.commandsRun, summary.diffHash, checks)
          await persist(run.folder, `diff.${attempt}.patch`, summary.diff)
          await persist(run.folder, `verification.${attempt}.json`, run.tests)
        }
        received(run)
        if (run.step === "fix" && run.timings.fix?.status === "running") await stageEnd(rt, run, "fix", "ok", result.value.changesMade ? `${result.value.filesChanged.length} file(s): ${result.value.summary}` : "no changes")
        await saveRun(ctx, run)
        await persist(run.folder, `fix.${attempt}.json`, result.value)
        return ok(result.value.changesMade ? `Fix report accepted. Fixora now checks the change set and runs an independent review.${STOP()}` : `Report accepted (no changes).${STOP()}`)
      },
    })

    editor.add({
      name: "submit_review",
      description: "Fixora reviewer: submit the review verdict for the current diff. Any blocker finding makes the verdict a rejection.",
      input: REVIEW_SCHEMA,
      output: RESULT_SCHEMA,
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
        return ok(`Review recorded: ${result.value.verdict}.${STOP()}`)
      },
    })

    editor.add({
      name: "submit_publish",
      description: "Fixora worker (publish turn): report what was committed, pushed and opened as a merge request (partial results are fine; list errors). The prompt's remaining steps (links, restore) follow.",
      input: PUBLISH_SCHEMA,
      output: RESULT_SCHEMA,
      options: { namespace: "fixora", codemode: false },
      async execute(input, c) {
        const w = await worker(c.sessionID, "fixer", ["publish"])
        if ("error" in w) return failure([w.error], "publish report")
        const run = await loadRun(ctx, w.info.runId!)
        if (!run) return failure([`run ${w.info.runId} not found`], "publish report")
        const result = validatePublish(input, { runId: run.runId, grants: w.info.grants ?? {}, branch: run.branch ?? "", remote: run.base.remote })
        if (!result.ok) return rejected(run, "publish report", result.errors)
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
        run.meta = { ...run.meta, publishErrors: p.errors.join("; ").slice(0, 2000) || null, publishedAt: now() }
        received(run)
        await saveRun(ctx, run)
        return ok(`Publish report recorded (${[p.committed && "committed", p.pushed && "pushed", p.mr && "MR opened", p.mrSkipped && "MR skipped"].filter(Boolean).join(", ") || "nothing"}).${CONTINUE("the remaining steps of the prompt (links, then restore the checkout)")}`)
      },
    })

    editor.add({
      name: "submit_ops",
      description: "Fixora worker: report the outcome of an ops step (restore, close-loop, sync, close-mr, jira-comment, clean, annotate).",
      input: OPS_SCHEMA,
      output: RESULT_SCHEMA,
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
          return ok(`${o.op} recorded.${STOP()}`)
        }
        const run = await loadRun(ctx, info.runId)
        if (!run) return failure([`run ${info.runId} not found`], "ops report")
        switch (o.op) {
          case "restore":
            if (o.ok && o.results.kept === true && run.checkout.active) run.meta = { ...run.meta, restoreKept: true }
            else if (o.ok) {
              markRestored(run, at)
              run.meta = { ...run.meta, restoreKept: null }
            }
            break
          case "close-loop":
            run.pipeline.loopClosed = true
            run.meta = { ...run.meta, closeLoopResult: JSON.stringify({ ok: o.ok, errors: o.errors, results: o.results }).slice(0, 2000) }
            break
          case "close-mr":
            if (o.ok && run.mrUrl) run.mrStatus = "closed"
            break
          case "sync": {
            const s = typeof o.results.status === "string" ? o.results.status : undefined
            if (s === "draft" || s === "open" || s === "merged" || s === "closed") run.mrStatus = s
            if (s === "merged" && typeof run.meta?.mergedAt !== "string") run.meta = { ...run.meta, mergedAt: at }
            break
          }
          default:
            break
        }
        run.meta = { ...run.meta, opsResult: JSON.stringify({ op: o.op, ok: o.ok, errors: o.errors, results: o.results, at }).slice(0, 4000) }
        received(run)
        await saveRun(ctx, run)
        const more = o.op === "close-loop" ? CONTINUE("the restore step of the prompt") : STOP()
        return ok(`${o.op} recorded (${o.ok ? "ok" : "with errors"}).${more}`)
      },
    })

    editor.add({
      name: "submit_recover",
      description: "Fixora recover: submit the merge-request listing (the reply value or the saved JSON file) and the Fixora commit trailer lines. Call it once, from the same execute script that listed the merge requests when an MCP tool was used. Then stop.",
      input: RECOVER_SCHEMA,
      output: RESULT_SCHEMA,
      options: { namespace: "fixora", codemode: true },
      async execute(input, c) {
        const w = await worker(c.sessionID, "fixer", ["recover"])
        if ("error" in w) return failure([w.error], "recover")
        if (!w.info.requestId) return failure(["this session has no recover request"], "recover")
        const result = validateRecover(input, { requestId: w.info.requestId })
        if (!result.ok) return failure(result.errors, "recover")
        const record = await getJson<RecoverRecord>(ctx, keys.recover(w.info.requestId))
        if (!record) return failure([`unknown request ${w.info.requestId}`], "recover")
        const s = result.value
        const errors = [...s.errors]
        const inside = (p: string) => normalizePath(p).startsWith(`${normalizePath(join(w.info.repo, ".dxcoder", "fixora"))}/`)
        const readInside = async (p: string) => {
          if (!inside(p)) {
            errors.push(`${p} is outside ${join(w.info.repo, ".dxcoder", "fixora")}; files are only read from there`)
            return undefined
          }
          return readFile(p, "utf8").catch((e: unknown) => {
            errors.push(`${p}: ${describeError(e)}`)
            return undefined
          })
        }
        const raws: unknown[] = []
        if (s.raw !== undefined) raws.push(s.raw)
        if (s.rawFile) {
          // `<base>.1.json`, `.2.json`, … are one page each (CLI listings); any other name is a single file.
          const paged = /^(.*)\.1\.json$/.exec(s.rawFile)
          if (paged) {
            for (let n = 1; n <= 50; n++) {
              const p = `${paged[1]}.${n}.json`
              if (n > 1 && !existsSync(p)) break
              const text = await readInside(p)
              if (text === undefined) break
              raws.push(text)
            }
          } else {
            const text = await readInside(s.rawFile)
            if (text !== undefined) raws.push(text)
          }
        }
        let commits = s.commits ?? ""
        if (!commits && s.commitsFile) commits = (await readInside(s.commitsFile)) ?? ""
        const mrs = normalizeMrList(raws)
        const trailers = parseTrailers(commits)
        if (mrs.length === 0 && errors.length === 0 && raws.length === 0) return failure(["no listing was submitted: pass the reply as raw, or the saved file as rawFile"], "recover")
        // A placeholder left in place of the remote url ("<remote url from step 1>") is dropped, not stored.
        const remoteUrl = s.remoteUrl && parseRemote(s.remoteUrl) ? s.remoteUrl : undefined
        record.result = { provider: s.provider, remoteUrl, mrs, trailers: Object.fromEntries(trailers), errors, at: now() }
        await setJson(ctx, keys.recover(w.info.requestId), record)
        return ok(`Recover listing recorded: ${mrs.length} merge request(s), ${trailers.size} commit trailer pair(s)${errors.length ? `, ${errors.length} error(s)` : ""}.${STOP()}`, { count: mrs.length })
      },
    })

    editor.add({
      name: "start",
      description: 'Start Fixora runs for one or more crash references (e.g. "sentry:12345", "crashlytics:abc", or a crash URL). Use after the user picked crashes from the /fixora list. Not available inside Fixora worker sessions.',
      input: START_SCHEMA,
      output: RESULT_SCHEMA,
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
