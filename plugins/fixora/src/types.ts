// Shared data model for Fixora. Everything here is plain data so the pure modules can be unit-tested
// without the DXcoder host.

export type Source = "sentry" | "crashlytics" | "manual"
export type Language = "dart" | "jvm" | "apple" | "js" | "python" | "go" | "dotnet" | "unknown"
export type Symbolication = "ok" | "minified" | "obfuscated" | "unsymbolicated"

export interface Frame {
  raw: string
  file?: string
  line?: number
  column?: number
  function?: string
  module?: string
  package?: string
  inApp: boolean
}

export interface Crash {
  id: string
  source: Source
  title: string
  exceptionType?: string
  message?: string
  /** Innermost (top) frame first. */
  frames: Frame[]
  language: Language
  platform?: string
  appVersion?: string
  buildNumber?: string
  device?: { model?: string; os?: string; osVersion?: string }
  firstSeen?: string
  lastSeen?: string
  eventCount?: number
  userCount?: number
  url?: string
  rawStackTrace: string
  fingerprint: string
  symbolication: Symbolication
  fetchedAt: string
  extra?: Record<string, unknown>
  /** Firebase app id the crash was fetched from (Crashlytics only). */
  appId?: string
}

/**
 * What Fixora did about a crash: `mr_open` / `merged` / `released` (marked fixed in a release) /
 * `fixed` (finished without an MR) all count as fixed; `reopened` = seen again after a release fix;
 * `mr_closed` = the MR was closed without merging (restart or --force to try again).
 */
export type CrashState = "new" | "in_progress" | "awaiting" | "mr_open" | "mr_closed" | "merged" | "released" | "fixed" | "reopened" | "failed" | "skipped"

/** The fix Fixora already produced for a listed crash (derived, see crashstate.ts). */
export interface CrashFix {
  runId: string
  state: CrashState
  /** Short label for tables and pickers, e.g. "fixed · MR !418 merged", "fixing". */
  label: string
  /** One extra fact worth knowing: reopen history, "still seen", the failure reason. */
  note?: string
  step?: Step
  jiraKey?: string
  jiraUrl?: string
  mrUrl?: string
  mrId?: string
  mrStatus?: "draft" | "open" | "merged" | "closed"
  /** "MR !418" / "PR #12" / "MR", from the provider and id. */
  mrRef?: string
  branch?: string
  /** Release the fix was marked shipped in (`/fixora fixed`). */
  release?: string
  /** When the fix reached its state (MR opened, merged, marked fixed, or the last update). */
  at: string
  /** Fix cycles so far (restarts + 1). */
  attempts?: number
  /** The source still reports the crash after the fix landed. */
  stillSeen?: boolean
  /** How often the crash came back after being marked fixed. */
  reopened?: number
}

export interface CrashSummary {
  source: Source
  id: string
  title: string
  userCount?: number
  eventCount?: number
  lastSeen?: string
  appVersion?: string
  url?: string
  fingerprint?: string
  state?: CrashState
  runId?: string
  /** Present when Fixora already has a run for this crash: links, label, history. */
  fix?: CrashFix
  /** Full reference to start a run with (`source:id`, plus the app for multi-app Crashlytics). */
  ref?: string
  platform?: string
  appId?: string
}

export type Classification = "fixable" | "needs_symbolication" | "third_party_only" | "not_in_repo" | "env_or_data" | "needs_human" | "duplicate_of"
export type Category = "null-deref" | "race" | "state" | "api-contract" | "parsing" | "config" | "ui-lifecycle" | "resource" | "other"
export type RiskLevel = "low" | "medium" | "high"
export type ReopenReason = "incomplete-fix" | "new-code-path" | "regression" | "fix-not-shipped"

export interface Triage {
  version: 1
  runId: string
  classification: Classification
  mappedFrames: Array<{ index: number; file: string; line?: number; function?: string; evidence: string }>
  rootCause: string
  category: Category
  confidence: number
  confidenceReasons: string[]
  suspectCommits: Array<{ sha: string; subject: string; date?: string; why: string }>
  introducedInRelease: string | null
  fixStrategy: string
  alternatives: Array<{ strategy: string; rejectedBecause: string }>
  risk: { level: RiskLevel; notes: string[] }
  suggestedTests: string[]
  relatedCrashes: string[]
  reopenReason?: ReopenReason
  flaggedContent: string[]
}

export interface FixReport {
  version: 1
  runId: string
  attempt: number
  summary: string
  filesChanged: string[]
  rationale: string
  alternativesRejected: Array<{ strategy: string; reason: string }>
  testsAdded: Array<{ file: string; name: string; kind: "regression" | "unit" | "integration" }>
  commandsRun: Array<{ command: string; exitCode: number; durationMs: number; summary: string; kind?: CheckKind; cwd?: string; outputTail?: string }>
  reproduction?: { mode: "test-first" | "fix"; failingBefore?: boolean; passingAfter?: boolean }
  risk: { level: RiskLevel; publicApiChange: boolean; behaviourChange: string; rollback: string }
  notesForReviewer?: string
  changesMade: boolean
  unresolved: string[]
}

export type Verdict = "approve" | "approve_with_nits" | "reject"
export type FindingCategory = "correctness" | "scope" | "risk" | "tests" | "style" | "security"
export type Severity = "blocker" | "major" | "minor"

export interface ReviewFinding {
  category: FindingCategory
  severity: Severity
  file: string
  line?: number
  message: string
  suggestion?: string
}

export interface ReviewVerdict {
  version: 1
  runId: string
  attempt: number
  verdict: Verdict
  rootCauseAddressed: boolean
  regressionTestPresent: boolean
  findings: ReviewFinding[]
  summary: string
}

export type CheckKind = "setup" | "syntax" | "lint" | "typecheck" | "unit" | "integration" | "build"

/** A check the worker runs (reported by the prepare phase, merged with option overrides). */
export interface CheckCommand {
  kind: CheckKind
  command: string
  /** Repo-relative directory ("" = root). */
  cwd?: string
  optional?: boolean
}

export interface CheckResult {
  kind: CheckKind
  command: string
  cwd: string
  exitCode: number
  passed?: number
  failed?: number
  durationMs: number
  outputTail: string
  timedOut?: boolean
  summary: string
}

export interface TestReport {
  diffHash: string
  commands: CheckResult[]
  allPassed: boolean
  preExisting?: string[]
}

export const STEPS = ["detect", "fetch", "prepare", "analyse", "ticket", "fix", "validate", "review", "publish", "close-loop", "restore", "done"] as const
export type Step = (typeof STEPS)[number]

export type RunStatus = "running" | "awaiting-approval" | "failed" | "rejected" | "skipped" | "blocked" | "review-exhausted" | "timeout" | "done" | "cancelled"
export type BlockedReason = "secret" | "limits" | "dirty-worktree" | "forbidden-path" | "not-a-repo" | "base-missing"
export type ApprovalKind = "ticket" | "publish" | "push" | "mr" | "stash" | "delete-branch"
export type ApprovalOutcome = "approved" | "auto" | "rejected" | "skipped"

export interface StepTiming {
  startedAt: string
  endedAt?: string
  durationMs?: number
  attempts: number
  status: "ok" | "failed" | "skipped" | "running"
}

export interface RunFlags {
  dryRun: boolean
  ticket: boolean
  push: boolean
  mr: boolean
  auto: boolean
  force: boolean
  testFirst: boolean
}

/** What the prepare phase reported about the checkout the run works in; restored on every exit path. */
export interface CheckoutState {
  /** True while the run's branch is checked out in the user's repository (restore pending). */
  active: boolean
  previousBranch?: string
  previousHeadSha?: string
  /** Commit id of the stash entry holding the user's uncommitted changes, when any were stashed. */
  stashRef?: string
  preparedAt?: string
  restoredAt?: string
}

export interface Toolchain {
  ecosystems: Array<{ id: string; root: string }>
  checks: CheckCommand[]
  conventionFiles: string[]
}

/** The last accepted change set, derived from the status + diff the worker reported. */
export interface ChangeRecord {
  paths: string[]
  added: number
  deleted: number
  diffHash: string
}

export interface RunRecord {
  version: 1
  runId: string
  source: Source
  crashId: string
  fingerprint: string
  title: string
  originSessionID: string
  /** Directory the originating session works in (the user's checkout); every worker runs there. */
  repo: string
  /** Git top level of that directory as reported by the prepare phase. */
  gitRoot?: string
  createdAt: string
  updatedAt: string
  step: Step
  status: RunStatus
  error?: string
  blockedReason?: BlockedReason
  skipReason?: string
  flags: RunFlags
  base: { remote: string; branch: string; sha?: string; remoteUrl?: string | null }
  branch?: string
  checkout: CheckoutState
  toolchain?: Toolchain
  change?: ChangeRecord
  sessions: { fixer?: string; reviewer?: string }
  jiraKey?: string
  jiraUrl?: string
  mrUrl?: string
  mrId?: string
  mrStatus?: "draft" | "open" | "merged" | "closed"
  mrProvider?: string
  commitShas: string[]
  triage?: Triage
  fix?: FixReport
  tests?: TestReport
  reviews: ReviewVerdict[]
  counters: { fixRounds: number; reviewRounds: number; feedback: number; restarts: number; workerPrompts: number }
  pipeline: {
    analysed: boolean
    ticketed: boolean
    fixed: boolean
    validated: boolean
    reviewed: boolean
    committed: boolean
    pushed: boolean
    mrOpened: boolean
    loopClosed: boolean
  }
  timings: Partial<Record<Step, StepTiming>>
  totalMs?: number
  approvals: Partial<Record<ApprovalKind, ApprovalOutcome>>
  reopened?: { count: number; previousRunId?: string; fixedIn?: string; reason?: ReopenReason }
  folder: string
  /** Free-form, e.g. crash url, platform; kept small. */
  meta?: Record<string, string | number | boolean | null>
}

export interface CrashIndexEntry {
  fingerprint: string
  runIds: string[]
  title?: string
  lastSeen?: string
  fixedIn?: { release: string; platform?: string; markedBy: string; at: string; runId: string }
  reopened: { count: number; lastAt?: string; reason?: ReopenReason }
  ignoreUntil?: string
}

export type WorkerRole = "fixer" | "reviewer" | "lister"
export type WorkerPhase = "crashes" | "crash" | "prepare" | "triage" | "ticket" | "fix" | "feedback" | "review" | "publish" | "close-loop" | "restore" | "sync" | "clean" | "recover"

/** What a worker session may do right now; the plugin tools and the tool hook read this record on every call. */
export interface WorkerGrants {
  commit?: boolean
  push?: boolean
  mr?: boolean
  closeMr?: boolean
  jiraWrite?: boolean
  sourceWrite?: boolean
  deleteBranch?: boolean
}

export interface WorkerInfo {
  /** Absent for the lister. */
  runId?: string
  /** Lister: key of the pending crash list request. */
  requestId?: string
  role: WorkerRole
  /** Confinement root: the repository the session works in. */
  repo: string
  /** The run folder (`<repo>/.dxcoder/fixora/<runId>`), writable in every phase for analysis / plan notes. */
  folder?: string
  phase: WorkerPhase
  grants?: WorkerGrants
  baseBranch?: string
  /** The only branch the worker may push or delete. */
  branch?: string
}

export type ServiceId = "sentry" | "crashlytics" | "jira" | "gitlab" | "github"

export interface DetectedService {
  id: ServiceId
  namespace: string
  serverName: string
  status: string
  toolIds: string[]
  /** Capability → full tool id, e.g. getIssue → "sentry_get_issue_details". */
  capabilities: Record<string, string>
  environment?: Record<string, string>
}

export type Services = Partial<Record<ServiceId, DetectedService>>

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] }
