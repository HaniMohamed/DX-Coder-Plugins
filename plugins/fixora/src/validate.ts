// The deterministic verification gate: which files changed, are they allowed, and do the project's
// checks (lint / typecheck / tests) pass in the worktree.

import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { git, type ChangedFile } from "./git.js"
import { forbiddenReason } from "./permissions.js"
import { parseCheckOutput } from "./toolchain.js"
import type { CheckCommand, CheckResult, TestReport } from "./types.js"

export interface ChangeSummary {
  files: ChangedFile[]
  paths: string[]
  added: number
  deleted: number
  diff: string
  diffHash: string
}

export async function summarizeChanges(worktree: string, base: string): Promise<ChangeSummary> {
  const files = (await git.statusPorcelain(worktree)).filter((f) => f.path && !f.path.endsWith("/"))
  const numstat = await git.numstat(worktree, base)
  const diff = await git.fullDiff(worktree, base)
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

export interface RunChecksOptions {
  cwd: string
  logDir?: string
  attempt: number
  log?: (line: string) => void
  signal?: AbortSignal
  env?: Record<string, string>
}

const TAIL_BYTES = 20 * 1024

export async function runCheck(cmd: CheckCommand, o: RunChecksOptions, index: number): Promise<CheckResult> {
  const cwd = cmd.cwd ? join(o.cwd, cmd.cwd) : o.cwd
  const started = Date.now()
  o.log?.(`$ ${cmd.command}  (${cmd.kind}${cmd.cwd ? `, in ${cmd.cwd}` : ""})`)
  const proc = Bun.spawn(["sh", "-lc", cmd.command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0", ...o.env },
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, cmd.timeoutMs)
  const onAbort = () => proc.kill()
  o.signal?.addEventListener("abort", onAbort, { once: true })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  o.signal?.removeEventListener("abort", onAbort)
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
    summary: timedOut ? `timed out after ${Math.round(cmd.timeoutMs / 1000)}s` : parsed.summary,
  }
  o.log?.(`  → exit ${result.exitCode} in ${durationMs} ms${result.summary ? `: ${result.summary}` : ""}`)
  return result
}

export async function runChecks(commands: CheckCommand[], o: RunChecksOptions & { diffHash: string }): Promise<TestReport> {
  const results: CheckResult[] = []
  for (const [i, cmd] of commands.entries()) {
    if (o.signal?.aborted) break
    results.push(await runCheck(cmd, o, i))
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
