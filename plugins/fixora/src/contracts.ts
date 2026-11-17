// Dependency-free validators for the worker's structured outputs. Errors are fed back to the model
// verbatim, so they say what is wrong and what is expected.

import { isHexSha, isValidBranchName, isProtectedBranch } from "./git.js"
import { JIRA_KEY } from "./options.js"
import { isMrUrl } from "./mr.js"
import { SECRET_PATTERNS } from "./secrets.js"
import type { Category, CheckKind, Classification, FindingCategory, FixReport, ReviewVerdict, RiskLevel, Severity, Triage, Validation, Verdict, WorkerGrants } from "./types.js"

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string")

export const CLASSIFICATIONS: Classification[] = ["fixable", "needs_symbolication", "third_party_only", "not_in_repo", "env_or_data", "needs_human", "duplicate_of"]
export const CATEGORIES: Category[] = ["null-deref", "race", "state", "api-contract", "parsing", "config", "ui-lifecycle", "resource", "other"]
export const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high"]
export const VERDICTS: Verdict[] = ["approve", "approve_with_nits", "reject"]
export const FINDING_CATEGORIES: FindingCategory[] = ["correctness", "scope", "risk", "tests", "style", "security"]
export const SEVERITIES: Severity[] = ["blocker", "major", "minor"]
const MAX_TEXT = 4000
/** The first 7..40-char hex token in a string: a commit id on its own or wrapped in prose; undefined for placeholders. */
const commitIdIn = (text: string): string | undefined => text.match(/(?<![0-9a-z])[0-9a-f]{7,40}(?![0-9a-z])/i)?.[0]

class Check {
  readonly errors: string[] = []
  constructor(readonly v: Record<string, unknown>) {}

  str(key: string, o: { min?: number; max?: number; required?: boolean } = { required: true }): string | undefined {
    const val = this.v[key]
    if (val === undefined || val === null) {
      if (o.required !== false) this.errors.push(`${key} is required (string)`)
      return undefined
    }
    if (typeof val !== "string") {
      this.errors.push(`${key} must be a string`)
      return undefined
    }
    if (o.min !== undefined && val.trim().length < o.min) this.errors.push(`${key} must be at least ${o.min} characters`)
    if (val.length > (o.max ?? MAX_TEXT)) this.errors.push(`${key} must be at most ${o.max ?? MAX_TEXT} characters`)
    this.secret(key, val)
    return val
  }
  secret(key: string, val: string) {
    for (const p of SECRET_PATTERNS) if (p.regex.test(val)) this.errors.push(`${key} contains what looks like a ${p.name}; remove it`)
  }
  num(key: string, o: { min?: number; max?: number; int?: boolean; required?: boolean } = { required: true }): number | undefined {
    const val = this.v[key]
    if (val === undefined || val === null) {
      if (o.required !== false) this.errors.push(`${key} is required (number)`)
      return undefined
    }
    if (typeof val !== "number" || !Number.isFinite(val)) {
      this.errors.push(`${key} must be a number`)
      return undefined
    }
    if (o.int && !Number.isInteger(val)) this.errors.push(`${key} must be an integer`)
    if (o.min !== undefined && val < o.min) this.errors.push(`${key} must be >= ${o.min}`)
    if (o.max !== undefined && val > o.max) this.errors.push(`${key} must be <= ${o.max}`)
    return val
  }
  bool(key: string, required = true): boolean | undefined {
    const val = this.v[key]
    if (val === undefined || val === null) {
      if (required) this.errors.push(`${key} is required (true/false)`)
      return undefined
    }
    if (typeof val !== "boolean") this.errors.push(`${key} must be true or false`)
    return typeof val === "boolean" ? val : undefined
  }
  strs(key: string, o: { required?: boolean; max?: number } = {}): string[] {
    const val = this.v[key]
    if (val === undefined || val === null) {
      if (o.required) this.errors.push(`${key} is required (array of strings)`)
      return []
    }
    if (!isStringArray(val)) {
      this.errors.push(`${key} must be an array of strings`)
      return []
    }
    if (o.max !== undefined && val.length > o.max) this.errors.push(`${key} must have at most ${o.max} entries`)
    for (const s of val) this.secret(key, s)
    return val
  }
  oneOf<T extends string>(key: string, allowed: readonly T[], required = true): T | undefined {
    const val = this.v[key]
    if (val === undefined || val === null) {
      if (required) this.errors.push(`${key} is required (one of ${allowed.join(", ")})`)
      return undefined
    }
    if (typeof val !== "string" || !(allowed as readonly string[]).includes(val)) {
      this.errors.push(`${key} must be one of ${allowed.join(", ")} (got ${JSON.stringify(val)})`)
      return undefined
    }
    return val as T
  }
  objs(key: string, o: { required?: boolean; max?: number } = {}): Record<string, unknown>[] {
    const val = this.v[key]
    if (val === undefined || val === null) {
      if (o.required) this.errors.push(`${key} is required (array of objects)`)
      return []
    }
    if (!Array.isArray(val) || !val.every(isRecord)) {
      this.errors.push(`${key} must be an array of objects`)
      return []
    }
    if (o.max !== undefined && val.length > o.max) this.errors.push(`${key} must have at most ${o.max} entries`)
    return val
  }
  obj(key: string, required = true): Record<string, unknown> | undefined {
    const val = this.v[key]
    if (val === undefined || val === null) {
      if (required) this.errors.push(`${key} is required (object)`)
      return undefined
    }
    if (!isRecord(val)) {
      this.errors.push(`${key} must be an object`)
      return undefined
    }
    return val
  }
}

export interface TriageContext {
  runId: string
  /** Returns true when the repo-relative path exists in the checkout. */
  fileExists: (path: string) => boolean
  knownCrashKeys?: string[]
}

export function validateTriage(input: unknown, ctx: TriageContext): Validation<Triage> {
  if (!isRecord(input)) return { ok: false, errors: ["root must be an object"] }
  const c = new Check(input)
  if (input.version !== 1) c.errors.push("version must be 1")
  const runId = c.str("runId")
  if (runId && runId !== ctx.runId) c.errors.push(`runId must be "${ctx.runId}"`)
  const classification = c.oneOf("classification", CLASSIFICATIONS)
  const rootCause = c.str("rootCause", { min: classification === "fixable" ? 40 : 10 })
  const category = c.oneOf("category", CATEGORIES)
  const confidence = c.num("confidence", { min: 0, max: 1 })
  const confidenceReasons = c.strs("confidenceReasons")
  const fixStrategy = c.str("fixStrategy", { required: classification === "fixable", min: classification === "fixable" ? 10 : 0 })
  const introducedRaw = input.introducedInRelease
  if (introducedRaw !== null && introducedRaw !== undefined && typeof introducedRaw !== "string") c.errors.push("introducedInRelease must be a string or null")
  const mapped: Triage["mappedFrames"] = []
  for (const [i, f] of c.objs("mappedFrames", { max: 30 }).entries()) {
    const fc = new Check(f)
    const index = fc.num("index", { min: 0, int: true })
    const file = fc.str("file", { max: 500 })
    const line = fc.num("line", { min: 1, int: true, required: false })
    const fn = fc.str("function", { required: false, max: 300 })
    const evidence = fc.str("evidence", { min: 5 })
    if (file && !ctx.fileExists(file)) fc.errors.push(`file "${file}" does not exist in the repository (use a repo-relative path)`)
    c.errors.push(...fc.errors.map((e) => `mappedFrames[${i}].${e}`))
    if (fc.errors.length === 0 && index !== undefined && file && evidence) mapped.push({ index, file, line, function: fn, evidence })
  }
  if (classification === "fixable" && mapped.length === 0) c.errors.push("a fixable crash needs at least one mappedFrames entry whose file exists in the repository")
  const suspect: Triage["suspectCommits"] = []
  for (const [i, s] of c.objs("suspectCommits", { max: 10 }).entries()) {
    const sc = new Check(s)
    // A suspect commit is a hint, not a gate: a placeholder sha ("unknown", "n/a", "HEAD") drops the
    // entry instead of refusing the whole report, and a sha wrapped in prose ("commit 3f2a1c9 …") is unwrapped.
    const shaRaw = sc.str("sha", { required: false, max: 300 })
    const sha = shaRaw ? commitIdIn(shaRaw) : undefined
    const subject = sc.str("subject", { max: 300 })
    const date = sc.str("date", { required: false, max: 40 })
    const why = sc.str("why", { min: 5 })
    c.errors.push(...sc.errors.map((e) => `suspectCommits[${i}].${e}`))
    if (sc.errors.length === 0 && sha && subject && why) suspect.push({ sha, subject, date, why })
  }
  const alternatives: Triage["alternatives"] = []
  for (const [i, a] of c.objs("alternatives", { max: 10 }).entries()) {
    const ac = new Check(a)
    const strategy = ac.str("strategy")
    const rejectedBecause = ac.str("rejectedBecause")
    c.errors.push(...ac.errors.map((e) => `alternatives[${i}].${e}`))
    if (strategy && rejectedBecause) alternatives.push({ strategy, rejectedBecause })
  }
  if (classification === "fixable" && alternatives.length === 0) c.errors.push("list at least one rejected alternative in alternatives[]")
  const riskObj = c.obj("risk")
  let risk: Triage["risk"] = { level: "medium", notes: [] }
  if (riskObj) {
    const rc = new Check(riskObj)
    const level = rc.oneOf("level", RISK_LEVELS)
    const notes = rc.strs("notes")
    c.errors.push(...rc.errors.map((e) => `risk.${e}`))
    if (level) risk = { level, notes }
  }
  const suggestedTests = c.strs("suggestedTests")
  const relatedCrashes = c.strs("relatedCrashes")
  if (ctx.knownCrashKeys) for (const k of relatedCrashes) if (!ctx.knownCrashKeys.includes(k)) c.errors.push(`relatedCrashes contains unknown crash key "${k}"`)
  const reopenReason = c.oneOf("reopenReason", ["incomplete-fix", "new-code-path", "regression", "fix-not-shipped"] as const, false)
  const flaggedContent = c.strs("flaggedContent")
  if (c.errors.length > 0) return { ok: false, errors: dedupe(c.errors) }
  return {
    ok: true,
    value: {
      version: 1,
      runId: ctx.runId,
      classification: classification!,
      mappedFrames: mapped,
      rootCause: rootCause!,
      category: category!,
      confidence: confidence!,
      confidenceReasons,
      suspectCommits: suspect,
      introducedInRelease: typeof introducedRaw === "string" ? introducedRaw : null,
      fixStrategy: fixStrategy ?? "",
      alternatives,
      risk,
      suggestedTests,
      relatedCrashes,
      reopenReason,
      flaggedContent,
    },
  }
}

export interface FixContext {
  runId: string
  attempt: number
  /** Paths changed in the checkout according to the status the worker reported (repo-relative). */
  changedFiles: string[]
  forbidden: (path: string) => string | undefined
  maxFilesChanged: number
  hasTestRunner: boolean
  requireTestChange: boolean
  isTestFile: (path: string) => boolean
  testFirst: boolean
  /** Check commands that must appear in commandsRun (the plan's non-optional ones). */
  requiredChecks?: string[]
}

const CHECK_KINDS: CheckKind[] = ["setup", "syntax", "lint", "typecheck", "unit", "integration", "build"]

export function validateFix(input: unknown, ctx: FixContext): Validation<FixReport> {
  if (!isRecord(input)) return { ok: false, errors: ["root must be an object"] }
  const c = new Check(input)
  if (input.version !== 1) c.errors.push("version must be 1")
  const runId = c.str("runId")
  if (runId && runId !== ctx.runId) c.errors.push(`runId must be "${ctx.runId}"`)
  const attempt = c.num("attempt", { min: 1, int: true })
  if (attempt !== undefined && attempt !== ctx.attempt) c.errors.push(`attempt must be ${ctx.attempt}`)
  const summary = c.str("summary", { min: 5, max: 200 })
  const filesChanged = c.strs("filesChanged", { required: true })
  const rationale = c.str("rationale", { min: 20 })
  const changesMade = c.bool("changesMade") ?? true
  const unresolved = c.strs("unresolved")
  const alternativesRejected: FixReport["alternativesRejected"] = []
  for (const [i, a] of c.objs("alternativesRejected", { max: 10 }).entries()) {
    const ac = new Check(a)
    const strategy = ac.str("strategy")
    const reason = ac.str("reason")
    c.errors.push(...ac.errors.map((e) => `alternativesRejected[${i}].${e}`))
    if (strategy && reason) alternativesRejected.push({ strategy, reason })
  }
  const testsAdded: FixReport["testsAdded"] = []
  for (const [i, t] of c.objs("testsAdded", { max: 30 }).entries()) {
    const tc = new Check(t)
    const file = tc.str("file", { max: 500 })
    const name = tc.str("name", { max: 300 })
    const kind = tc.oneOf("kind", ["regression", "unit", "integration"] as const)
    c.errors.push(...tc.errors.map((e) => `testsAdded[${i}].${e}`))
    if (file && name && kind) testsAdded.push({ file, name, kind })
  }
  const commandsRun: FixReport["commandsRun"] = []
  for (const [i, r] of c.objs("commandsRun", { max: 30 }).entries()) {
    const rc = new Check(r)
    const command = rc.str("command", { max: 500 })
    const exitCode = rc.num("exitCode", { int: true })
    const durationMs = rc.num("durationMs", { min: 0 })
    const summaryText = rc.str("summary", { max: 500 })
    const kind = rc.oneOf("kind", CHECK_KINDS, false)
    const cwd = rc.str("cwd", { required: false, max: 300 })
    const outputTail = rc.str("outputTail", { required: false, max: 20_000 })
    c.errors.push(...rc.errors.map((e) => `commandsRun[${i}].${e}`))
    if (command && exitCode !== undefined && durationMs !== undefined && summaryText) commandsRun.push({ command, exitCode, durationMs, summary: summaryText, kind, cwd, outputTail })
  }
  let reproduction: FixReport["reproduction"]
  const repro = c.obj("reproduction", ctx.testFirst)
  if (repro) {
    const pc = new Check(repro)
    const mode = pc.oneOf("mode", ["test-first", "fix"] as const)
    const failingBefore = pc.bool("failingBefore", ctx.testFirst)
    const passingAfter = pc.bool("passingAfter", ctx.testFirst)
    c.errors.push(...pc.errors.map((e) => `reproduction.${e}`))
    if (mode) reproduction = { mode, failingBefore, passingAfter }
    if (ctx.testFirst && changesMade && !(failingBefore && passingAfter)) c.errors.push("test-first mode requires reproduction.failingBefore and reproduction.passingAfter to be true")
  }
  let risk: FixReport["risk"] = { level: "medium", publicApiChange: false, behaviourChange: "", rollback: "" }
  const riskObj = c.obj("risk")
  if (riskObj) {
    const rc = new Check(riskObj)
    const level = rc.oneOf("level", RISK_LEVELS)
    const publicApiChange = rc.bool("publicApiChange")
    const behaviourChange = rc.str("behaviourChange", { max: 1000 })
    const rollback = rc.str("rollback", { max: 1000 })
    c.errors.push(...rc.errors.map((e) => `risk.${e}`))
    if (level && publicApiChange !== undefined && behaviourChange !== undefined && rollback !== undefined) risk = { level, publicApiChange, behaviourChange, rollback }
  }
  const notesForReviewer = c.str("notesForReviewer", { required: false, max: 2000 })

  if (changesMade) {
    const reported = new Set(filesChanged.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "")))
    const actual = new Set(ctx.changedFiles)
    for (const f of actual) if (!reported.has(f)) c.errors.push(`filesChanged is missing "${f}" which is modified according to git status`)
    for (const f of reported) if (!actual.has(f)) c.errors.push(`filesChanged lists "${f}" but git reports no change to it`)
    for (const f of actual) {
      const why = ctx.forbidden(f)
      if (why) c.errors.push(`"${f}" must not be changed: ${why}. Revert it.`)
    }
    if (actual.size > ctx.maxFilesChanged) c.errors.push(`${actual.size} files changed, limit is ${ctx.maxFilesChanged}; reduce the scope of the fix`)
    if (actual.size === 0) c.errors.push("changesMade is true but the reported git status shows no changes")
    if (ctx.hasTestRunner && commandsRun.length === 0) c.errors.push("commandsRun is empty: run the project's check commands and record them")
    for (const required of ctx.requiredChecks ?? []) {
      const r = required.trim()
      if (!commandsRun.some((x) => x.command.trim() === r || x.command.trim().startsWith(`${r} `))) c.errors.push(`commandsRun does not contain \`${r}\`; run it and report its result`)
    }
    const testTouched = [...actual].some((f) => ctx.isTestFile(f))
    if (ctx.requireTestChange && !testTouched && unresolved.length === 0) c.errors.push("no test file was added or changed; add a regression test (or explain in unresolved[] why none is possible)")
    if (testsAdded.length === 0 && testTouched === false && unresolved.length === 0) c.errors.push("testsAdded is empty; list the tests you added or adjusted")
  }
  if (c.errors.length > 0) return { ok: false, errors: dedupe(c.errors) }
  return {
    ok: true,
    value: {
      version: 1,
      runId: ctx.runId,
      attempt: ctx.attempt,
      summary: summary!,
      filesChanged: [...filesChanged],
      rationale: rationale!,
      alternativesRejected,
      testsAdded,
      commandsRun,
      reproduction,
      risk,
      notesForReviewer,
      changesMade,
      unresolved,
    },
  }
}

export interface ReviewContext {
  runId: string
  attempt: number
  /** Files that appear in the diff or the mapped frames. */
  knownFiles: string[]
}

export function validateReview(input: unknown, ctx: ReviewContext): Validation<ReviewVerdict> {
  if (!isRecord(input)) return { ok: false, errors: ["root must be an object"] }
  const c = new Check(input)
  if (input.version !== 1) c.errors.push("version must be 1")
  const runId = c.str("runId")
  if (runId && runId !== ctx.runId) c.errors.push(`runId must be "${ctx.runId}"`)
  const attempt = c.num("attempt", { min: 1, int: true })
  if (attempt !== undefined && attempt !== ctx.attempt) c.errors.push(`attempt must be ${ctx.attempt}`)
  let verdict = c.oneOf("verdict", VERDICTS)
  const rootCauseAddressed = c.bool("rootCauseAddressed")
  const regressionTestPresent = c.bool("regressionTestPresent")
  const summary = c.str("summary", { min: 10, max: 600 })
  const findings: ReviewVerdict["findings"] = []
  const known = new Set(ctx.knownFiles.map((f) => f.replace(/\\/g, "/")))
  for (const [i, f] of c.objs("findings", { max: 20 }).entries()) {
    const fc = new Check(f)
    const category = fc.oneOf("category", FINDING_CATEGORIES)
    const severity = fc.oneOf("severity", SEVERITIES)
    const file = fc.str("file", { max: 500 })
    const line = fc.num("line", { min: 1, int: true, required: false })
    const message = fc.str("message", { min: 10, max: 1000 })
    const suggestion = fc.str("suggestion", { required: false, max: 1000 })
    if (file && known.size > 0 && !known.has(file.replace(/\\/g, "/"))) fc.errors.push(`file "${file}" is not in the diff or the mapped frames`)
    c.errors.push(...fc.errors.map((e) => `findings[${i}].${e}`))
    if (category && severity && file && message) findings.push({ category, severity, file, line, message, suggestion })
  }
  if (c.errors.length > 0) return { ok: false, errors: dedupe(c.errors) }
  // Consistency is recomputed by the plugin: a blocker can never ride along with an approval.
  const hasBlocker = findings.some((f) => f.severity === "blocker")
  const hasMajor = findings.some((f) => f.severity === "major")
  if (hasBlocker || rootCauseAddressed === false) verdict = "reject"
  else if (verdict === "approve" && (hasMajor || findings.some((f) => f.severity === "minor"))) verdict = hasMajor ? "reject" : "approve_with_nits"
  return {
    ok: true,
    value: { version: 1, runId: ctx.runId, attempt: ctx.attempt, verdict: verdict!, rootCauseAddressed: rootCauseAddressed!, regressionTestPresent: regressionTestPresent!, findings, summary: summary! },
  }
}

export function parseJsonFile<T>(text: string, validate: (v: unknown) => Validation<T>): Validation<T> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, errors: [`not valid JSON: ${(error as Error).message}`] }
  }
  return validate(parsed)
}

const dedupe = (errors: string[]) => [...new Set(errors)]

// ---------- prepare ----------

export interface PrepareContext {
  runId: string
  branchPrefix: string
  baseBranch: string
  /** A branch the run already created (resumed runs must check that one out). */
  existingBranch?: string
  /** The name the configured naming convention produced (new runs must use exactly that). */
  expectedBranch?: string
}

export interface PrepareSubmission {
  version: 1
  runId: string
  stage: "inspect" | "ready"
  repoRoot: string
  previousBranch: string
  previousHeadSha: string
  dirty: boolean
  status?: string
  dirtyFiles?: number
  stashRef?: string
  blocked?: "not-a-repo" | "base-missing"
  blockedDetail?: string
  baseRef?: string
  baseSha?: string
  remoteUrl?: string | null
  branch?: string
  created?: boolean
  toolchain?: { ecosystems: unknown; checks: unknown; setup: Array<{ command: string; exitCode: number; summary: string }> }
  conventionFiles: string[]
  notes: string[]
}

export function validatePrepare(input: unknown, ctx: PrepareContext): Validation<PrepareSubmission> {
  if (!isRecord(input)) return { ok: false, errors: ["root must be an object"] }
  const c = new Check(input)
  if (input.version !== 1) c.errors.push("version must be 1")
  const runId = c.str("runId")
  if (runId && runId !== ctx.runId) c.errors.push(`runId must be "${ctx.runId}"`)
  const stage = c.oneOf("stage", ["inspect", "ready"] as const)
  const blocked = c.oneOf("blocked", ["not-a-repo", "base-missing"] as const, false)
  const blockedDetail = c.str("blockedDetail", { required: false, max: 2000 })
  const repoRoot = c.str("repoRoot", { required: !blocked, max: 1000 })
  const previousBranch = c.str("previousBranch", { required: !blocked, max: 300 })
  const previousHeadSha = c.str("previousHeadSha", { required: !blocked, max: 64 })
  if (previousHeadSha && !isHexSha(previousHeadSha)) c.errors.push("previousHeadSha must be a hex commit id")
  const dirty = c.bool("dirty", !blocked) ?? false
  const status = c.str("status", { required: false, max: 60_000 })
  const dirtyFiles = c.num("dirtyFiles", { min: 0, int: true, required: false })
  const stashRaw = input.stashRef
  if (stashRaw !== undefined && stashRaw !== null && !isHexSha(stashRaw)) c.errors.push("stashRef must be the hex commit id of the stash entry (`git rev-parse stash@{0}`)")
  const stashRef = isHexSha(stashRaw) ? stashRaw : undefined
  const conventionFiles = c.strs("conventionFiles", { max: 20 })
  const notes = c.strs("notes", { max: 20 })
  let baseRef: string | undefined
  let baseSha: string | undefined
  let remoteUrl: string | null | undefined
  let branch: string | undefined
  let created: boolean | undefined
  let toolchain: PrepareSubmission["toolchain"]
  if (stage === "ready" && !blocked) {
    baseRef = c.str("baseRef", { max: 300 })
    baseSha = c.str("baseSha", { max: 64 })
    if (baseSha && !isHexSha(baseSha)) c.errors.push("baseSha must be a hex commit id")
    const ru = input.remoteUrl
    if (ru === null) remoteUrl = null
    else if (ru === undefined) remoteUrl = undefined
    else if (typeof ru === "string") remoteUrl = ru.trim() || null
    else c.errors.push("remoteUrl must be a string or null")
    branch = c.str("branch", { max: 200 })
    created = c.bool("created", false)
    if (branch) {
      if (!branch.startsWith(ctx.branchPrefix)) c.errors.push(`branch must start with "${ctx.branchPrefix}" (got "${branch}")`)
      if (!isValidBranchName(branch)) c.errors.push(`"${branch}" is not a valid branch name`)
      if (isProtectedBranch(branch, ctx.baseBranch)) c.errors.push(`"${branch}" is a protected branch name`)
      if (ctx.existingBranch && branch !== ctx.existingBranch) c.errors.push(`this run already uses branch "${ctx.existingBranch}"; check that one out instead of creating "${branch}"`)
      else if (ctx.expectedBranch && branch !== ctx.expectedBranch) c.errors.push(`the branch name for this run is "${ctx.expectedBranch}" (configured naming convention); use exactly that name (got "${branch}")`)
    }
    if (dirty && !stashRef) c.errors.push("the checkout is dirty but no stashRef was reported: stop and submit stage \"inspect\" so Fixora can ask the user before anything is stashed")
    const tc = c.obj("toolchain")
    if (tc) {
      const setup: Array<{ command: string; exitCode: number; summary: string }> = []
      if (tc.setup !== undefined && !Array.isArray(tc.setup)) c.errors.push("toolchain.setup must be an array")
      for (const raw of Array.isArray(tc.setup) ? tc.setup : []) {
        if (!isRecord(raw) || typeof raw.command !== "string") continue
        setup.push({ command: raw.command, exitCode: typeof raw.exitCode === "number" ? raw.exitCode : 0, summary: typeof raw.summary === "string" ? raw.summary : "" })
      }
      if (!Array.isArray(tc.ecosystems)) c.errors.push("toolchain.ecosystems must be an array of { id, root }")
      if (!Array.isArray(tc.checks)) c.errors.push("toolchain.checks must be an array of { kind, command, cwd?, optional? }")
      toolchain = { ecosystems: tc.ecosystems, checks: tc.checks, setup }
    }
  }
  if (stage === "inspect" && dirty && !status) c.errors.push("stage inspect with a dirty checkout needs the porcelain status text in `status`")
  if (c.errors.length > 0) return { ok: false, errors: dedupe(c.errors) }
  return {
    ok: true,
    value: { version: 1, runId: ctx.runId, stage: stage!, repoRoot: repoRoot ?? "", previousBranch: previousBranch ?? "", previousHeadSha: previousHeadSha ?? "", dirty, status, dirtyFiles, stashRef, blocked, blockedDetail, baseRef, baseSha, remoteUrl, branch, created, toolchain, conventionFiles, notes },
  }
}

// ---------- ticket ----------

export interface TicketSubmission {
  version: 1
  runId: string
  action: "created" | "reused" | "failed"
  key?: string
  url?: string
  error?: string
}

export function validateTicket(input: unknown, ctx: { runId: string }): Validation<TicketSubmission> {
  if (!isRecord(input)) return { ok: false, errors: ["root must be an object"] }
  const c = new Check(input)
  if (input.version !== 1) c.errors.push("version must be 1")
  const runId = c.str("runId")
  if (runId && runId !== ctx.runId) c.errors.push(`runId must be "${ctx.runId}"`)
  const action = c.oneOf("action", ["created", "reused", "failed"] as const)
  const key = c.str("key", { required: action !== "failed", max: 50 })
  if (key && !JIRA_KEY.test(key)) c.errors.push(`key must be a Jira issue key like "APP-123" (got "${key}")`)
  const url = c.str("url", { required: false, max: 1000 })
  if (url && !/^https?:\/\//.test(url)) c.errors.push("url must be an http(s) URL")
  const error = c.str("error", { required: action === "failed", max: 2000 })
  if (c.errors.length > 0) return { ok: false, errors: dedupe(c.errors) }
  return { ok: true, value: { version: 1, runId: ctx.runId, action: action!, key, url, error } }
}

// ---------- publish ----------

export interface PublishContext {
  runId: string
  grants: WorkerGrants
  branch: string
  remote: string
}

export interface PublishSubmission {
  version: 1
  runId: string
  committed?: { sha: string; files: string[] }
  pushed?: { remote: string; branch: string; remoteSha?: string }
  mr?: { url: string; id?: string; provider: "gitlab-mcp" | "github-mcp" | "glab" | "gh"; status?: "draft" | "open" }
  mrSkipped?: { reason: string; compareUrl?: string }
  errors: string[]
}

export function validatePublish(input: unknown, ctx: PublishContext): Validation<PublishSubmission> {
  if (!isRecord(input)) return { ok: false, errors: ["root must be an object"] }
  const c = new Check(input)
  if (input.version !== 1) c.errors.push("version must be 1")
  const runId = c.str("runId")
  if (runId && runId !== ctx.runId) c.errors.push(`runId must be "${ctx.runId}"`)
  const errors = c.strs("errors", { max: 20 })
  let committed: PublishSubmission["committed"]
  const co = c.obj("committed", false)
  if (co) {
    if (!ctx.grants.commit) c.errors.push("committed was reported but commit was not granted in this phase")
    const cc = new Check(co)
    const sha = cc.str("sha", { max: 64 })
    const files = cc.strs("files", { max: 200 })
    if (sha && !isHexSha(sha)) cc.errors.push("sha must be a hex commit id")
    c.errors.push(...cc.errors.map((e) => `committed.${e}`))
    if (sha) committed = { sha, files }
  }
  let pushed: PublishSubmission["pushed"]
  const po = c.obj("pushed", false)
  if (po) {
    if (!ctx.grants.push) c.errors.push("pushed was reported but push was not granted in this phase")
    const pc = new Check(po)
    const remote = pc.str("remote", { max: 100 })
    const branch = pc.str("branch", { max: 200 })
    const remoteSha = pc.str("remoteSha", { required: false, max: 64 })
    if (branch && branch !== ctx.branch) pc.errors.push(`branch must be "${ctx.branch}"`)
    if (remoteSha && !isHexSha(remoteSha)) pc.errors.push("remoteSha must be a hex commit id")
    c.errors.push(...pc.errors.map((e) => `pushed.${e}`))
    if (remote && branch) pushed = { remote, branch, remoteSha }
  }
  let mr: PublishSubmission["mr"]
  const mo = c.obj("mr", false)
  if (mo) {
    if (!ctx.grants.mr) c.errors.push("mr was reported but opening a merge request was not granted in this phase")
    const mc = new Check(mo)
    const url = mc.str("url", { max: 1000 })
    const id = mc.str("id", { required: false, max: 50 })
    const provider = mc.oneOf("provider", ["gitlab-mcp", "github-mcp", "glab", "gh"] as const)
    const status = mc.oneOf("status", ["draft", "open"] as const, false)
    if (url && !isMrUrl(url)) mc.errors.push(`url must be the merge request / pull request URL (got "${url}")`)
    c.errors.push(...mc.errors.map((e) => `mr.${e}`))
    if (url && provider) mr = { url, id: id ?? url.split("/").pop(), provider, status }
  }
  let mrSkipped: PublishSubmission["mrSkipped"]
  const so = c.obj("mrSkipped", false)
  if (so) {
    const sc = new Check(so)
    const reason = sc.str("reason", { max: 2000 })
    const compareUrl = sc.str("compareUrl", { required: false, max: 1000 })
    c.errors.push(...sc.errors.map((e) => `mrSkipped.${e}`))
    if (reason) mrSkipped = { reason, compareUrl }
  }
  if (!committed && !pushed && !mr && !mrSkipped && errors.length === 0) c.errors.push("nothing was reported: include committed / pushed / mr / mrSkipped, or the errors that stopped you")
  if (c.errors.length > 0) return { ok: false, errors: dedupe(c.errors) }
  return { ok: true, value: { version: 1, runId: ctx.runId, committed, pushed, mr, mrSkipped, errors } }
}

// ---------- ops ----------

export const RECOVER_PROVIDERS = ["gitlab-mcp", "github-mcp", "glab", "gh"] as const

/** What the recover worker submits: the listing reply (inline or in a file) and the commit trailers. */
export interface RecoverSubmission {
  version: 1
  requestId: string
  provider: (typeof RECOVER_PROVIDERS)[number]
  remoteUrl?: string
  raw?: unknown
  rawFile?: string
  commits?: string
  commitsFile?: string
  errors: string[]
}

export function validateRecover(input: unknown, ctx: { requestId: string }): Validation<RecoverSubmission> {
  if (!isRecord(input)) return { ok: false, errors: ["root must be an object"] }
  const c = new Check(input)
  if (input.version !== 1) c.errors.push("version must be 1")
  const requestId = c.str("requestId", { max: 100 })
  if (requestId && requestId !== ctx.requestId) c.errors.push(`requestId must be "${ctx.requestId}"`)
  const provider = c.oneOf("provider", RECOVER_PROVIDERS)
  const remoteUrl = c.str("remoteUrl", { required: false, max: 500 })
  const rawFile = c.str("rawFile", { required: false, max: 1000 })
  const commitsFile = c.str("commitsFile", { required: false, max: 1000 })
  const commits = typeof input.commits === "string" ? input.commits.slice(0, 200_000) : undefined
  const errors = c.strs("errors", { max: 20 })
  const hasRaw = input.raw !== undefined && input.raw !== null
  if (!hasRaw && !rawFile && errors.length === 0) c.errors.push("raw (the listing reply) or rawFile (path of the saved reply) is required unless errors[] says why the listing failed")
  if (c.errors.length > 0) return { ok: false, errors: dedupe(c.errors) }
  return { ok: true, value: { version: 1, requestId: ctx.requestId, provider: provider!, remoteUrl, raw: hasRaw ? input.raw : undefined, rawFile, commits, commitsFile, errors } }
}

export const OPS = ["close-loop", "restore", "sync", "close-mr", "jira-comment", "clean", "annotate"] as const
export type Op = (typeof OPS)[number]

export interface OpsSubmission {
  version: 1
  runId?: string
  op: Op
  ok: boolean
  results: Record<string, unknown>
  errors: string[]
}

export function validateOps(input: unknown, ctx: { runId?: string; op?: Op }): Validation<OpsSubmission> {
  if (!isRecord(input)) return { ok: false, errors: ["root must be an object"] }
  const c = new Check(input)
  if (input.version !== 1) c.errors.push("version must be 1")
  const runId = c.str("runId", { required: !!ctx.runId, max: 100 })
  if (ctx.runId && runId && runId !== ctx.runId) c.errors.push(`runId must be "${ctx.runId}"`)
  const op = c.oneOf("op", OPS)
  if (ctx.op && op && op !== ctx.op) c.errors.push(`op must be "${ctx.op}"`)
  const ok = c.bool("ok")
  const results = c.obj("results", false) ?? {}
  const errors = c.strs("errors", { max: 20 })
  if (ok === false && errors.length === 0) c.errors.push("ok is false: say what failed in errors[]")
  if (c.errors.length > 0) return { ok: false, errors: dedupe(c.errors) }
  return { ok: true, value: { version: 1, runId: ctx.runId ?? runId, op: op!, ok: ok!, results, errors } }
}
