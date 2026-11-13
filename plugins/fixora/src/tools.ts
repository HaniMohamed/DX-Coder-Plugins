// Plugin-registered tools: structured submissions from the worker sessions (validated on receipt and
// persisted) and `fixora_start` for the interactive picker in the origin session.

import type { Plugin } from "@opencode/plugin"
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { validateFix, validateReview, validateTriage } from "./contracts.js"
import { git } from "./git.js"
import type { FixoraOptions } from "./options.js"
import { forbiddenReason } from "./permissions.js"
import { loadRun, loadWorker, saveRun } from "./state.js"
import { isTestFile, type Ecosystem } from "./toolchain.js"
import type { FixReport, ReviewVerdict, Triage, Validation, WorkerInfo } from "./types.js"

export interface ToolDeps {
  options: () => FixoraOptions
  ecosystems: (runId: string) => Promise<Ecosystem[]>
  hasTestRunner: (runId: string) => Promise<boolean>
  /** Starts runs from the origin session (interactive picker). Returns the run ids. */
  start: (input: { sessionID: string; refs: string[]; flags?: Record<string, unknown> }) => Promise<{ started: string[]; errors: string[] }>
  isWorkerSession: (sessionID: string) => Promise<boolean>
}

const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: true })
const S = { type: "string" }
const N = { type: "number" }
const B = { type: "boolean" }
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
    commandsRun: A(schema({ command: S, exitCode: N, durationMs: N, summary: S }, ["command", "exitCode", "durationMs", "summary"])),
    reproduction: schema({ mode: { type: "string", enum: ["test-first", "fix"] }, failingBefore: B, passingAfter: B }, ["mode"]),
    risk: schema({ level: { type: "string", enum: ["low", "medium", "high"] }, publicApiChange: B, behaviourChange: S, rollback: S }, ["level", "publicApiChange", "behaviourChange", "rollback"]),
    notesForReviewer: S,
    changesMade: B,
    unresolved: A(S),
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

const START_SCHEMA = schema({ refs: A(S), flags: schema({ dryRun: B, ticket: B, mr: B, push: B, auto: B, force: B, testFirst: B }, []) }, ["refs"])

function failure(errors: string[], what: string) {
  const text = `${what} was NOT accepted. Fix these problems and call the tool again:\n- ${errors.join("\n- ")}`
  return { output: { ok: false, errors }, content: text }
}

export async function registerPluginTools(ctx: Plugin.Context, deps: ToolDeps): Promise<void> {
  const worker = async (sessionID: string, role: WorkerInfo["role"]): Promise<{ info: WorkerInfo } | { error: string }> => {
    const info = await loadWorker(ctx, sessionID)
    if (!info) return { error: "this tool can only be called from a Fixora worker session" }
    if (info.role !== role) return { error: `this tool is for the ${role} session, not the ${info.role}` }
    return { info }
  }
  const persist = async <T extends object>(runId: string, file: string, value: T) => {
    const run = await loadRun(ctx, runId)
    if (!run) return
    await writeFile(join(run.folder, file), `${JSON.stringify(value, null, 2)}\n`)
  }

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "fixora_submit_triage",
      description: "Fixora worker (triage phase): submit the root-cause analysis for the current run. Validated on receipt; errors are returned so you can correct and resubmit.",
      input: TRIAGE_SCHEMA,
      options: { namespace: "fixora", codemode: false },
      async execute(input, c) {
        const w = await worker(c.sessionID, "fixer")
        if ("error" in w) return failure([w.error], "triage")
        const run = await loadRun(ctx, w.info.runId)
        if (!run) return failure([`run ${w.info.runId} not found`], "triage")
        const result: Validation<Triage> = validateTriage(input, { runId: run.runId, fileExists: (p) => existsSync(join(w.info.worktree, p)) })
        if (!result.ok) return failure(result.errors, "triage")
        run.triage = result.value
        run.pipeline.analysed = true
        await saveRun(ctx, run)
        await persist(run.runId, "triage.json", result.value)
        return { output: { ok: true }, content: `Triage accepted: ${result.value.classification}, confidence ${Math.round(result.value.confidence * 100)}%. You may stop now unless asked to continue.` }
      },
    })

    editor.add({
      name: "fixora_submit_fix",
      description: "Fixora worker (fix phase): submit the fix report after changing code and running the project's checks. Validated against git status, forbidden paths and limits; errors are returned so you can correct and resubmit.",
      input: FIX_SCHEMA,
      options: { namespace: "fixora", codemode: false },
      async execute(input, c) {
        const w = await worker(c.sessionID, "fixer")
        if ("error" in w) return failure([w.error], "fix report")
        const run = await loadRun(ctx, w.info.runId)
        if (!run) return failure([`run ${w.info.runId} not found`], "fix report")
        const opts = deps.options()
        const changed = (await git.statusPorcelain(w.info.worktree)).map((f) => f.path)
        const ecosystems = await deps.ecosystems(run.runId)
        const attempt = run.counters.fixRounds + run.counters.reviewRounds + run.counters.feedback + 1
        const result: Validation<FixReport> = validateFix(input, {
          runId: run.runId,
          attempt,
          changedFiles: changed,
          forbidden: (p) => forbiddenReason(p, opts.validate.denyPaths),
          maxFilesChanged: opts.validate.maxFilesChanged,
          hasTestRunner: await deps.hasTestRunner(run.runId),
          requireTestChange: opts.validate.requireTestChange,
          isTestFile: (p) => isTestFile(p, ecosystems),
          testFirst: run.flags.testFirst,
        })
        if (!result.ok) return failure(result.errors, "fix report")
        run.fix = result.value
        run.pipeline.fixed = result.value.changesMade
        await saveRun(ctx, run)
        await persist(run.runId, `fix.${attempt}.json`, result.value)
        return { output: { ok: true }, content: "Fix report accepted. Fixora will now run the project's checks and an independent review. Stop here." }
      },
    })

    editor.add({
      name: "fixora_submit_review",
      description: "Fixora reviewer: submit the review verdict for the current diff. Any blocker finding makes the verdict a rejection.",
      input: REVIEW_SCHEMA,
      options: { namespace: "fixora", codemode: false },
      async execute(input, c) {
        const w = await worker(c.sessionID, "reviewer")
        if ("error" in w) return failure([w.error], "review")
        const run = await loadRun(ctx, w.info.runId)
        if (!run) return failure([`run ${w.info.runId} not found`], "review")
        const attempt = run.reviews.length + 1
        const known = [...(run.fix?.filesChanged ?? []), ...(run.triage?.mappedFrames.map((m) => m.file) ?? [])]
        const result: Validation<ReviewVerdict> = validateReview(input, { runId: run.runId, attempt, knownFiles: known })
        if (!result.ok) return failure(result.errors, "review")
        run.reviews.push(result.value)
        await saveRun(ctx, run)
        await persist(run.runId, `review.${attempt}.json`, result.value)
        return { output: { ok: true }, content: `Review recorded: ${result.value.verdict}. Stop here.` }
      },
    })

    editor.add({
      name: "fixora_start",
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
