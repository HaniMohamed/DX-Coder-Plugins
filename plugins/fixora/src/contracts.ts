// Dependency-free validators for the worker's structured outputs. Errors are fed back to the model
// verbatim, so they say what is wrong and what is expected.

import { SECRET_PATTERNS } from "./secrets.js"
import type { Category, Classification, FindingCategory, FixReport, ReviewVerdict, RiskLevel, Severity, Triage, Validation, Verdict } from "./types.js"

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string")

export const CLASSIFICATIONS: Classification[] = ["fixable", "needs_symbolication", "third_party_only", "not_in_repo", "env_or_data", "needs_human", "duplicate_of"]
export const CATEGORIES: Category[] = ["null-deref", "race", "state", "api-contract", "parsing", "config", "ui-lifecycle", "resource", "other"]
export const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high"]
export const VERDICTS: Verdict[] = ["approve", "approve_with_nits", "reject"]
export const FINDING_CATEGORIES: FindingCategory[] = ["correctness", "scope", "risk", "tests", "style", "security"]
export const SEVERITIES: Severity[] = ["blocker", "major", "minor"]
const MAX_TEXT = 4000

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
  /** Returns true when the repo-relative path exists in the worktree. */
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
    if (file && !ctx.fileExists(file)) fc.errors.push(`file "${file}" does not exist in the worktree (use a repo-relative path)`)
    c.errors.push(...fc.errors.map((e) => `mappedFrames[${i}].${e}`))
    if (fc.errors.length === 0 && index !== undefined && file && evidence) mapped.push({ index, file, line, function: fn, evidence })
  }
  if (classification === "fixable" && mapped.length === 0) c.errors.push("a fixable crash needs at least one mappedFrames entry whose file exists in the worktree")
  const suspect: Triage["suspectCommits"] = []
  for (const [i, s] of c.objs("suspectCommits", { max: 10 }).entries()) {
    const sc = new Check(s)
    const sha = sc.str("sha", { max: 64 })
    const subject = sc.str("subject", { max: 300 })
    const date = sc.str("date", { required: false, max: 40 })
    const why = sc.str("why", { min: 5 })
    if (sha && !/^[0-9a-f]{7,40}$/i.test(sha)) sc.errors.push("sha must be a hex commit id")
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
  /** Paths changed in the worktree according to git (repo-relative). */
  changedFiles: string[]
  forbidden: (path: string) => string | undefined
  maxFilesChanged: number
  hasTestRunner: boolean
  requireTestChange: boolean
  isTestFile: (path: string) => boolean
  testFirst: boolean
}

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
    c.errors.push(...rc.errors.map((e) => `commandsRun[${i}].${e}`))
    if (command && exitCode !== undefined && durationMs !== undefined && summaryText) commandsRun.push({ command, exitCode, durationMs, summary: summaryText })
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
    for (const f of actual) if (!reported.has(f)) c.errors.push(`filesChanged is missing "${f}" which is modified in the worktree (git status)`)
    for (const f of reported) if (!actual.has(f)) c.errors.push(`filesChanged lists "${f}" but git reports no change to it`)
    for (const f of actual) {
      const why = ctx.forbidden(f)
      if (why) c.errors.push(`"${f}" must not be changed: ${why}. Revert it.`)
    }
    if (actual.size > ctx.maxFilesChanged) c.errors.push(`${actual.size} files changed, limit is ${ctx.maxFilesChanged}; reduce the scope of the fix`)
    if (actual.size === 0) c.errors.push("changesMade is true but the worktree has no changes")
    if (ctx.hasTestRunner && commandsRun.length === 0) c.errors.push("commandsRun is empty: run the project's check commands and record them")
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
