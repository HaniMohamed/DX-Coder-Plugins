// Permission rules for the fixer and reviewer sessions (last matching rule wins, wildcards allowed)
// plus the tool-hook guards that confine writes and shell commands to the worktree.

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

const SHELL_DENY: RegExp[] = [
  /\bgit\s+(push|commit|checkout|switch|reset|rebase|merge|tag|remote|config|worktree|clean|stash|cherry-pick|revert|filter-branch|gc|prune)\b/,
  /\bgit\s+branch\s+(-[dDmM]|--delete|--move)/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/,
  /--force\b|\s-f\s+/,
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

/** Rules for the fixer session: closed by default, then re-open what the work needs. */
export function fixerRules(input: { sourceNamespaces: string[]; jiraNamespace?: string; forgeNamespaces: string[]; shell: "allow" | "deny" | "ask" }): Rule[] {
  const rules: Rule[] = [
    { action: "*", resource: "*", effect: "deny" },
    ...["read", "glob", "grep", "list", "skill", "todowrite", "todoread", "question", "codesearch", "lsp"].map((a) => ({ action: a, resource: "*", effect: "allow" as const })),
    { action: "read", resource: "*.env", effect: "deny" },
    { action: "read", resource: "*.env.*", effect: "deny" },
    { action: "edit", resource: "*", effect: "allow" },
    { action: "edit", resource: "../*", effect: "deny" },
    { action: "edit", resource: "/*", effect: "deny" },
    { action: "edit", resource: ".git/*", effect: "deny" },
    { action: "edit", resource: ".dxcoder/*", effect: "deny" },
    { action: "external_directory", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: input.shell },
    { action: "shell", resource: "git push*", effect: "deny" },
    { action: "shell", resource: "git commit*", effect: "deny" },
    { action: "shell", resource: "git checkout*", effect: "deny" },
    { action: "shell", resource: "git switch*", effect: "deny" },
    { action: "shell", resource: "git reset*", effect: "deny" },
    { action: "shell", resource: "git rebase*", effect: "deny" },
    { action: "shell", resource: "git merge*", effect: "deny" },
    { action: "shell", resource: "git worktree*", effect: "deny" },
    { action: "shell", resource: "git clean*", effect: "deny" },
    { action: "shell", resource: "rm -rf*", effect: "deny" },
    { action: "shell", resource: "*--force*", effect: "deny" },
    { action: "shell", resource: "curl*", effect: "deny" },
    { action: "shell", resource: "wget*", effect: "deny" },
    { action: "shell", resource: "sudo*", effect: "deny" },
    { action: "fixora_*", resource: "*", effect: "allow" },
    { action: "fixora_start", resource: "*", effect: "deny" },
  ]
  for (const ns of input.sourceNamespaces) {
    rules.push({ action: `${ns}_*`, resource: "*", effect: "deny" })
    for (const ro of ["*get*", "*search*", "*list*", "*find*", "*batch_get_events*"]) rules.push({ action: `${ns}_${ro}`, resource: "*", effect: "allow" })
  }
  if (input.jiraNamespace) {
    rules.push({ action: `${input.jiraNamespace}_*`, resource: "*", effect: "deny" })
    rules.push({ action: `${input.jiraNamespace}_*get*`, resource: "*", effect: "allow" })
    rules.push({ action: `${input.jiraNamespace}_*search*`, resource: "*", effect: "allow" })
  }
  for (const ns of input.forgeNamespaces) rules.push({ action: `${ns}_*`, resource: "*", effect: "deny" })
  for (const a of ["webfetch", "websearch", "subagent", "task", "opencode_*"]) rules.push({ action: a, resource: "*", effect: "deny" })
  return rules
}

/** Reviewer: no edits, no questions, shell limited to read-only git and the check commands. */
export function reviewerRules(input: { sourceNamespaces: string[]; jiraNamespace?: string; forgeNamespaces: string[]; checkCommands: string[] }): Rule[] {
  const base = fixerRules({ ...input, shell: "deny" }).filter((r) => !(r.action === "edit") && r.action !== "question")
  base.push({ action: "edit", resource: "*", effect: "deny" })
  base.push({ action: "question", resource: "*", effect: "deny" })
  for (const g of ["git diff*", "git log*", "git show*", "git blame*", "git status*", "git grep*", "git ls-files*"]) base.push({ action: "shell", resource: g, effect: "allow" })
  for (const c of input.checkCommands) base.push({ action: "shell", resource: `${c}*`, effect: "allow" })
  return base
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

export interface WriteGuardInput {
  tool: string
  input: unknown
  worktree: string
  /** The session's working directory (resolves relative paths). */
  directory: string
  phase: "triage" | "fix" | "review" | "feedback"
  extraDeny?: string[]
}

/** Returns an error message when a write/edit/patch call must be refused, otherwise undefined. */
export function guardWorkerWrite(input: WriteGuardInput): string | undefined {
  if (!WRITE_TOOLS.has(input.tool)) return undefined
  if (input.phase !== "fix" && input.phase !== "feedback") return `fixora worker: the ${input.phase} phase is read-only; no file changes are allowed`
  const worktree = normalizePath(input.worktree)
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
    if (absolute !== worktree && !absolute.startsWith(`${worktree}/`)) return `fixora worker: writing outside the worktree is not allowed (${c}). Only ${worktree} may be modified.`
    const rel = absolute === worktree ? "" : absolute.slice(worktree.length + 1)
    const why = forbiddenReason(rel, input.extraDeny)
    if (why) return `fixora worker: ${rel} must not be changed (${why})`
  }
  return undefined
}

export interface ShellGuardInput {
  tool: string
  input: unknown
  worktree: string
  role: "fixer" | "reviewer"
  allowPrefixes?: string[]
}

export function guardWorkerShell(input: ShellGuardInput): string | undefined {
  if (!SHELL_TOOLS.has(input.tool)) return undefined
  const raw = input.input as Record<string, unknown> | undefined
  const command = [raw?.command, raw?.cmd, raw?.script].find((v) => typeof v === "string") as string | undefined
  if (!command) return undefined
  const cwd = typeof raw?.cwd === "string" ? raw.cwd : typeof raw?.workdir === "string" ? raw.workdir : undefined
  const worktree = normalizePath(input.worktree)
  if (cwd) {
    const abs = resolveInside(cwd, input.worktree)
    if (abs !== worktree && !abs.startsWith(`${worktree}/`)) return `fixora worker: shell cwd must stay inside the worktree (${cwd})`
  }
  for (const m of command.matchAll(/\bcd\s+("[^"]+"|'[^']+'|\S+)/g)) {
    const target = m[1]!.replace(/^["']|["']$/g, "")
    if (target === "-" || target.startsWith("~")) return "fixora worker: cd outside the worktree is not allowed"
    const abs = resolveInside(target, input.worktree)
    if (abs !== worktree && !abs.startsWith(`${worktree}/`)) return `fixora worker: cd outside the worktree is not allowed (${target})`
  }
  if (input.role === "reviewer") {
    const trimmed = command.trim()
    const allowed = ["git diff", "git log", "git show", "git blame", "git status", "git grep", "git ls-files", ...(input.allowPrefixes ?? [])]
    if (!allowed.some((p) => trimmed.startsWith(p))) return `fixora reviewer: only read-only git commands and the project's check commands are allowed (got: ${trimmed.slice(0, 80)})`
  }
  for (const re of SHELL_DENY) if (re.test(command)) return `fixora worker: this command is not allowed (${command.slice(0, 120)}). Fixora handles git, network and publishing itself.`
  return undefined
}
