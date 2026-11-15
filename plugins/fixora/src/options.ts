// Plugin options from opencode.jsonc ("plugins": [{ "package": ..., "options": {...} }]). Invalid values
// stop the command with the error list instead of being silently defaulted.

import { unknownBranchPlaceholders } from "./git.js"
import type { Validation } from "./types.js"

export type Effect3 = "allow" | "deny" | "ask"

export interface ModelRef {
  id: string
  providerID: string
  variant?: string
}

export interface FixoraOptions {
  sources: Array<"sentry" | "crashlytics">
  baseBranch: string
  remote: string
  branchPrefix: string
  /**
   * The repository's branch naming convention, applied after `branchPrefix`. Placeholders: `{type}`
   * (`branchNaming.type`), `{ticket}` (the Jira key; the ticket is then created before the branch),
   * `{slug}` (crash title), `{runId}`, `{crashId}`. Without a template the agent infers a name.
   */
  branchNaming: { template?: string; type: string; example?: string }
  worker: {
    agent: string
    model?: ModelRef
    shell: Effect3
    maxPhaseMinutes: { crash: number; prepare: number; triage: number; fix: number; review: number; publish: number; restore: number; list: number }
  }
  review: { model?: ModelRef }
  testCommands: {
    unit?: string
    integration?: string
    lint?: string
    typecheck?: string
    timeoutSec: number
    fullSuiteMaxMinutes: number
  }
  validate: { denyPaths: string[]; maxFilesChanged: number; maxDiffLines: number; requireTestChange: boolean }
  maxFixRounds: number
  maxReviewRounds: number
  confidence: { minToFix: number; minToPublish: number; autoApprove: number }
  approvals: "publish" | "auto"
  mode: "fix" | "test-first"
  jira: {
    project?: string
    issueType: string
    labels: string[]
    transitionOnMr?: string
    ticketOnSkip: boolean
    /** Parent issue key (e.g. "DE-62556"); required when issueType is a sub-task. */
    parent?: string
  }
  mr: { draft: boolean; labels: string[]; reviewers: string[]; target?: string; forge?: "gitlab" | "github" }
  sourceWriteBack: boolean
  /** Firebase app ids ("1:<project>:<platform>:<hash>"); several when one codebase ships to more than one platform. */
  crashlytics: { appIds: string[] }
  sentry: { organization?: string; project?: string }
  inAppPackages: string[]
  appPackage?: string
  /** How long a crash list fetched by the lister session stays valid for the picker. */
  crashes: { cacheMinutes: number }
  batch: { top: number; minUsers: number; maxMinutes: number }
  signoff: boolean
  allowSecretPatterns: string[]
  gitignore: boolean
}

export const DEFAULTS: FixoraOptions = {
  sources: ["sentry", "crashlytics"],
  baseBranch: "main",
  remote: "origin",
  branchPrefix: "fixora/",
  branchNaming: { type: "fix" },
  worker: { agent: "build", shell: "allow", maxPhaseMinutes: { crash: 5, prepare: 10, triage: 10, fix: 20, review: 10, publish: 10, restore: 5, list: 5 } },
  review: {},
  testCommands: { timeoutSec: 600, fullSuiteMaxMinutes: 15 },
  validate: { denyPaths: [], maxFilesChanged: 10, maxDiffLines: 400, requireTestChange: true },
  maxFixRounds: 3,
  maxReviewRounds: 3,
  confidence: { minToFix: 0.4, minToPublish: 0.6, autoApprove: 0.85 },
  approvals: "publish",
  mode: "fix",
  jira: { issueType: "Bug", labels: ["fixora"], transitionOnMr: "In Review", ticketOnSkip: false },
  mr: { draft: true, labels: ["fixora"], reviewers: [] },
  sourceWriteBack: false,
  crashlytics: { appIds: [] },
  sentry: {},
  inAppPackages: [],
  crashes: { cacheMinutes: 5 },
  batch: { top: 5, minUsers: 5, maxMinutes: 90 },
  signoff: false,
  allowSecretPatterns: [],
  gitignore: true,
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

class Reader {
  readonly errors: string[] = []
  constructor(private readonly raw: Record<string, unknown>) {}

  private get(path: string): unknown {
    return path.split(".").reduce<unknown>((acc, key) => (isRecord(acc) ? acc[key] : undefined), this.raw)
  }
  getRaw(path: string): unknown {
    return this.get(path)
  }
  present(path: string) {
    const v = this.get(path)
    return v !== undefined && v !== null
  }

  str(path: string, fallback?: string): string | undefined {
    const v = this.get(path)
    if (v === undefined || v === null) return fallback
    if (typeof v !== "string") this.errors.push(`${path} must be a string`)
    else if (!v.trim()) this.errors.push(`${path} must not be empty`)
    else return v.trim()
    return fallback
  }
  /** A string, or "" / null to disable explicitly (returns ""), or undefined when absent. */
  command(path: string): string | undefined {
    const v = this.get(path)
    if (v === undefined) return undefined
    if (v === null) return ""
    if (typeof v !== "string") {
      this.errors.push(`${path} must be a string, "" or null`)
      return undefined
    }
    return v.trim()
  }
  nullable(path: string): string | null | undefined {
    const v = this.get(path)
    if (v === null) return null
    return this.str(path)
  }
  num(path: string, fallback: number, o: { min?: number; max?: number; int?: boolean } = {}): number {
    const v = this.get(path)
    if (v === undefined || v === null) return fallback
    if (typeof v !== "number" || !Number.isFinite(v)) {
      this.errors.push(`${path} must be a number`)
      return fallback
    }
    if (o.int && !Number.isInteger(v)) this.errors.push(`${path} must be an integer`)
    if (o.min !== undefined && v < o.min) this.errors.push(`${path} must be >= ${o.min}`)
    if (o.max !== undefined && v > o.max) this.errors.push(`${path} must be <= ${o.max}`)
    return v
  }
  bool(path: string, fallback: boolean): boolean {
    const v = this.get(path)
    if (v === undefined || v === null) return fallback
    if (typeof v !== "boolean") {
      this.errors.push(`${path} must be true or false`)
      return fallback
    }
    return v
  }
  strs(path: string, fallback: string[]): string[] {
    const v = this.get(path)
    if (v === undefined || v === null) return fallback
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      this.errors.push(`${path} must be an array of strings`)
      return fallback
    }
    return v as string[]
  }
  oneOf<T extends string>(path: string, allowed: readonly T[], fallback: T): T {
    const v = this.get(path)
    if (v === undefined || v === null) return fallback
    if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
      this.errors.push(`${path} must be one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`)
      return fallback
    }
    return v as T
  }
  model(path: string): ModelRef | undefined {
    const v = this.get(path)
    if (v === undefined || v === null) return undefined
    const parsed = typeof v === "string" ? parseModelRef(v) : isRecord(v) && typeof v.id === "string" && typeof v.providerID === "string" ? { id: v.id, providerID: v.providerID, variant: typeof v.variant === "string" ? v.variant : undefined } : undefined
    if (!parsed) this.errors.push(`${path} must be "<providerID>/<modelID>" or an object { id, providerID }`)
    return parsed
  }
}

export function parseModelRef(text: string): ModelRef | undefined {
  const slash = text.indexOf("/")
  if (slash <= 0 || slash === text.length - 1) return undefined
  return { providerID: text.slice(0, slash), id: text.slice(slash + 1) }
}

export function readOptions(raw: unknown): Validation<FixoraOptions> {
  const r = new Reader(isRecord(raw) ? raw : {})
  const d = DEFAULTS
  const sources = r.strs("sources", d.sources).filter((s): s is "sentry" | "crashlytics" => {
    if (s === "sentry" || s === "crashlytics") return true
    r.errors.push(`sources contains unknown source ${JSON.stringify(s)} (allowed: sentry, crashlytics)`)
    return false
  })
  const value: FixoraOptions = {
    sources,
    baseBranch: r.str("baseBranch", d.baseBranch)!,
    remote: r.str("remote", d.remote)!,
    branchPrefix: normalizePrefix(r.str("branchPrefix", d.branchPrefix)!),
    branchNaming: {
      template: r.str("branchNaming.template")?.trim() || undefined,
      type: r.str("branchNaming.type", d.branchNaming.type)!.trim() || d.branchNaming.type,
      example: r.str("branchNaming.example")?.trim() || undefined,
    },
    worker: {
      agent: r.str("worker.agent", d.worker.agent)!,
      model: r.model("worker.model"),
      shell: r.oneOf("worker.shell", ["allow", "deny", "ask"] as const, d.worker.shell),
      maxPhaseMinutes: {
        crash: r.num("worker.maxPhaseMinutes.crash", d.worker.maxPhaseMinutes.crash, { min: 1 }),
        prepare: r.num("worker.maxPhaseMinutes.prepare", d.worker.maxPhaseMinutes.prepare, { min: 1 }),
        triage: r.num("worker.maxPhaseMinutes.triage", d.worker.maxPhaseMinutes.triage, { min: 1 }),
        fix: r.num("worker.maxPhaseMinutes.fix", d.worker.maxPhaseMinutes.fix, { min: 1 }),
        review: r.num("worker.maxPhaseMinutes.review", d.worker.maxPhaseMinutes.review, { min: 1 }),
        publish: r.num("worker.maxPhaseMinutes.publish", d.worker.maxPhaseMinutes.publish, { min: 1 }),
        restore: r.num("worker.maxPhaseMinutes.restore", d.worker.maxPhaseMinutes.restore, { min: 1 }),
        list: r.num("worker.maxPhaseMinutes.list", d.worker.maxPhaseMinutes.list, { min: 1 }),
      },
    },
    review: { model: r.model("review.model") },
    testCommands: {
      unit: r.command("testCommands.unit"),
      integration: r.command("testCommands.integration"),
      lint: r.command("testCommands.lint"),
      typecheck: r.command("testCommands.typecheck"),
      timeoutSec: r.num("testCommands.timeoutSec", d.testCommands.timeoutSec, { min: 10 }),
      fullSuiteMaxMinutes: r.num("testCommands.fullSuiteMaxMinutes", d.testCommands.fullSuiteMaxMinutes, { min: 0 }),
    },
    validate: {
      denyPaths: r.strs("validate.denyPaths", d.validate.denyPaths),
      maxFilesChanged: r.num("validate.maxFilesChanged", d.validate.maxFilesChanged, { min: 1, int: true }),
      maxDiffLines: r.num("validate.maxDiffLines", d.validate.maxDiffLines, { min: 10, int: true }),
      requireTestChange: r.bool("validate.requireTestChange", d.validate.requireTestChange),
    },
    maxFixRounds: r.num("maxFixRounds", d.maxFixRounds, { min: 0, int: true }),
    maxReviewRounds: r.num("maxReviewRounds", d.maxReviewRounds, { min: 0, int: true }),
    confidence: {
      minToFix: r.num("confidence.minToFix", d.confidence.minToFix, { min: 0, max: 1 }),
      minToPublish: r.num("confidence.minToPublish", d.confidence.minToPublish, { min: 0, max: 1 }),
      autoApprove: r.num("confidence.autoApprove", d.confidence.autoApprove, { min: 0, max: 1 }),
    },
    approvals: r.getRaw("approvals") === "each" ? "publish" : r.oneOf("approvals", ["publish", "auto"] as const, d.approvals),
    mode: r.oneOf("mode", ["fix", "test-first"] as const, d.mode),
    jira: {
      project: r.str("jira.project"),
      issueType: r.str("jira.issueType", d.jira.issueType)!,
      labels: r.strs("jira.labels", d.jira.labels),
      transitionOnMr: (() => {
        const v = r.nullable("jira.transitionOnMr")
        return v === null ? undefined : (v ?? d.jira.transitionOnMr)
      })(),
      ticketOnSkip: r.bool("jira.ticketOnSkip", d.jira.ticketOnSkip),
      parent: r.str("jira.parent"),
    },
    mr: {
      draft: r.bool("mr.draft", d.mr.draft),
      labels: r.strs("mr.labels", d.mr.labels),
      reviewers: r.strs("mr.reviewers", d.mr.reviewers),
      target: r.str("mr.target"),
      forge: r.present("mr.forge") ? r.oneOf("mr.forge", ["gitlab", "github"] as const, "gitlab") : undefined,
    },
    sourceWriteBack: r.bool("sourceWriteBack", d.sourceWriteBack),
    crashlytics: { appIds: readAppIds(r) },
    sentry: { organization: r.str("sentry.organization"), project: r.str("sentry.project") },
    inAppPackages: r.strs("inAppPackages", d.inAppPackages),
    appPackage: r.str("appPackage"),
    crashes: { cacheMinutes: r.num("crashes.cacheMinutes", d.crashes.cacheMinutes, { min: 0 }) },
    batch: {
      top: r.num("batch.top", d.batch.top, { min: 1, int: true }),
      minUsers: r.num("batch.minUsers", d.batch.minUsers, { min: 0, int: true }),
      maxMinutes: r.num("batch.maxMinutes", d.batch.maxMinutes, { min: 1 }),
    },
    signoff: r.bool("signoff", d.signoff),
    allowSecretPatterns: r.strs("allowSecretPatterns", d.allowSecretPatterns),
    gitignore: r.bool("gitignore", d.gitignore),
  }
  for (const p of value.allowSecretPatterns) {
    try {
      new RegExp(p)
    } catch {
      r.errors.push(`allowSecretPatterns contains an invalid regex: ${p}`)
    }
  }
  if (/^(main|master|develop|release|hotfix)\/$/.test(value.branchPrefix)) r.errors.push(`branchPrefix must not be a protected branch name (${value.branchPrefix})`)
  if (value.branchNaming.template) {
    const unknown = unknownBranchPlaceholders(value.branchNaming.template)
    if (unknown.length) r.errors.push(`branchNaming.template: unknown placeholder(s) ${unknown.map((p) => `{${p}}`).join(", ")}; use {type}, {ticket}, {slug}, {runId}, {crashId}`)
    if (!/\{(ticket|slug|runId|crashId)\}/.test(value.branchNaming.template)) r.errors.push("branchNaming.template must contain {ticket}, {slug}, {runId} or {crashId} so every run gets its own branch")
    if (/[\s~^:?*[\\]|\.\.|@\{/.test(value.branchNaming.template)) r.errors.push("branchNaming.template contains characters git does not allow in branch names")
  }
  if (value.jira.parent && !JIRA_KEY.test(value.jira.parent)) r.errors.push(`jira.parent must be an issue key like "DE-62556" (got ${JSON.stringify(value.jira.parent)})`)
  if (/sub-?task/i.test(value.jira.issueType) && !value.jira.parent) r.errors.push(`jira.issueType ${JSON.stringify(value.jira.issueType)} needs "jira": { "parent": "<story key>" }`)
  return r.errors.length > 0 ? { ok: false, errors: r.errors } : { ok: true, value }
}

/** Options earlier versions understood but this version ignores (the agent does that work now). */
const LEGACY_OPTIONS: Array<[path: string, why: string]> = [
  ["worktree", "runs happen in the checkout the session has open; no worktrees are created"],
  ["review.mode", "the review is always an independent agent session"],
  ["jira.url", "Jira is reached only through a Jira MCP server"],
  ["jira.token", "Jira is reached only through a Jira MCP server"],
  ["jira.username", "Jira is reached only through a Jira MCP server"],
  ["jira.password", "Jira is reached only through a Jira MCP server"],
  ["jira.sslVerify", "Jira is reached only through a Jira MCP server"],
]
const LEGACY_VALUES: Array<[path: string, value: unknown, why: string]> = [["approvals", "each", 'treated as "publish": one approval covers the Jira ticket, the push and the merge request']]

/** Human-readable notes about legacy keys present in the raw options (shown by `/fixora doctor` and once per session). */
export function legacyOptionWarnings(raw: unknown): string[] {
  if (!isRecord(raw)) return []
  const get = (path: string) => path.split(".").reduce<unknown>((acc, key) => (isRecord(acc) ? acc[key] : undefined), raw)
  return [
    ...LEGACY_OPTIONS.filter(([path]) => get(path) !== undefined).map(([path, why]) => `\`${path}\` is ignored: ${why}`),
    ...LEGACY_VALUES.filter(([path, value]) => get(path) === value).map(([path, value, why]) => `\`${path}: ${JSON.stringify(value)}\` is ${why}`),
  ]
}

export const JIRA_KEY = /^[A-Z][A-Z0-9_]*-\d+$/
export const FIREBASE_APP_ID = /^\d+:\d+:(android|ios|web|macos|windows|linux):[a-f0-9]+$/i

/** `crashlytics.appId` (string or array) and `crashlytics.appIds` (array), merged, deduplicated, order kept. */
function readAppIds(r: Reader): string[] {
  const out: string[] = []
  for (const path of ["crashlytics.appId", "crashlytics.appIds"] as const) {
    const v = r.getRaw(path)
    if (v === undefined || v === null) continue
    const list = Array.isArray(v) ? v : [v]
    if (!list.every((x) => typeof x === "string")) {
      r.errors.push(`${path} must be a string or an array of strings`)
      continue
    }
    for (const id of list as string[]) {
      const t = id.trim()
      if (!t) continue
      if (!FIREBASE_APP_ID.test(t)) r.errors.push(`${path} contains an invalid Firebase app id ${JSON.stringify(t)} (expected "1:<project number>:<platform>:<hash>")`)
      else if (!out.includes(t)) out.push(t)
    }
  }
  return out
}

function normalizePrefix(p: string) {
  const trimmed = p.replace(/^\/+/, "").replace(/\/+$/, "")
  return `${trimmed || "fixora"}/`
}
