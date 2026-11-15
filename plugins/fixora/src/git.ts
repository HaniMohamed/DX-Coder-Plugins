// Git helpers (pure). The plugin never runs git itself: the worker sessions do, and these functions
// validate what they report (branch names, push safety, porcelain status) and build names / URLs.

export interface ChangedFile {
  path: string
  status: "added" | "modified" | "deleted" | "renamed" | "untracked"
}

export const isHexSha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{7,64}$/i.test(v)

/**
 * Parses `git status --porcelain=v1` output, NUL- or newline-separated (`-z` or plain). Rename
 * entries ("R  new -> old" / NUL-separated pairs) keep the new path; directories are dropped.
 */
export function parsePorcelain(text: string): ChangedFile[] {
  const out: ChangedFile[] = []
  const nul = text.includes("\0")
  const parts = nul ? text.split("\0") : text.split(/\r?\n/)
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    if (entry.length < 4) continue
    const x = entry[0]!
    const y = entry[1]!
    let path = entry.slice(3)
    let status: ChangedFile["status"] = "modified"
    if (x === "?" && y === "?") status = "untracked"
    else if (x === "!" && y === "!") continue
    else if (x === "A" || y === "A") status = "added"
    else if (x === "D" || y === "D") status = "deleted"
    else if (x === "R" || y === "R" || x === "C" || y === "C") {
      status = "renamed"
      if (nul) i++ // the old path follows as its own NUL-separated field
      else if (path.includes(" -> ")) path = path.split(" -> ").pop()!
    }
    path = path.replace(/\\/g, "/").replace(/^"(.*)"$/, "$1")
    if (!path || path.endsWith("/")) continue
    out.push({ path, status })
  }
  return out
}

export const shellQuote = (arg: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)

export function isProtectedBranch(branch: string, base: string): boolean {
  return branch === base || /^(main|master|develop|development|trunk|release\/.*|hotfix\/.*)$/.test(branch)
}

/** Refuses pushes that could damage shared branches. */
export function assertSafePush(branch: string, base: string, args: string[]): void {
  if (isProtectedBranch(branch, base)) throw new Error(`refusing to push to protected branch "${branch}"`)
  if (args.some((a) => a === "--force" || a === "-f" || a === "--delete" || a === "--mirror" || a === "--all" || a === "--tags" || a.startsWith("--force-with-lease"))) throw new Error("refusing to force-push or delete")
  if (!isValidBranchName(branch)) throw new Error(`invalid branch name "${branch}"`)
}

export const isValidBranchName = (branch: string) => /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch) && !branch.includes("..") && !branch.endsWith("/") && !branch.endsWith(".lock") && !branch.includes("//")

export function slug(text: string, max = 40): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "")
  return s || "crash"
}

/** `fixora/sentry-123-null-check-in-cart` (≤ 80 chars); restart suffix `-r2`. */
export const BRANCH_PLACEHOLDERS = ["type", "ticket", "slug", "runId", "crashId"] as const
export type BranchPlaceholder = (typeof BRANCH_PLACEHOLDERS)[number]

/** Placeholders a `branchNaming.template` uses that Fixora does not know. */
export function unknownBranchPlaceholders(template: string): string[] {
  return [...template.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!).filter((p) => !(BRANCH_PLACEHOLDERS as readonly string[]).includes(p))
}

/**
 * The branch name from the configured naming convention: `<prefix>` + the template with its
 * placeholders filled in (`{type}/{ticket}-{slug}` → `fixora/fix/DE-456-null-coupon`). Separators
 * are collapsed; a restart appends `-r<n>` like the default name.
 */
export function branchFromTemplate(prefix: string, template: string, vars: Record<BranchPlaceholder, string>, restart = 0): string {
  const body = template
    .replace(/\{(type|ticket|slug|runId|crashId)\}/g, (_, k: BranchPlaceholder) => vars[k])
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^[-/]+|[-/]+$/g, "")
  const base = `${prefix}${body}`.slice(0, 100)
  return restart > 0 ? `${base}-r${restart + 1}` : base
}

export function branchName(prefix: string, runId: string, title: string, restart = 0): string {
  const base = `${prefix}${slug(runId, 48)}-${slug(title, 32)}`.replace(/-+/g, "-").slice(0, 76)
  return restart > 0 ? `${base}-r${restart + 1}` : base
}

export interface ParsedRemote {
  host: string
  owner: string
  repo: string
  kind: "gitlab" | "github" | "unknown"
  web: string
}

export function parseRemote(url: string, forgeHint?: "gitlab" | "github"): ParsedRemote | undefined {
  let host: string | undefined
  let path: string | undefined
  const m = /^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(url.trim())
  const http = /^https?:\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url.trim())
  if (http) {
    host = http[1]
    path = http[2]
  } else if (m) {
    host = m[1]
    path = m[2]
  }
  if (!host || !path) return undefined
  const parts = path.split("/").filter(Boolean)
  if (parts.length < 2) return undefined
  const repo = parts[parts.length - 1]!
  const owner = parts.slice(0, -1).join("/")
  const kind: ParsedRemote["kind"] = forgeHint ?? (/(^|\.)github\.com$|ghe\./i.test(host) ? "github" : /gitlab/i.test(host) ? "gitlab" : "unknown")
  const scheme = /^http:\/\//.test(url) ? "http" : "https"
  return { host, owner, repo, kind, web: `${scheme}://${host}/${owner}/${repo}` }
}

export function compareUrl(remote: ParsedRemote, base: string, branch: string): string {
  if (remote.kind === "github") return `${remote.web}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`
  if (remote.kind === "gitlab")
    return `${remote.web}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(base)}`
  return `${remote.web} (branch ${branch} → ${base})`
}
