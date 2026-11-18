// `/fixora recover` (pure): rebuilds run records from the merge requests Fixora opened. Every MR
// Fixora creates carries the `fixora` label, a title ending in `(fixes crash <source>:<id>)` and a
// description with a fixed layout (see renderMr); its commits carry `Fixora-Run` /
// `Fixora-Fingerprint` trailers. This module reads those back. Timings, sessions and the checkout
// state are not in an MR and stay empty.

import { parseToolText } from "./mcp.js"
import { isMrUrl, statusFromResult, type MrProvider } from "./mr.js"
import type { Category, CrashIndexEntry, RiskLevel, RunRecord, Source, Verdict } from "./types.js"

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : undefined)

/** One merge request as listed by GitLab / GitHub (MCP or CLI), normalised. */
export interface MrListing {
  url: string
  id?: string
  title: string
  body: string
  status?: "draft" | "open" | "merged" | "closed"
  sourceBranch?: string
  targetBranch?: string
  createdAt?: string
  updatedAt?: string
  mergedAt?: string
  closedAt?: string
  labels: string[]
  sha?: string
  mergeCommitSha?: string
  author?: string
}

const CONTAINER_KEYS = ["merge_requests", "mergeRequests", "pull_requests", "pullRequests", "items", "data", "results", "nodes", "edges", "content", "output", "pages"]

const looksLikeMr = (v: Record<string, unknown>) => typeof v.title === "string" && (str(v.web_url) !== undefined || str(v.html_url) !== undefined || v.iid !== undefined || v.number !== undefined || isMrUrl(v.url))

/**
 * Every merge request in a listing reply, whatever its shape: one page or several, a bare array, a
 * `{ merge_requests: [...] }` / `{ items: [...] }` container, JSON or YAML text, or a GraphQL edge list.
 */
export function normalizeMrList(raw: unknown): MrListing[] {
  const out: MrListing[] = []
  const seen = new Set<string>()
  const push = (mr: MrListing) => {
    const key = mr.url || `${mr.id}:${mr.title}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(mr)
  }
  const walk = (v: unknown, depth: number) => {
    if (depth > 6) return
    if (typeof v === "string") {
      const parsed = parseToolText(v)
      if (parsed !== v && typeof parsed !== "string") walk(parsed, depth + 1)
      return
    }
    if (Array.isArray(v)) {
      for (const e of v) walk(e, depth + 1)
      return
    }
    if (!isRecord(v)) return
    if (looksLikeMr(v)) {
      push(normalizeMr(v))
      return
    }
    if (isRecord(v.node)) {
      walk(v.node, depth + 1)
      return
    }
    for (const k of CONTAINER_KEYS) if (v[k] !== undefined) walk(v[k], depth + 1)
    if (isRecord(v.merge_request)) walk(v.merge_request, depth + 1)
    if (isRecord(v.pull_request)) walk(v.pull_request, depth + 1)
  }
  walk(raw, 0)
  return out
}

function normalizeMr(r: Record<string, unknown>): MrListing {
  const head = isRecord(r.head) ? r.head : {}
  const base = isRecord(r.base) ? r.base : {}
  const author = isRecord(r.author) ? r.author : isRecord(r.user) ? r.user : {}
  const labels = Array.isArray(r.labels) ? r.labels.map((l) => (typeof l === "string" ? l : isRecord(l) ? (str(l.name) ?? str(l.title) ?? "") : "")).filter(Boolean) : typeof r.labels === "string" ? r.labels.split(",").map((s) => s.trim()).filter(Boolean) : []
  const url = str(r.web_url) ?? str(r.html_url) ?? (isMrUrl(r.url) ? r.url : undefined) ?? str(r.permalink) ?? ""
  const id = str(r.iid) ?? str(r.number) ?? (url ? url.split("/").pop() : undefined) ?? str(r.id)
  const mergedAt = str(r.merged_at) ?? str(r.mergedAt)
  const mergeCommit = isRecord(r.mergeCommit) ? str(r.mergeCommit.oid) : undefined
  return {
    url,
    id,
    title: String(r.title ?? ""),
    body: typeof r.description === "string" ? r.description : typeof r.body === "string" ? r.body : "",
    status: statusFromResult(r) ?? (mergedAt ? "merged" : undefined),
    sourceBranch: str(r.source_branch) ?? str(r.sourceBranch) ?? str(r.headRefName) ?? str(head.ref),
    targetBranch: str(r.target_branch) ?? str(r.targetBranch) ?? str(r.baseRefName) ?? str(base.ref),
    createdAt: str(r.created_at) ?? str(r.createdAt),
    updatedAt: str(r.updated_at) ?? str(r.updatedAt),
    mergedAt,
    closedAt: str(r.closed_at) ?? str(r.closedAt),
    labels,
    sha: str(r.sha) ?? str(r.headRefOid) ?? str(head.sha),
    mergeCommitSha: str(r.merge_commit_sha) ?? str(r.mergeCommitSha) ?? mergeCommit,
    author: str(author.username) ?? str(author.login) ?? str(author.name),
  }
}

/** `Fixora-Run` → `Fixora-Fingerprint` pairs from commit messages (`git log --format=%B | grep '^Fixora-'`). */
export function parseTrailers(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!text) return out
  let run: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*Fixora-(Run|Fingerprint):\s*(\S+)\s*$/.exec(line)
    if (!m) continue
    if (m[1] === "Run") run = m[2]
    else if (run && !out.has(run)) out.set(run, m[2]!.toLowerCase())
  }
  return out
}

/** What one Fixora merge request says about its run. */
export interface MrFacts {
  runId: string
  source: Source
  crashId: string
  summary: string
  fingerprintShort?: string
  target?: string
  jiraKey?: string
  jiraUrl?: string
  crashUrl?: string
  exceptionType?: string
  message?: string
  users?: number
  events?: number
  appVersion?: string
  rootCause?: string
  confidence?: number
  category?: Category
  introducedInRelease?: string
  filesChanged: string[]
  rationale?: string
  riskLevel?: RiskLevel
  reviewVerdict?: Verdict
  reviewRounds?: number
  /** `-r<n>` suffix of the branch: the run was restarted n-1 times. */
  restarts: number
}

const SOURCES: Source[] = ["sentry", "crashlytics", "manual"]
const CATEGORIES: Category[] = ["null-deref", "race", "state", "api-contract", "parsing", "config", "ui-lifecycle", "resource", "other"]
const RISKS: RiskLevel[] = ["low", "medium", "high"]
const VERDICTS: Verdict[] = ["approve", "approve_with_nits", "reject"]

const TITLE_RE = /^\s*(?:draft:\s*|wip:\s*)*(.*?)\s*\(fixes crash (sentry|crashlytics|manual):([A-Za-z0-9._@:-]+)\)\s*$/i
const FOOTER_RE = /Generated by Fixora\s*·\s*run\s*`([^`]+)`(?:\s*·\s*fingerprint\s*`([0-9a-f]+)`)?(?:\s*·\s*target\s*`([^`]+)`)?/i

const sections = (body: string): Map<string, string> => {
  const out = new Map<string, string>()
  let name = ""
  let buf: string[] = []
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      if (name) out.set(name, buf.join("\n").trim())
      name = h[1]!.toLowerCase()
      buf = []
    } else buf.push(line)
  }
  if (name) out.set(name, buf.join("\n").trim())
  return out
}

const firstParagraph = (text: string | undefined): string | undefined => {
  if (!text) return undefined
  const para = text.split(/\n\s*\n/)[0]?.trim()
  return para && !para.startsWith("_") ? para.replace(/\s+/g, " ") : undefined
}

const runIdOf = (source: Source, id: string) => `${source}-${id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64)}`

/** Reads a Fixora merge request; undefined when the MR was not generated by Fixora. */
export function parseFixoraMr(mr: MrListing): MrFacts | undefined {
  const title = TITLE_RE.exec(mr.title)
  const footer = FOOTER_RE.exec(mr.body)
  let source: Source | undefined
  let crashId: string | undefined
  let runId: string | undefined
  if (title) {
    source = title[2]!.toLowerCase() as Source
    crashId = title[3]!
    runId = runIdOf(source, crashId)
  } else if (footer) {
    runId = footer[1]!
    const m = /^(sentry|crashlytics|manual)-(.+)$/.exec(runId)
    if (!m) return undefined
    source = m[1] as Source
    crashId = m[2]!
  }
  if (!runId || !source || !crashId || !SOURCES.includes(source)) return undefined
  const s = sections(mr.body)
  const broke = s.get("what broke") ?? ""
  const head = /^\*\*(.+?)\*\*(?::\s*(.*))?$/m.exec(broke)
  const impact = /^- Impact:\s*(\S+)\s+users,\s*(\S+)\s+events(?:\s*\(last seen in ([^)]+)\))?/m.exec(broke)
  const jira = /^- Jira:\s*(?:\[([A-Z][A-Z0-9_]+-\d+)\]\(([^)]+)\)|([A-Z][A-Z0-9_]+-\d+))/m.exec(broke)
  const sourceLine = /^- Source:\s*\w+(?:\s*—\s*(\S+))?/m.exec(broke)
  const root = s.get("root cause") ?? ""
  const conf = /^Confidence:\s*[█░]*\s*(\d+)%(?:\s*·\s*category:\s*([a-z-]+))?(?:\s*·\s*introduced in\s*(.+?))?\s*$/m.exec(root)
  const changed = s.get("what changed") ?? ""
  const files = [...changed.matchAll(/^- `([^`]+)`\s*$/gm)].map((m) => m[1]!)
  const review = /Independent review:\s*\*\*(\w+)\*\*\s*after\s*(\d+)\s*round/i.exec(s.get("review") ?? "")
  const risk = /^Risk:\s*\*\*(\w+)\*\*/m.exec(s.get("risk and rollback") ?? "")
  const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined)
  const category = conf?.[2] && (CATEGORIES as string[]).includes(conf[2]) ? (conf[2] as Category) : undefined
  const riskLevel = risk?.[1] && (RISKS as string[]).includes(risk[1]) ? (risk[1] as RiskLevel) : undefined
  const verdict = review?.[1] && (VERDICTS as string[]).includes(review[1]) ? (review[1] as Verdict) : undefined
  const restart = /-r(\d+)$/.exec(mr.sourceBranch ?? "")
  return {
    runId,
    source,
    crashId,
    summary: (title?.[1] ?? mr.title.replace(/^\s*(draft:\s*)*/i, "")).trim() || runId,
    fingerprintShort: footer?.[2]?.toLowerCase(),
    target: footer?.[3],
    jiraKey: jira?.[1] ?? jira?.[3],
    jiraUrl: jira?.[2],
    crashUrl: sourceLine?.[1] && /^https?:\/\//.test(sourceLine[1]) ? sourceLine[1] : undefined,
    exceptionType: head?.[1],
    message: head?.[2]?.trim() || undefined,
    users: num(impact?.[1]),
    events: num(impact?.[2]),
    appVersion: impact?.[3]?.trim(),
    rootCause: firstParagraph(root),
    confidence: conf ? Number(conf[1]) / 100 : undefined,
    category,
    introducedInRelease: conf?.[3]?.trim(),
    filesChanged: files,
    rationale: firstParagraph(changed),
    riskLevel,
    reviewVerdict: verdict,
    reviewRounds: review ? Number(review[2]) : undefined,
    restarts: restart ? Math.max(0, Number(restart[1]) - 1) : 0,
  }
}

export interface Candidate {
  mr: MrListing
  facts: MrFacts
}

export interface Skipped {
  mr: MrListing
  reason: string
}

const RANK: Record<string, number> = { merged: 3, open: 2, draft: 2, closed: 1 }

/**
 * One run per run id: the merged MR wins, else the open one, else the newest closed one (a restart
 * closes the previous MR and opens a new one on a `-r<n>` branch). The rest are reported as skipped.
 */
export function rankCandidates(mrs: MrListing[], o: { label?: string }): { picks: Candidate[]; skipped: Skipped[] } {
  const byRun = new Map<string, Candidate[]>()
  const skipped: Skipped[] = []
  const wanted = o.label?.toLowerCase()
  for (const mr of mrs) {
    const facts = parseFixoraMr(mr)
    // Without a label filter the listing holds every MR of the project: foreign ones are simply not Fixora's, not worth a line each.
    const labelled = wanted !== undefined && mr.labels.some((l) => l.toLowerCase() === wanted)
    if (!facts) {
      if (labelled) skipped.push({ mr, reason: "not generated by Fixora (title / description do not match)" })
      continue
    }
    const list = byRun.get(facts.runId) ?? []
    list.push({ mr, facts })
    byRun.set(facts.runId, list)
  }
  const picks: Candidate[] = []
  for (const list of byRun.values()) {
    list.sort((a, b) => (RANK[b.mr.status ?? ""] ?? 0) - (RANK[a.mr.status ?? ""] ?? 0) || (b.mr.updatedAt ?? b.mr.createdAt ?? "").localeCompare(a.mr.updatedAt ?? a.mr.createdAt ?? ""))
    picks.push(list[0]!)
    for (const other of list.slice(1)) skipped.push({ mr: other.mr, reason: `superseded by ${list[0]!.mr.url || "the newer merge request"} for run ${other.facts.runId}` })
  }
  picks.sort((a, b) => (b.mr.updatedAt ?? b.mr.createdAt ?? "").localeCompare(a.mr.updatedAt ?? a.mr.createdAt ?? ""))
  return { picks, skipped }
}

export interface RebuildInput {
  candidate: Candidate
  repo: string
  sessionID: string
  provider: MrProvider
  remote: string
  remoteUrl?: string
  baseBranch: string
  /** Full fingerprints by run id (commit trailers). */
  trailers: Map<string, string>
  at: string
  /** The run folder (`<repo>/.dxcoder/fixora/<runId>`). */
  folder: string
}

/** A finished run record rebuilt from one merge request. Unknown facts stay empty; `meta.recoveredFrom` marks it. */
export function rebuildRun(i: RebuildInput): RunRecord {
  const { mr, facts } = i.candidate
  const full = i.trailers.get(facts.runId)
  const fingerprint = full ?? facts.fingerprintShort ?? ""
  const createdAt = mr.createdAt ?? i.at
  const updatedAt = mr.mergedAt ?? mr.closedAt ?? mr.updatedAt ?? createdAt
  const status = mr.status === "draft" || mr.status === "open" || mr.status === "merged" || mr.status === "closed" ? mr.status : "open"
  const run: RunRecord = {
    version: 1,
    runId: facts.runId,
    source: facts.source,
    crashId: facts.crashId,
    fingerprint,
    title: facts.exceptionType && facts.message ? `${facts.exceptionType}: ${facts.message}`.slice(0, 160) : facts.exceptionType ?? facts.summary,
    originSessionID: i.sessionID,
    repo: i.repo,
    createdAt,
    updatedAt,
    step: "done",
    status: "done",
    flags: { dryRun: false, ticket: !!facts.jiraKey, push: true, mr: true, auto: false, force: false, testFirst: false },
    base: { remote: i.remote, branch: mr.targetBranch ?? facts.target ?? i.baseBranch, remoteUrl: i.remoteUrl ?? null },
    branch: mr.sourceBranch,
    checkout: { active: false },
    sessions: {},
    jiraKey: facts.jiraKey,
    jiraUrl: facts.jiraUrl,
    mrUrl: mr.url,
    mrId: mr.id,
    mrStatus: status,
    mrProvider: i.provider,
    commitShas: [mr.sha, mr.mergeCommitSha].filter((s): s is string => !!s),
    reviews: facts.reviewVerdict ? [{ version: 1, runId: facts.runId, attempt: 1, verdict: facts.reviewVerdict, rootCauseAddressed: facts.reviewVerdict !== "reject", regressionTestPresent: false, findings: [], summary: "recovered from the merge request; findings not available" }] : [],
    counters: { fixRounds: 0, reviewRounds: Math.max(0, (facts.reviewRounds ?? 1) - 1), feedback: 0, restarts: facts.restarts, workerPrompts: 0 },
    pipeline: { analysed: !!facts.rootCause, ticketed: !!facts.jiraKey, fixed: true, validated: true, reviewed: !!facts.reviewVerdict, committed: true, pushed: true, mrOpened: true, loopClosed: !!facts.jiraKey },
    timings: {},
    approvals: { publish: "approved", ...(facts.jiraKey ? { ticket: "approved" as const } : {}) },
    folder: i.folder,
    meta: {
      recoveredFrom: mr.url,
      recoveredAt: i.at,
      fingerprintPartial: !full && !!facts.fingerprintShort,
      ...(mr.mergedAt ? { mergedAt: mr.mergedAt } : {}),
      ...(facts.crashUrl ? { crashUrl: facts.crashUrl } : {}),
      ...(facts.appVersion ? { appVersion: facts.appVersion } : {}),
      ...(facts.users !== undefined ? { users: facts.users } : {}),
      ...(facts.events !== undefined ? { events: facts.events } : {}),
      ...(mr.author ? { mrAuthor: mr.author } : {}),
    },
  }
  if (facts.rootCause) {
    run.triage = {
      version: 1,
      runId: facts.runId,
      classification: "fixable",
      mappedFrames: [],
      rootCause: facts.rootCause,
      category: facts.category ?? "other",
      confidence: facts.confidence ?? 0,
      confidenceReasons: ["recovered from the merge request description"],
      suspectCommits: [],
      introducedInRelease: facts.introducedInRelease ?? null,
      fixStrategy: facts.rationale ?? facts.summary,
      alternatives: [],
      risk: { level: facts.riskLevel ?? "medium", notes: [] },
      suggestedTests: [],
      relatedCrashes: [],
      flaggedContent: [],
    }
  }
  if (facts.filesChanged.length || facts.rationale) {
    run.fix = {
      version: 1,
      runId: facts.runId,
      attempt: 1,
      summary: facts.summary,
      filesChanged: facts.filesChanged,
      rationale: facts.rationale ?? facts.summary,
      alternativesRejected: [],
      testsAdded: [],
      commandsRun: [],
      risk: { level: facts.riskLevel ?? "medium", publicApiChange: false, behaviourChange: "", rollback: "revert the merge request" },
      changesMade: true,
      unresolved: [],
    }
  }
  return run
}

/** The crash index entry of a recovered run; only a full fingerprint (commit trailer) can be matched later, so partial ones are not indexed. */
export function rebuildIndex(run: RunRecord, existing?: CrashIndexEntry): CrashIndexEntry | undefined {
  if (!run.fingerprint || run.meta?.fingerprintPartial === true) return undefined
  const entry: CrashIndexEntry = existing ?? { fingerprint: run.fingerprint, runIds: [], reopened: { count: 0 } }
  if (!entry.runIds.includes(run.runId)) entry.runIds.push(run.runId)
  entry.title = entry.title ?? run.title
  return entry
}

// ---------- report ----------

export interface RecoverOutcome {
  /** Undefined when every merge request was listed (`--all`). */
  label?: string
  provider: MrProvider
  listed: number
  recovered: RunRecord[]
  /** Runs already in storage (kept unless --force). */
  known: Array<{ runId: string; mrUrl: string }>
  skipped: Skipped[]
  errors: string[]
  dryRun: boolean
}

const mrRef = (run: Pick<RunRecord, "mrId" | "mrProvider">) => (run.mrId ? (/(gitlab|glab)/.test(run.mrProvider ?? "") ? `!${run.mrId}` : /(github|gh)/.test(run.mrProvider ?? "") ? `#${run.mrId}` : run.mrId) : "MR")
const cell = (s: string | number | null | undefined) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
const STATUS_WORD: Record<string, string> = { merged: "merged", open: "open", draft: "draft", closed: "closed" }

/** Markdown the origin agent presents: tally line, one row per recovered run, what was skipped, what to do next. */
export function renderRecoverReport(o: RecoverOutcome): string {
  const verb = o.dryRun ? "would recover" : "recovered"
  const L: string[] = [`### Fixora · ${verb} ${o.recovered.length} run(s) from merge requests`, ""]
  const by: Record<string, number> = {}
  for (const r of o.recovered) by[r.mrStatus ?? "open"] = (by[r.mrStatus ?? "open"] ?? 0) + 1
  const parts = ["merged", "open", "draft", "closed"].filter((s) => by[s]).map((s) => `${by[s]} ${STATUS_WORD[s]}`)
  const tally = [`${o.listed} merge request(s) ${o.label ? `labelled \`${o.label}\`` : "listed (no label filter)"} via ${o.provider}`, `${o.recovered.length} ${verb}${parts.length ? ` (${parts.join(" · ")})` : ""}`]
  if (o.known.length) tally.push(`${o.known.length} already known (kept; \`--force\` overwrites)`)
  if (o.skipped.length) tally.push(`${o.skipped.length} skipped`)
  L.push(`${tally.join(" · ")}.`, "")
  if (o.recovered.length) {
    const full = o.recovered.filter((r) => r.fingerprint && r.meta?.fingerprintPartial !== true).length
    const withJira = o.recovered.filter((r) => r.jiraKey).length
    const withCause = o.recovered.filter((r) => r.triage).length
    L.push(`Details found: ${withJira}/${o.recovered.length} Jira tickets · ${withCause}/${o.recovered.length} root causes · ${full}/${o.recovered.length} full fingerprints (commit trailers)${full < o.recovered.length ? " — the rest keep the 12-character prefix from the MR, enough for the crash list, not for reopen detection" : ""}.`, "")
    L.push("| Run | Crash | Jira | MR | Branch | Recovered |", "|---|---|---|---|---|---|")
    for (const r of o.recovered) {
      const facts: string[] = []
      if (r.triage) facts.push(`root cause${r.triage.confidence ? ` ${Math.round(r.triage.confidence * 100)}%` : ""}`)
      if (r.fix?.filesChanged.length) facts.push(`${r.fix.filesChanged.length} file(s)`)
      if (r.reviews[0]) facts.push(`review ${r.reviews[0].verdict}`)
      if (r.fingerprint) facts.push(r.meta?.fingerprintPartial === true ? "fingerprint (prefix)" : "fingerprint")
      if (r.counters.restarts) facts.push(`attempt ${r.counters.restarts + 1}`)
      L.push(`| \`${r.runId}\` | ${cell(r.title).slice(0, 60)} | ${r.jiraKey ? (r.jiraUrl ? `[${r.jiraKey}](${r.jiraUrl})` : r.jiraKey) : "—"} | [${mrRef(r)} ${r.mrStatus ?? "open"}](${r.mrUrl}) | \`${r.branch ?? "—"}\` | ${facts.join(" · ") || "links only"} |`)
    }
    L.push("")
  }
  if (o.known.length) L.push(`Already known: ${o.known.map((k) => `\`${k.runId}\``).join(", ")}.`, "")
  if (o.skipped.length) {
    L.push("Skipped:", "")
    for (const s of o.skipped.slice(0, 20)) L.push(`- ${s.mr.url || s.mr.title}: ${s.reason}`)
    if (o.skipped.length > 20) L.push(`- … ${o.skipped.length - 20} more`)
    L.push("")
  }
  if (o.errors.length) L.push(`Errors: ${o.errors.join("; ")}`, "")
  if (o.label && o.recovered.length === 0 && o.known.length === 0) L.push(`_Nothing labelled \`${o.label}\`? Merge requests opened without the label are found with \`/fixora recover --all\` (every merge request is listed and Fixora picks its own by title and description)._`, "")
  L.push("_Timings, worker sessions, test results and the checkout state are not stored in a merge request and were left empty._", "")
  const next: string[] = o.dryRun ? ["`/fixora recover` to write these records"] : ["`/fixora status` shows the runs", "`/fixora sync` refreshes MR states"]
  const merged = o.recovered.filter((r) => r.mrStatus === "merged")
  if (!o.dryRun && merged.length) next.push(`\`/fixora fixed ${merged[0]!.runId} --release <version>\` records the release of a merged fix`)
  L.push(`Next: ${next.join(" · ")}`)
  return L.join("\n")
}
