// Git helpers (Bun.spawn). The plugin owns every git side effect: never force, never the base branch.

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`.slice(0, 2000))
    this.name = "GitError"
  }
}

export async function runGit(cwd: string, args: string[], o: { timeoutMs?: number; allowFail?: boolean; env?: Record<string, string> } = {}): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C", ...o.env },
  })
  const timer = setTimeout(() => proc.kill(), o.timeoutMs ?? 120_000)
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  const result = { code, stdout, stderr }
  if (code !== 0 && !o.allowFail) throw new GitError(args, result)
  return result
}

export interface ChangedFile {
  path: string
  status: "added" | "modified" | "deleted" | "renamed" | "untracked"
}

export const git = {
  async isRepo(cwd: string) {
    return (await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], { allowFail: true })).code === 0
  },
  async topLevel(cwd: string) {
    return (await runGit(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim()
  },
  async remoteUrl(cwd: string, remote: string): Promise<string | undefined> {
    const r = await runGit(cwd, ["remote", "get-url", remote], { allowFail: true })
    return r.code === 0 ? r.stdout.trim() : undefined
  },
  async fetch(cwd: string, remote: string, branch: string) {
    await runGit(cwd, ["fetch", "--quiet", remote, branch], { timeoutMs: 300_000 })
  },
  async headSha(cwd: string, ref = "HEAD"): Promise<string | undefined> {
    const r = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true })
    return r.code === 0 ? r.stdout.trim() : undefined
  },
  async branchExists(cwd: string, name: string, remote?: string) {
    const ref = remote ? `refs/remotes/${remote}/${name}` : `refs/heads/${name}`
    return (await runGit(cwd, ["show-ref", "--verify", "--quiet", ref], { allowFail: true })).code === 0
  },
  async remoteBranchSha(cwd: string, remote: string, name: string): Promise<string | undefined> {
    const r = await runGit(cwd, ["ls-remote", "--heads", remote, name], { allowFail: true, timeoutMs: 60_000 })
    const sha = r.stdout.trim().split(/\s+/)[0]
    return r.code === 0 && sha ? sha : undefined
  },
  async currentBranch(cwd: string) {
    return (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()
  },
  async checkoutNewBranch(cwd: string, name: string, startRef: string) {
    await runGit(cwd, ["checkout", "--quiet", "-b", name, startRef])
  },
  async checkout(cwd: string, name: string) {
    await runGit(cwd, ["checkout", "--quiet", name])
  },
  async lsFiles(cwd: string): Promise<string[]> {
    const r = await runGit(cwd, ["ls-files", "-z"], { timeoutMs: 120_000 })
    return r.stdout.split("\0").filter(Boolean)
  },
  /** Files tracked at a ref (base branch), independent of the working tree. */
  async lsTree(cwd: string, ref: string): Promise<string[]> {
    const r = await runGit(cwd, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", ref], { timeoutMs: 120_000 })
    return r.stdout.split("\0").filter(Boolean)
  },
  async fileExistsAt(cwd: string, ref: string, path: string): Promise<boolean> {
    return (await runGit(cwd, ["cat-file", "-e", `${ref}:${path}`], { allowFail: true })).code === 0
  },
  async statusPorcelain(cwd: string): Promise<ChangedFile[]> {
    const r = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    const out: ChangedFile[] = []
    const parts = r.stdout.split("\0")
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]!
      if (!entry) continue
      const x = entry[0]!
      const y = entry[1]!
      let path = entry.slice(3)
      let status: ChangedFile["status"] = "modified"
      if (x === "?" && y === "?") status = "untracked"
      else if (x === "A" || y === "A") status = "added"
      else if (x === "D" || y === "D") status = "deleted"
      else if (x === "R" || y === "R") {
        status = "renamed"
        // rename entries carry the old path as the next NUL-separated field
        i++
      }
      out.push({ path: path.replace(/\\/g, "/"), status })
    }
    return out
  },
  async diff(cwd: string, o: { base?: string; stat?: boolean; paths?: string[] } = {}) {
    const args = ["diff", "--no-color", "--no-ext-diff"]
    if (o.stat) args.push("--numstat")
    if (o.base) args.push(o.base)
    if (o.paths?.length) args.push("--", ...o.paths)
    return (await runGit(cwd, args)).stdout
  },
  /** Working tree diff including untracked files (as added), against the index/base. */
  async fullDiff(cwd: string, base?: string): Promise<string> {
    await runGit(cwd, ["add", "--intent-to-add", "--all"], { allowFail: true })
    const d = await git.diff(cwd, { base })
    return d
  },
  async numstat(cwd: string, base?: string): Promise<Array<{ path: string; added: number; deleted: number }>> {
    await runGit(cwd, ["add", "--intent-to-add", "--all"], { allowFail: true })
    const out = await git.diff(cwd, { base, stat: true })
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [a, d, ...rest] = l.split("\t")
        return { path: rest.join("\t"), added: a === "-" ? 0 : Number(a), deleted: d === "-" ? 0 : Number(d) }
      })
  },
  async add(cwd: string, paths: string[]) {
    if (paths.length === 0) return
    await runGit(cwd, ["add", "--", ...paths])
  },
  async commit(cwd: string, messageFile: string, o: { signoff?: boolean } = {}): Promise<string> {
    const args = ["commit", "--quiet", "-F", messageFile]
    if (o.signoff) args.push("--signoff")
    await runGit(cwd, args, { timeoutMs: 300_000 })
    return (await git.headSha(cwd)) ?? ""
  },
  async push(cwd: string, remote: string, branch: string, o: { base: string; forceWithLease?: string }) {
    const args = ["push", "--quiet", "-u", remote, `${branch}:refs/heads/${branch}`]
    if (o.forceWithLease) args.splice(1, 0, `--force-with-lease=refs/heads/${branch}:${o.forceWithLease}`)
    assertSafePush(branch, o.base, args)
    await runGit(cwd, args, { timeoutMs: 300_000 })
  },
  async deleteRemoteBranch(cwd: string, remote: string, branch: string, base: string) {
    if (isProtectedBranch(branch, base)) throw new Error(`refusing to delete protected branch ${branch}`)
    await runGit(cwd, ["push", "--quiet", remote, "--delete", branch], { timeoutMs: 120_000 })
  },
  async log(cwd: string, o: { path?: string; n?: number; follow?: boolean; format?: string; ref?: string } = {}): Promise<string> {
    const args = ["log", `-n${o.n ?? 10}`, `--format=${o.format ?? "%h %ad %an %s"}`, "--date=short"]
    if (o.follow) args.push("--follow")
    if (o.ref) args.push(o.ref)
    if (o.path) args.push("--", o.path)
    return (await runGit(cwd, args, { allowFail: true })).stdout
  },
  async blame(cwd: string, path: string, line: number, context = 3): Promise<string> {
    const from = Math.max(1, line - context)
    const r = await runGit(cwd, ["blame", "--date=short", "-L", `${from},${line + context}`, "--", path], { allowFail: true })
    return r.code === 0 ? r.stdout : ""
  },
  async commitExists(cwd: string, sha: string) {
    return (await runGit(cwd, ["cat-file", "-e", `${sha}^{commit}`], { allowFail: true })).code === 0
  },
  /** Finds where a path that no longer exists was renamed to (most recent rename first, chained). */
  async renamedTo(cwd: string, oldPath: string, ref: string): Promise<string | undefined> {
    const r = await runGit(cwd, ["log", "-M", "--diff-filter=R", "--name-status", "--format=", "-n", "200", ref], { allowFail: true })
    if (r.code !== 0) return undefined
    const renames = [...r.stdout.matchAll(/^R\d*\t([^\t\n]+)\t([^\t\n]+)$/gm)].map((m) => ({ from: m[1]!, to: m[2]! }))
    // Newest first in the log; walk from the oldest rename of oldPath forward through chained renames.
    let current = oldPath
    for (let i = renames.length - 1; i >= 0; i--) if (renames[i]!.from === current) current = renames[i]!.to
    return current === oldPath ? undefined : current
  },
  async isClean(cwd: string) {
    return (await git.statusPorcelain(cwd)).length === 0
  },
  async tagsContaining(cwd: string, sha: string): Promise<string[]> {
    const r = await runGit(cwd, ["tag", "--contains", sha], { allowFail: true })
    return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : []
  },
}

export function isProtectedBranch(branch: string, base: string): boolean {
  return branch === base || /^(main|master|develop|development|trunk|release\/.*|hotfix\/.*)$/.test(branch)
}

/** Refuses pushes that could damage shared branches. */
export function assertSafePush(branch: string, base: string, args: string[]): void {
  if (isProtectedBranch(branch, base)) throw new Error(`refusing to push to protected branch "${branch}"`)
  if (args.some((a) => a === "--force" || a === "-f" || a === "--delete" || a === "--mirror" || a === "--all" || a === "--tags")) throw new Error("refusing to force-push or delete")
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock")) throw new Error(`invalid branch name "${branch}"`)
}

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
  let m = /^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(url.trim())
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
