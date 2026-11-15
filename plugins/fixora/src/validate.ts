// The deterministic verification gate: which files changed, are they allowed, and do the project's
// checks (lint / typecheck / tests) pass in the worktree.

import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { git, spawnShellStream, type ChangedFile } from "./git.js"
import { forbiddenReason, isGeneratedChange } from "./permissions.js"
import { parseCheckOutput } from "./toolchain.js"
import type { CheckCommand, CheckKind, CheckResult, TestReport } from "./types.js"

export interface ChangeSummary {
  files: ChangedFile[]
  paths: string[]
  added: number
  deleted: number
  diff: string
  diffHash: string
}

export async function summarizeChanges(worktree: string, base: string): Promise<ChangeSummary> {
  // Lockfiles and tool caches rewritten by the bootstrap are not part of the fix.
  const files = (await git.statusPorcelain(worktree)).filter((f) => f.path && !f.path.endsWith("/") && !isGeneratedChange(f.path))
  const paths = files.map((f) => f.path)
  const numstat = await git.numstat(worktree, base, paths)
  const diff = await git.fullDiff(worktree, base, paths)
  return {
    files,
    paths: files.map((f) => f.path),
    added: numstat.reduce((s, n) => s + n.added, 0),
    deleted: numstat.reduce((s, n) => s + n.deleted, 0),
    diff,
    diffHash: createHash("sha256").update(diff).digest("hex").slice(0, 16),
  }
}

export interface ChangeLimits {
  denyPaths: string[]
  maxFiles: number
  maxLines: number
}

/** Problems with the changed set that block the run regardless of what the worker reported. */
export function checkChangedFiles(summary: Pick<ChangeSummary, "paths" | "added" | "deleted">, limits: ChangeLimits): string[] {
  const problems: string[] = []
  for (const p of summary.paths) {
    const why = forbiddenReason(p, limits.denyPaths)
    if (why) problems.push(`${p}: ${why}`)
  }
  if (summary.paths.length > limits.maxFiles) problems.push(`${summary.paths.length} files changed (limit ${limits.maxFiles})`)
  if (summary.added + summary.deleted > limits.maxLines) problems.push(`${summary.added + summary.deleted} diff lines (limit ${limits.maxLines})`)
  return problems
}

export interface CheckProgress {
  index: number
  total: number
  kind: CheckKind
  command: string
  elapsedMs: number
  passed?: number
  failed?: number
  /** Last meaningful output line (ANSI stripped, trimmed). */
  lastLine?: string
  lines: number
}

export interface RunChecksOptions {
  cwd: string
  logDir?: string
  attempt: number
  log?: (line: string) => void
  signal?: AbortSignal
  env?: Record<string, string>
  /** Called on every output line (at most a few times per second is enough for the caller). */
  onProgress?: (p: CheckProgress) => void
  total?: number
}

const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g
const NOISE = /^(\s*[-=_~]{3,}\s*|\s*\d+%\s*|\s*)$/
export const cleanLine = (line: string) => line.replace(ANSI, "").replace(/\s+/g, " ").trim().slice(0, 160)

const TAIL_BYTES = 20 * 1024

export async function runCheck(cmd: CheckCommand, o: RunChecksOptions, index: number): Promise<CheckResult> {
  const cwd = cmd.cwd ? join(o.cwd, cmd.cwd) : o.cwd
  const started = Date.now()
  o.log?.(`$ ${cmd.command}  (${cmd.kind}${cmd.cwd ? `, in ${cmd.cwd}` : ""})`)
  let lines = 0
  let lastLine: string | undefined
  let recent = ""
  let lastTick = 0
  let repeats = 0
  let abortedFor: string | undefined
  const local = new AbortController()
  o.signal?.addEventListener("abort", () => local.abort(), { once: true })
  const tick = (force = false) => {
    if (!o.onProgress) return
    const now = Date.now()
    if (!force && now - lastTick < 500) return
    lastTick = now
    const parsed = parseCheckOutput(cmd.kind, recent, "")
    o.onProgress({ index, total: o.total ?? index + 1, kind: cmd.kind, command: cmd.command, elapsedMs: now - started, passed: parsed.passed, failed: parsed.failed, lastLine, lines })
  }
  tick(true)
  const r = await spawnShellStream(cmd.command, {
    cwd,
    timeoutMs: cmd.timeoutMs,
    env: { CI: "1", ...o.env },
    signal: local.signal,
    onLine: (line) => {
      lines++
      const clean = cleanLine(line)
      if (clean && !NOISE.test(clean)) {
        repeats = clean === lastLine ? repeats + 1 : 0
        lastLine = clean
        // A runner that prints the same error for every file (unresolved package, missing SDK) will not recover.
        if (repeats >= 300 && /error|exception|couldn't|cannot|failed/i.test(clean) && !abortedFor) {
          abortedFor = clean
          local.abort()
        }
      }
      recent = `${recent}\n${line}`.slice(-8000)
      tick()
    },
  })
  const { stdout, stderr, timedOut } = r
  const exitCode = r.code
  const durationMs = Date.now() - started
  const combined = `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`
  if (o.logDir) {
    await mkdir(o.logDir, { recursive: true })
    await writeFile(join(o.logDir, `${o.attempt}-${index}-${cmd.kind}.log`), `$ ${cmd.command}\n# exit ${exitCode}${timedOut ? " (timed out)" : ""} after ${durationMs} ms\n\n${combined}`)
  }
  const parsed = parseCheckOutput(cmd.kind, stdout, stderr)
  const result: CheckResult = {
    kind: cmd.kind,
    command: cmd.command,
    cwd: cmd.cwd ?? "",
    exitCode: timedOut ? 124 : exitCode,
    passed: parsed.passed,
    failed: parsed.failed,
    durationMs,
    outputTail: combined.length > TAIL_BYTES ? `…\n${combined.slice(-TAIL_BYTES)}` : combined,
    timedOut: timedOut || undefined,
    summary: timedOut ? `timed out after ${Math.round(cmd.timeoutMs / 1000)}s` : abortedFor ? `stopped early: ${abortedFor}` : parsed.summary,
  }
  if (abortedFor && result.exitCode === 0) result.exitCode = 1
  o.log?.(`  → exit ${result.exitCode} in ${durationMs} ms${result.summary ? `: ${result.summary}` : ""}`)
  return result
}

export async function runChecks(commands: CheckCommand[], o: RunChecksOptions & { diffHash: string }): Promise<TestReport> {
  const results: CheckResult[] = []
  for (const [i, cmd] of commands.entries()) {
    if (o.signal?.aborted) break
    results.push(await runCheck(cmd, { ...o, total: commands.length }, i))
  }
  const allPassed = results.every((r) => r.exitCode === 0 || commands.find((c) => c.command === r.command)?.optional === true && isToolMissing(r))
  return { diffHash: o.diffHash, commands: results, allPassed }
}

/** Optional checks whose tool is absent (e.g. `tsc` not installed) are not failures. */
export function isToolMissing(r: CheckResult): boolean {
  return r.exitCode === 127 || /command not found|not recognized as an internal|No such file or directory|could not determine executable|npx: command not found|error: could not find/i.test(r.outputTail)
}

export function summarizeChecks(report: TestReport): string {
  if (report.commands.length === 0) return "no checks ran"
  return report.commands.map((c) => `${c.kind} ${c.exitCode === 0 ? "✓" : "✗"}${c.summary ? ` (${c.summary})` : ""}`).join(" · ")
}

export const failedChecks = (report: TestReport) => report.commands.filter((c) => c.exitCode !== 0 && !isToolMissing(c))
