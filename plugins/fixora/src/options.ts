// Plugin options from opencode.jsonc ("plugins": [{ "package": ..., "options": {...} }]). Invalid values
// stop the command with the error list instead of being silently defaulted.

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
  worker: {
    agent: string
    model?: ModelRef
    shell: Effect3
    maxPhaseMinutes: { triage: number; fix: number; review: number }
  }
  review: { mode: "session" | "quick"; model?: ModelRef }
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
  approvals: "publish" | "each" | "auto"
  mode: "fix" | "test-first"
  jira: {
    project?: string
    issueType: string
    labels: string[]
    transitionOnMr?: string
    ticketOnSkip: boolean
    url?: string
    token?: string
    username?: string
    password?: string
    sslVerify?: boolean
  }
  mr: { draft: boolean; labels: string[]; reviewers: string[]; target?: string; forge?: "gitlab" | "github" }
  sourceWriteBack: boolean
  crashlytics: { appId?: string }
  sentry: { organization?: string; project?: string }
  inAppPackages: string[]
  appPackage?: string
  worktree: { root?: string; keep: "until-merged" | "always" | "never" }
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
  worker: { agent: "build", shell: "allow", maxPhaseMinutes: { triage: 10, fix: 20, review: 10 } },
  review: { mode: "session" },
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
  crashlytics: {},
  sentry: {},
  inAppPackages: [],
  worktree: { keep: "until-merged" },
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
    worker: {
      agent: r.str("worker.agent", d.worker.agent)!,
      model: r.model("worker.model"),
      shell: r.oneOf("worker.shell", ["allow", "deny", "ask"] as const, d.worker.shell),
      maxPhaseMinutes: {
        triage: r.num("worker.maxPhaseMinutes.triage", d.worker.maxPhaseMinutes.triage, { min: 1 }),
        fix: r.num("worker.maxPhaseMinutes.fix", d.worker.maxPhaseMinutes.fix, { min: 1 }),
        review: r.num("worker.maxPhaseMinutes.review", d.worker.maxPhaseMinutes.review, { min: 1 }),
      },
    },
    review: { mode: r.oneOf("review.mode", ["session", "quick"] as const, d.review.mode), model: r.model("review.model") },
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
    approvals: r.oneOf("approvals", ["publish", "each", "auto"] as const, d.approvals),
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
      url: r.str("jira.url"),
      token: r.str("jira.token"),
      username: r.str("jira.username"),
      password: r.str("jira.password"),
      sslVerify: r.present("jira.sslVerify") ? r.bool("jira.sslVerify", true) : undefined,
    },
    mr: {
      draft: r.bool("mr.draft", d.mr.draft),
      labels: r.strs("mr.labels", d.mr.labels),
      reviewers: r.strs("mr.reviewers", d.mr.reviewers),
      target: r.str("mr.target"),
      forge: r.present("mr.forge") ? r.oneOf("mr.forge", ["gitlab", "github"] as const, "gitlab") : undefined,
    },
    sourceWriteBack: r.bool("sourceWriteBack", d.sourceWriteBack),
    crashlytics: { appId: r.str("crashlytics.appId") },
    sentry: { organization: r.str("sentry.organization"), project: r.str("sentry.project") },
    inAppPackages: r.strs("inAppPackages", d.inAppPackages),
    appPackage: r.str("appPackage"),
    worktree: { root: r.str("worktree.root"), keep: r.oneOf("worktree.keep", ["until-merged", "always", "never"] as const, d.worktree.keep) },
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
  return r.errors.length > 0 ? { ok: false, errors: r.errors } : { ok: true, value }
}

function normalizePrefix(p: string) {
  const trimmed = p.replace(/^\/+/, "").replace(/\/+$/, "")
  return `${trimmed || "fixora"}/`
}
