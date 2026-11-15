// The deterministic verification gate, now fed by what the worker reports: the porcelain status and
// the diff it submitted, the commands it ran. Nothing here touches git or spawns a process.

import { createHash } from "node:crypto"
import { parsePorcelain, type ChangedFile } from "./git.js"
import { forbiddenReason, isGeneratedChange } from "./permissions.js"
import { parseCheckOutput } from "./toolchain.js"
import type { CheckCommand, CheckKind, CheckResult, FixReport, TestReport } from "./types.js"

export interface ChangeSummary {
  files: ChangedFile[]
  paths: string[]
  added: number
  deleted: number
  diff: string
  diffHash: string
}

export const diffHash = (diff: string) => createHash("sha256").update(diff).digest("hex").slice(0, 16)

/** Added / deleted line counts of a unified diff (headers excluded). */
export function diffStats(diff: string): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) added++
    else if (line.startsWith("-")) deleted++
  }
  return { added, deleted }
}

/** Splits a unified diff into per-file sections (`diff --git a/x b/x` headers). */
export function splitDiff(diff: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = []
  const lines = diff.split("\n")
  let current: { path: string; lines: string[] } | undefined
  for (const line of lines) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
    if (m) {
      if (current) out.push({ path: current.path, text: current.lines.join("\n") })
      current = { path: m[2]!, lines: [line] }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) out.push({ path: current.path, text: current.lines.join("\n") })
  return out
}

/** Keeps only the sections of the diff whose path passes `keep`. A diff without headers is kept as is. */
export function filterDiff(diff: string, keep: (path: string) => boolean): string {
  const sections = splitDiff(diff)
  if (sections.length === 0) return diff
  return sections
    .filter((s) => keep(s.path))
    .map((s) => s.text)
    .join("\n")
}

/**
 * The change set from a fix submission: `status` is `git status --porcelain=v1` text (or an already
 * parsed list), `diff` is `git diff HEAD` (untracked files included through `git add -N`). Lockfiles
 * and tool caches rewritten by dependency setup are not part of the fix and are dropped from both.
 */
export function summaryFromSubmission(input: { status: string | ChangedFile[]; diff: string }): ChangeSummary {
  const files = (typeof input.status === "string" ? parsePorcelain(input.status) : input.status).filter((f) => f.path && !f.path.endsWith("/") && !isGeneratedChange(f.path))
  const paths = files.map((f) => f.path)
  const diff = filterDiff(input.diff ?? "", (p) => !isGeneratedChange(p))
  const { added, deleted } = diffStats(diff)
  return { files, paths, added, deleted, diff, diffHash: diffHash(diff) }
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

/** Guesses the kind of a reported command from the check plan, then from its text. */
export function kindOfCommand(command: string, checks: CheckCommand[]): CheckKind {
  const c = command.trim()
  const planned = checks.find((k) => c === k.command.trim() || c.startsWith(`${k.command.trim()} `))
  if (planned) return planned.kind
  if (/\b(install|pub get|npm ci)\b/.test(c)) return "setup"
  if (/\b(lint|analyze|analyse|eslint|ruff|clippy|ktlint|swiftlint)\b/.test(c)) return "lint"
  if (/\b(tsc|typecheck|mypy|vet|cargo check)\b/.test(c)) return "typecheck"
  if (/\b(build|compile|xcodebuild|gradlew assemble)\b/.test(c)) return "build"
  if (/\b(integration|e2e)\b/.test(c)) return "integration"
  return "unit"
}

/** Turns the commands the worker reported into the verification report the rest of the pipeline reads. */
export function reportFromCommands(commandsRun: FixReport["commandsRun"], diffHashValue: string, checks: CheckCommand[]): TestReport {
  const commands: CheckResult[] = commandsRun.map((c) => {
    const kind = c.kind ?? kindOfCommand(c.command, checks)
    const parsed = parseCheckOutput(kind, c.outputTail ?? c.summary, "")
    return {
      kind,
      command: c.command,
      cwd: c.cwd ?? "",
      exitCode: c.exitCode,
      passed: parsed.passed,
      failed: parsed.failed,
      durationMs: c.durationMs,
      outputTail: c.outputTail ?? "",
      summary: c.summary || parsed.summary,
    }
  })
  const allPassed = commands.every((r) => r.exitCode === 0 || (checks.find((k) => k.command.trim() === r.command.trim())?.optional === true && isToolMissing(r)))
  return { diffHash: diffHashValue, commands, allPassed }
}

/** Optional checks whose tool is absent (e.g. `tsc` not installed) are not failures. */
export function isToolMissing(r: CheckResult): boolean {
  return r.exitCode === 127 || /command not found|not recognized as an internal|No such file or directory|could not determine executable|npx: command not found|error: could not find/i.test(`${r.outputTail}\n${r.summary}`)
}

export function summarizeChecks(report: TestReport): string {
  if (report.commands.length === 0) return "no checks ran"
  return report.commands.map((c) => `${c.kind} ${c.exitCode === 0 ? "✓" : "✗"}${c.summary ? ` (${c.summary})` : ""}`).join(" · ")
}

export const failedChecks = (report: TestReport) => report.commands.filter((c) => c.exitCode !== 0 && !isToolMissing(c))
