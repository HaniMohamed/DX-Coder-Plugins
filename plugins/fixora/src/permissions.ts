// Permission rules for the worker sessions (last matching rule wins, wildcards allowed) plus the
// tool-hook policy that decides, per phase, which git verbs, MCP tools and CLIs a worker may use.
// The static session rules keep the host from prompting; the hook narrows them to the current phase.

import { isProtectedBranch, isValidBranchName } from "./git.js"
import { classifyTool, isWriteTool } from "./mcp.js"
import type { CheckCommand, Services, WorkerInfo, WorkerPhase, WorkerRole } from "./types.js"

export interface Rule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

export const WRITE_TOOLS = new Set(["write", "edit", "patch", "multiedit"])
export const SHELL_TOOLS = new Set(["shell", "bash"])

/** Paths a worker may never change, regardless of how it tries. */
export const FORBIDDEN_GLOBS = [
  ".git/**",
  ".github/**",
  ".gitlab-ci.yml",
  ".gitlab/**",
  "Jenkinsfile",
  "azure-pipelines.yml",
  ".circleci/**",
  "bitrise.yml",
  "codemagic.yaml",
  "fastlane/**",
  "**/*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock*",
  "Podfile.lock",
  "pubspec.lock",
  "Cargo.lock",
  "go.sum",
  ".env*",
  "**/.env*",
  "**/*.pem",
  "**/*.p12",
  "**/*.keystore",
  "**/*.jks",
  "**/*.g.dart",
  "**/*.freezed.dart",
  "**/*.pb.*",
  "**/generated/**",
  "**/__generated__/**",
  "**/*.generated.*",
  "node_modules/**",
  "**/node_modules/**",
  "build/**",
  "dist/**",
  "Pods/**",
  "**/Pods/**",
  ".dart_tool/**",
  "**/.dart_tool/**",
  "vendor/**",
  ".dxcoder/**",
]

/** Commands no worker may run in any phase (network, privilege, destruction, publishing). */
export const SHELL_DENY_ALWAYS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/,
  /\brm\s+-r[a-zA-Z]*\s+(\/|~|\.|\.\.)(\s|$)/,
  /\b(curl|wget|ssh|scp|sftp|nc|ncat|telnet)\b/,
  /\bsudo\b|\bsu\s+-/,
  /\b(npm|pnpm|yarn|bun)\s+publish\b/,
  /\b(cargo|pod|gem|twine)\s+(publish|push|trunk)\b/,
  /\bchmod\s+[0-7]*7[0-7]*\s|\bchown\b/,
  /\bprintenv\b|(^|[;&|]\s*)env\s*$|(^|[;&|]\s*)set\s*$/,
  /\bcat\s+[^|;&]*\.(env|netrc|pem|p12|keystore)\b/,
  />\s*\/dev\/(sd|disk)/,
  /\bdd\s+if=/,
  /\bmkfs\b|\bdiskutil\b|\bshutdown\b|\breboot\b|\bkillall\b/,
]

/** Static session rules: closed by default, then re-open what the role needs. The hook narrows per phase. */
export function workerRules(input: { role: WorkerRole; shell: "allow" | "deny" | "ask"; sourceNamespaces: string[]; jiraNamespace?: string; forgeNamespaces: string[] }): Rule[] {
  const rules: Rule[] = [
    { action: "*", resource: "*", effect: "deny" },
    ...["read", "glob", "grep", "list", "skill", "todowrite", "todoread", "codesearch", "lsp"].map((a) => ({ action: a, resource: "*", effect: "allow" as const })),
    { action: "question", resource: "*", effect: input.role === "fixer" ? "allow" : "deny" },
    { action: "read", resource: "*.env", effect: "deny" },
    { action: "read", resource: "*.env.*", effect: "deny" },
    { action: "edit", resource: "*", effect: "allow" },
    { action: "edit", resource: "../*", effect: "deny" },
    { action: "edit", resource: "/*", effect: "deny" },
    { action: "edit", resource: ".git/*", effect: "deny" },
    ...(input.role === "fixer" ? [] : [{ action: "edit", resource: "*", effect: "deny" as const }]),
    { action: "external_directory", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: input.role === "lister" ? "deny" : input.shell },
    // MCP tools are CodeMode tools on this host: the model reaches them only through `execute`
    // (`tools.<server>.<tool>(input)`); hiding `execute` would hide every MCP tool.
    { action: "execute", resource: "*", effect: "allow" },
    { action: "fixora_*", resource: "*", effect: "allow" },
    { action: "fixora_start", resource: "*", effect: "deny" },
  ]
  for (const ns of input.sourceNamespaces) rules.push({ action: `${ns}_*`, resource: "*", effect: "allow" })
  if (input.jiraNamespace) rules.push({ action: `${input.jiraNamespace}_*`, resource: "*", effect: "allow" })
  for (const ns of input.forgeNamespaces) rules.push({ action: `${ns}_*`, resource: "*", effect: "allow" })
  for (const a of ["webfetch", "websearch", "subagent", "task", "opencode_*"]) rules.push({ action: a, resource: "*", effect: "deny" })
  return rules
}

export function globToRegExp(glob: string): RegExp {
  let re = "^"
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/"
        re += slashAfter ? "(?:.*/)?" : ".*"
        i += slashAfter ? 2 : 1
      } else re += "[^/]*"
    } else if (ch === "?") re += "[^/]"
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`${re}$`)
}

export function forbiddenReason(relativePath: string, extraDeny: string[] = []): string | undefined {
  const p = relativePath.replace(/\\/g, "/").replace(/^\.\//, "")
  for (const g of [...FORBIDDEN_GLOBS, ...extraDeny]) if (globToRegExp(g).test(p)) return `matches protected pattern ${g}`
  return undefined
}

const isAbsolutePath = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\")

export function normalizePath(p: string): string {
  const parts: string[] = []
  const slashed = p.replace(/\\/g, "/")
  const drive = /^[A-Za-z]:/.exec(slashed)?.[0] ?? ""
  for (const part of slashed.slice(drive.length).split("/")) {
    if (!part || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `${drive}/${parts.join("/")}`.replace(/\/+$/, "") || "/"
}

export function resolveInside(candidate: string, directory: string): string {
  return normalizePath(isAbsolutePath(candidate) ? candidate : `${directory.replace(/[\\/]+$/, "")}/${candidate}`)
}

const inside = (abs: string, root: string) => abs === root || abs.startsWith(`${root}/`)

/**
 * Changes that dependency resolution / tool caches produce on their own (lockfiles, .dart_tool,
 * node_modules…). They are never part of the fix: ignored in the change set, the diff, the commit
 * and the dirty-checkout check. A fix that genuinely needs a lockfile change is still refused by
 * FORBIDDEN_GLOBS, by design.
 */
export const GENERATED_CHANGE_GLOBS = ["**/*.lock", "package-lock.json", "**/package-lock.json", "yarn.lock", "**/yarn.lock", "pnpm-lock.yaml", "**/pnpm-lock.yaml", "bun.lock*", "**/bun.lock*", "Podfile.lock", "**/Podfile.lock", "pubspec.lock", "**/pubspec.lock", "Cargo.lock", "go.sum", ".dart_tool/**", "**/.dart_tool/**", "**/.flutter-plugins*", "**/.packages", "node_modules/**", "**/node_modules/**", "build/**", "**/build/**", "**/.pub-cache/**", "**/.gradle/**", "**/Pods/**", "**/.dxcoder/**"]
const GENERATED = GENERATED_CHANGE_GLOBS.map(globToRegExp)
export const isGeneratedChange = (path: string) => {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "")
  return GENERATED.some((re) => re.test(p))
}

// ---------- write guard ----------

export interface WriteGuardInput {
  tool: string
  input: unknown
  /** The repository the worker works in (confinement root). */
  repo: string
  /** The session's working directory (resolves relative paths); normally equals `repo`. */
  directory: string
  phase: WorkerPhase
  /** The run folder: writable in every phase (analysis.md, fix-plan.md). */
  folder?: string
  extraDeny?: string[]
}

const WRITABLE_PHASES = new Set<WorkerPhase>(["fix", "feedback"])

/** Returns an error message when a write/edit/patch call must be refused, otherwise undefined. */
export function guardWorkerWrite(input: WriteGuardInput): string | undefined {
  if (!WRITE_TOOLS.has(input.tool)) return undefined
  const repo = normalizePath(input.repo)
  const folder = input.folder ? normalizePath(input.folder) : undefined
  const raw = input.input as Record<string, unknown> | undefined
  const candidates: string[] = []
  for (const key of ["path", "filePath", "file_path", "file"]) if (typeof raw?.[key] === "string") candidates.push(raw[key] as string)
  if (input.tool === "patch") {
    const patch = typeof raw?.patch === "string" ? raw.patch : typeof raw?.patchText === "string" ? raw.patchText : ""
    for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) candidates.push(m[1]!.trim())
    for (const m of patch.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)) candidates.push(m[1]!.trim())
    if (candidates.length === 0) return "fixora worker: patch without recognisable file paths is not allowed; use edit or write"
  }
  if (candidates.length === 0) return `fixora worker: ${input.tool} call without a path is not allowed`
  for (const c of candidates) {
    const absolute = resolveInside(c, input.directory)
    if (folder && inside(absolute, folder)) continue // notes in the run folder are fine in every phase
    if (!WRITABLE_PHASES.has(input.phase)) return `fixora worker: the ${input.phase} phase is read-only; no file changes are allowed (notes go into the run folder)`
    if (!inside(absolute, repo)) return `fixora worker: writing outside the repository is not allowed (${c}). Only ${repo} may be modified.`
    const rel = absolute === repo ? "" : absolute.slice(repo.length + 1)
    const why = forbiddenReason(rel, input.extraDeny)
    if (why) return `fixora worker: ${rel} must not be changed (${why})`
  }
  return undefined
}

// ---------- shell guard ----------

export interface GitInvocation {
  verb: string
  args: string[]
  /** `-C <dir>` when given. */
  dir?: string
}

/** Every `git …` invocation in a command line (segments split on `;`, `&&`, `||`, `|`, newlines). */
export function parseGitInvocations(command: string): GitInvocation[] {
  const out: GitInvocation[] = []
  for (const segment of command.split(/\n|;|&&|\|\||\|/)) {
    const words = tokens(segment)
    const at = words.findIndex((w) => w === "git")
    if (at < 0) continue
    const rest = words.slice(at + 1)
    let dir: string | undefined
    let i = 0
    while (i < rest.length && rest[i]!.startsWith("-")) {
      const w = rest[i]!
      if (w === "-C") {
        dir = rest[i + 1]
        i += 2
      } else if (w === "-c") i += 2
      else if (w.startsWith("-C")) {
        dir = w.slice(2)
        i++
      } else i++
    }
    const verb = rest[i] ?? ""
    out.push({ verb, args: rest.slice(i + 1), dir })
  }
  return out
}

function tokens(segment: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  for (const m of segment.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? "")
  return out
}

const READ_GIT_VERBS = new Set(["log", "blame", "show", "grep", "ls-files", "diff", "status", "rev-parse", "describe", "cat-file", "ls-tree", "shortlog", "name-rev", "for-each-ref", "reflog", "rev-list", "ls-remote", "merge-base", "symbolic-ref", "var", "version", "check-ignore", "count-objects"])

const hasFlag = (args: string[], ...flags: string[]) => args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith("--") && a.startsWith(`${f}=`)))

/** Read-only forms of verbs that can also write (branch, remote, config, tag, stash, add). */
function readOnlyForm(inv: GitInvocation): boolean {
  const a = inv.args
  switch (inv.verb) {
    case "branch":
      return !hasFlag(a, "-d", "-D", "-m", "-M", "-f", "--force", "--delete", "--move", "--copy", "-c", "-C", "-u", "--set-upstream-to", "--unset-upstream", "--edit-description") && (a.length === 0 || hasFlag(a, "--list", "-l", "-r", "-a", "--show-current", "--contains", "--merged", "--no-merged", "-v", "-vv", "--points-at") || a.every((x) => x.startsWith("-")))
    case "remote":
      return a.length === 0 || a[0] === "-v" || a[0] === "get-url" || a[0] === "show"
    case "config":
      return hasFlag(a, "--get", "--list", "-l", "--get-all", "--get-regexp")
    case "tag":
      return a.length === 0 || hasFlag(a, "--list", "-l", "--contains", "--points-at", "-n")
    case "stash":
      return a[0] === "list" || a[0] === "show"
    case "add":
      return hasFlag(a, "-N", "--intent-to-add") && !hasFlag(a, "-A", "--all")
    default:
      return READ_GIT_VERBS.has(inv.verb)
  }
}

export interface ShellPolicyInput {
  command: string
  worker: WorkerInfo
  /** Check commands the reviewer may run (prefix match). */
  checkCommands?: string[]
}

/** The git policy per phase: returns the refusal reason for one invocation. */
export function judgeGit(inv: GitInvocation, w: WorkerInfo): string | undefined {
  const a = inv.args
  if (readOnlyForm(inv)) return undefined
  const base = w.baseBranch ?? "main"
  const deny = (why: string) => `fixora worker: \`git ${inv.verb} ${a.join(" ")}\`.trim() is not allowed in the ${w.phase} phase (${why})`
  switch (w.phase) {
    case "prepare":
      if (["fetch", "checkout", "switch", "branch"].includes(inv.verb)) {
        if (inv.verb === "branch" && hasFlag(a, "-d", "-D", "-m", "-M", "--delete", "--move", "-f", "--force")) return deny("branches are never deleted, moved or forced here")
        if (inv.verb === "fetch" && hasFlag(a, "--prune", "-p", "--prune-tags")) return deny("no pruning")
        if (inv.verb === "checkout" && (a.includes("--") || hasFlag(a, "-f", "--force"))) return deny("no file resets, no force")
        if ((inv.verb === "checkout" || inv.verb === "switch") && !hasFlag(a, "-b", "-c", "--create", "-B") && a.some((x) => !x.startsWith("-") && isProtectedBranch(x, base) && x !== base && !/^[0-9a-f]{7,40}$/i.test(x))) return deny("only the base branch or the fix branch may be checked out")
        return undefined
      }
      if (inv.verb === "stash") return a[0] === undefined || a[0] === "push" || a[0] === "save" || a[0] === "list" || a[0] === "show" ? undefined : deny("only `git stash push` here")
      if (inv.verb === "submodule" && a[0] === "update") return undefined
      return deny("prepare only fetches, creates the branch, checks it out and stashes")
    case "triage":
    case "review":
    case "crashes":
    case "crash":
    case "ticket":
    case "close-loop":
      return deny("read-only git only")
    case "fix":
    case "feedback":
      return deny("the fix phase changes files only; Fixora commits and pushes in the publish phase")
    case "publish": {
      if (inv.verb === "add") {
        if (hasFlag(a, "-A", "--all") || a.includes(".") || a.includes("-u") || a.includes("--update")) return deny("add the files of the fix report explicitly, never everything")
        return w.grants?.commit ? undefined : deny("commit is not granted")
      }
      if (inv.verb === "commit") {
        if (!w.grants?.commit) return deny("commit is not granted")
        if (hasFlag(a, "--no-verify", "-n", "--amend", "--allow-empty", "-a", "--all")) return deny("no --no-verify, --amend, --allow-empty or -a")
        return undefined
      }
      if (inv.verb === "push") {
        if (!w.grants?.push) return deny("push is not granted")
        if (hasFlag(a, "--force", "-f", "--force-with-lease", "--delete", "-d", "--mirror", "--all", "--tags", "--prune")) return deny("never force, delete or mirror")
        const refs = a.filter((x) => !x.startsWith("-"))
        const branchArg = refs[1]
        const target = branchArg?.includes(":") ? branchArg.split(":")[1]!.replace(/^refs\/heads\//, "") : branchArg
        if (!w.branch || !target || target !== w.branch) return deny(`push only ${w.branch ?? "the run's branch"} (\`git push -u <remote> ${w.branch ?? "<branch>"}\`)`)
        if (isProtectedBranch(target, base)) return deny("protected branch")
        return undefined
      }
      // The publish turn ends by restoring the user's checkout.
      if (["checkout", "switch"].includes(inv.verb)) return hasFlag(a, "-f", "--force", "-b", "-B", "-c") || a.includes("--") ? deny("plain checkout of the previous branch only") : undefined
      if (inv.verb === "stash") return ["pop", "apply", "list", "show", "drop"].includes(a[0] ?? "") ? undefined : deny("only stash pop / apply / list / drop")
      return deny("publish only adds, commits, pushes the fix and restores the checkout")
    }
    case "restore":
      if (["checkout", "switch"].includes(inv.verb)) return hasFlag(a, "-f", "--force", "-b", "-B", "-c") || a.includes("--") ? deny("plain checkout of the previous branch only") : undefined
      if (inv.verb === "stash") return ["pop", "apply", "list", "show", "drop"].includes(a[0] ?? "") ? undefined : deny("only stash pop / apply / list / drop")
      return deny("restore only checks out the previous branch and pops the stash")
    case "sync":
      return deny("sync is read-only")
    case "recover":
      if (inv.verb === "fetch") return hasFlag(a, "--prune", "-p", "--prune-tags") ? deny("no pruning") : undefined
      return deny("recover only fetches and reads history")
    case "clean": {
      if (["checkout", "switch"].includes(inv.verb)) return hasFlag(a, "-f", "--force") || a.includes("--") ? deny("no force") : undefined
      if (inv.verb === "stash") return ["pop", "apply", "list", "show", "drop"].includes(a[0] ?? "") ? undefined : deny("only stash pop / apply / list / drop")
      if (inv.verb === "branch") {
        const name = a.find((x) => !x.startsWith("-"))
        if (!hasFlag(a, "-D", "-d", "--delete")) return deny("clean only deletes the run's branch")
        return name && name === w.branch && !isProtectedBranch(name, base) ? undefined : deny(`only the run's branch ${w.branch ?? ""} may be deleted`)
      }
      if (inv.verb === "push") {
        if (!w.grants?.deleteBranch) return deny("remote branch deletion was not approved")
        const name = a.filter((x) => !x.startsWith("-")).pop()
        if (!hasFlag(a, "--delete", "-d")) return deny("clean only deletes the run's remote branch")
        return name && name === w.branch && !isProtectedBranch(name, base) ? undefined : deny(`only the run's branch ${w.branch ?? ""} may be deleted`)
      }
      return deny("clean only restores the checkout and deletes the run's branch")
    }
  }
}

/** Non-git commands per phase. */
function judgeNonGit(segment: string, w: WorkerInfo, checkCommands: string[]): string | undefined {
  const trimmed = segment.trim()
  if (!trimmed) return undefined
  const first = tokens(trimmed)[0] ?? ""
  const harmless = /^(cat|ls|pwd|head|tail|wc|echo|true|test|printf|basename|dirname|realpath|which|command|type|date|sort|uniq|cut|tr|grep|rg|find|fd|diff|stat|file|jq|yq)$/.test(first)
  switch (w.phase) {
    case "crashes":
    case "crash":
    case "ticket":
    case "close-loop":
      return `fixora worker: shell commands are not allowed in the ${w.phase} phase (use the MCP tools and the fixora_submit_* tool)`
    case "triage":
    case "prepare":
    case "fix":
    case "feedback":
      return undefined
    case "review":
      return harmless || checkCommands.some((c) => trimmed === c.trim() || trimmed.startsWith(`${c.trim()} `)) ? undefined : `fixora reviewer: only read-only git commands and the project's check commands are allowed (got: ${trimmed.slice(0, 80)})`
    case "publish":
      if (/^(glab|gh)\b/.test(trimmed)) {
        if (!w.grants?.mr) return "fixora worker: opening a merge request was not approved (glab / gh are not granted)"
        return /^(glab\s+mr\s+(create|update|view|list)|gh\s+(pr\s+(create|edit|view|list)|auth\s+status))\b/.test(trimmed) ? undefined : `fixora worker: only glab mr create/update/view and gh pr create/edit/view are allowed (got: ${trimmed.slice(0, 80)})`
      }
      return harmless ? undefined : `fixora worker: the publish phase runs git, glab / gh and read-only helpers only (got: ${trimmed.slice(0, 80)})`
    case "restore":
      return harmless ? undefined : `fixora worker: the restore phase runs git only (got: ${trimmed.slice(0, 80)})`
    case "sync":
      return harmless || /^(glab\s+mr\s+(view|list)|gh\s+pr\s+(view|list))\b/.test(trimmed) ? undefined : `fixora worker: sync runs glab mr view / gh pr view only (got: ${trimmed.slice(0, 80)})`
    case "recover":
      return harmless || /^(glab\s+mr\s+(view|list)|gh\s+(pr\s+(view|list)|auth\s+status)|glab\s+auth\s+status)\b/.test(trimmed) ? undefined : `fixora worker: recover runs git fetch / git log, glab mr list and gh pr list only (got: ${trimmed.slice(0, 80)})`
    case "clean":
      if (/^(glab|gh)\b/.test(trimmed)) return w.grants?.closeMr && /^(glab\s+mr\s+(close|view)|gh\s+pr\s+(close|view))\b/.test(trimmed) ? undefined : "fixora worker: clean may only close / view the run's merge request"
      return harmless ? undefined : `fixora worker: the clean phase runs git and glab / gh only (got: ${trimmed.slice(0, 80)})`
  }
}

export interface ShellGuardInput {
  tool: string
  input: unknown
  worker: WorkerInfo
  checkCommands?: string[]
}

export function guardWorkerShell(input: ShellGuardInput): string | undefined {
  if (!SHELL_TOOLS.has(input.tool)) return undefined
  const raw = input.input as Record<string, unknown> | undefined
  const command = [raw?.command, raw?.cmd, raw?.script].find((v) => typeof v === "string") as string | undefined
  if (!command) return undefined
  const w = input.worker
  const repo = normalizePath(w.repo)
  const cwd = typeof raw?.cwd === "string" ? raw.cwd : typeof raw?.workdir === "string" ? raw.workdir : undefined
  if (cwd && !inside(resolveInside(cwd, w.repo), repo)) return `fixora worker: shell cwd must stay inside the repository (${cwd})`
  for (const m of command.matchAll(/\bcd\s+("[^"]+"|'[^']+'|\S+)/g)) {
    const target = m[1]!.replace(/^["']|["']$/g, "")
    if (target === "-" || target.startsWith("~")) return "fixora worker: cd outside the repository is not allowed"
    if (!inside(resolveInside(target, w.repo), repo)) return `fixora worker: cd outside the repository is not allowed (${target})`
  }
  for (const re of SHELL_DENY_ALWAYS) if (re.test(command)) return `fixora worker: this command is not allowed (${command.slice(0, 120)}). Fixora workers never use the network directly, escalate privileges or delete trees.`
  for (const inv of parseGitInvocations(command)) {
    if (inv.dir && !inside(resolveInside(inv.dir, w.repo), repo)) return `fixora worker: git -C outside the repository is not allowed (${inv.dir})`
    const problem = judgeGit(inv, w)
    if (problem) return problem
  }
  for (const segment of command.split(/\n|;|&&|\|\||\|/)) {
    const words = tokens(segment)
    if (words.length === 0 || words[0] === "git" || words[0] === "cd") continue
    const problem = judgeNonGit(segment, w, input.checkCommands ?? [])
    if (problem) return problem
  }
  return undefined
}

// ---------- MCP guard ----------

const SOURCE_READ_PHASES = new Set<WorkerPhase>(["crashes", "crash", "triage", "fix", "feedback", "review", "close-loop"])

export function guardWorkerMcp(toolId: string, w: WorkerInfo, services: Services): string | undefined {
  const c = classifyTool(toolId, services)
  if (!c) return undefined
  const write = isWriteTool(toolId, c.capability)
  const kind = c.service.id === "sentry" || c.service.id === "crashlytics" ? "source" : c.service.id === "jira" ? "jira" : "forge"
  const deny = (why: string) => `fixora worker: ${toolId} is not allowed in the ${w.phase} phase (${why})`
  if (kind === "source") {
    if (write) return w.grants?.sourceWrite ? undefined : deny("writing to the crash source was not granted")
    return SOURCE_READ_PHASES.has(w.phase) ? undefined : deny("crash sources are only read while listing, fetching, analysing, fixing or reviewing")
  }
  if (kind === "jira") {
    if (write) return w.grants?.jiraWrite ? undefined : deny("Jira writes need the ticket / close-loop grant")
    return w.role === "lister" ? deny("the lister only reads crash sources") : undefined
  }
  // forge
  if (write) {
    if (c.capability === "createMr" || c.capability === "createPr") return w.grants?.mr ? undefined : deny("opening a merge request was not approved")
    return w.grants?.mr || w.grants?.closeMr ? undefined : deny("updating the merge request was not granted")
  }
  return ["publish", "sync", "clean", "close-loop", "restore", "recover"].includes(w.phase) ? undefined : deny("forge reads happen in publish / sync / clean / recover only")
}

// ---------- the single entry point of the tool hook ----------

export interface GuardInput {
  tool: string
  input: unknown
  worker: WorkerInfo
  services: Services
  extraDeny?: string[]
  checks?: CheckCommand[]
}

/** Decides every tool call of a worker session; returns the refusal reason or undefined. */
export function guardWorkerTool(g: GuardInput): string | undefined {
  if (g.tool.startsWith("fixora_")) return undefined // the tool handlers check role and phase themselves
  if (WRITE_TOOLS.has(g.tool)) return guardWorkerWrite({ tool: g.tool, input: g.input, repo: g.worker.repo, directory: g.worker.repo, phase: g.worker.phase, folder: g.worker.folder, extraDeny: g.extraDeny })
  if (SHELL_TOOLS.has(g.tool)) return guardWorkerShell({ tool: g.tool, input: g.input, worker: g.worker, checkCommands: (g.checks ?? []).map((c) => c.command) })
  return guardWorkerMcp(g.tool, g.worker, g.services)
}

export const isSafeBranchName = (name: string, base: string) => isValidBranchName(name) && !isProtectedBranch(name, base)
