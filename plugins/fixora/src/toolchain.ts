// Toolchain facts come from the worker's prepare phase (it reads the marker files and reports the
// ecosystems and check commands). This module only normalises what it reported, applies the option
// overrides, knows what counts as a test file per ecosystem, and parses runner output.

import type { FixoraOptions } from "./options.js"
import type { CheckCommand, CheckKind, Toolchain } from "./types.js"

export type EcosystemId = "flutter" | "dart" | "node" | "gradle" | "maven" | "xcode" | "spm" | "python" | "go" | "dotnet" | "rust"

export const ECOSYSTEM_IDS: EcosystemId[] = ["flutter", "dart", "node", "gradle", "maven", "xcode", "spm", "python", "go", "dotnet", "rust"]

export interface Ecosystem {
  id: EcosystemId | string
  /** Repo-relative directory ("" = root). */
  root: string
}

const TEST_PATTERNS: Record<EcosystemId, RegExp[]> = {
  flutter: [/_test\.dart$/, /(^|\/)(test|integration_test)\//],
  dart: [/_test\.dart$/, /(^|\/)test\//],
  node: [/\.(test|spec)\.[cm]?[jt]sx?$/, /(^|\/)__tests__\//],
  gradle: [/(^|\/)src\/(test|androidTest)\//, /Test\.(kt|java)$/],
  maven: [/Test\.java$/, /(^|\/)src\/test\//],
  xcode: [/Tests?\.swift$/, /(^|\/)\w+Tests\//],
  spm: [/Tests?\.swift$/, /(^|\/)Tests\//],
  python: [/(^|\/)test_[^/]+\.py$/, /_test\.py$/, /(^|\/)tests?\//],
  go: [/_test\.go$/],
  dotnet: [/Tests?\.cs$/, /(^|\/)\w+\.Tests\//],
  rust: [/(^|\/)tests\//, /_test\.rs$/],
}
const GENERIC_TEST_PATTERNS = [/(^|\/)(test|tests|spec|__tests__|integration_test)\//, /[._-](test|spec)\.[a-z]+$/, /Tests?\.[a-z]+$/]

export function isTestFile(path: string, ecosystems: Ecosystem[]): boolean {
  const known = ecosystems.flatMap((e) => TEST_PATTERNS[e.id as EcosystemId] ?? [])
  const patterns = known.length ? [...known, ...GENERIC_TEST_PATTERNS] : GENERIC_TEST_PATTERNS
  return patterns.some((p) => p.test(path))
}

export const CHECK_KINDS: CheckKind[] = ["setup", "syntax", "lint", "typecheck", "unit", "integration", "build"]
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Reads the `checks` list of a prepare submission: `{ kind, command, cwd?, optional? }` entries, bad ones dropped. */
export function normalizeChecks(input: unknown): CheckCommand[] {
  if (!Array.isArray(input)) return []
  const out: CheckCommand[] = []
  for (const raw of input) {
    if (!isRecord(raw) || typeof raw.command !== "string" || !raw.command.trim()) continue
    const kind = typeof raw.kind === "string" && (CHECK_KINDS as string[]).includes(raw.kind) ? (raw.kind as CheckKind) : "unit"
    const cwd = typeof raw.cwd === "string" ? raw.cwd.replace(/^\.\/?/, "").replace(/\/+$/, "") : ""
    out.push({ kind, command: raw.command.trim(), cwd, optional: raw.optional === true })
  }
  return dedupeChecks(out)
}

/** Reads the `ecosystems` list of a prepare submission. */
export function normalizeEcosystems(input: unknown): Ecosystem[] {
  if (!Array.isArray(input)) return []
  const out: Ecosystem[] = []
  for (const raw of input) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.trim()) continue
    const root = typeof raw.root === "string" ? raw.root.replace(/^\.\/?/, "").replace(/\/+$/, "") : ""
    if (!out.some((e) => e.id === raw.id && e.root === root)) out.push({ id: raw.id.trim().toLowerCase(), root })
  }
  return out
}

export function dedupeChecks(list: CheckCommand[]): CheckCommand[] {
  const seen = new Set<string>()
  return list.filter((c) => {
    const key = `${c.cwd ?? ""}|${c.command}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Applies the `testCommands` option overrides to the checks the worker reported: a string replaces
 * every check of that kind, "" (or null in the config) disables the kind, undefined keeps what was reported.
 */
export function applyOverrides(reported: CheckCommand[], overrides: FixoraOptions["testCommands"]): CheckCommand[] {
  const out: CheckCommand[] = []
  const overridden = new Set<CheckKind>()
  const add = (kind: CheckKind, command: string | undefined) => {
    if (command === undefined) return
    overridden.add(kind)
    if (command.trim()) out.push({ kind, command: command.trim(), cwd: "" })
  }
  add("lint", overrides.lint)
  add("typecheck", overrides.typecheck)
  add("unit", overrides.unit)
  add("integration", overrides.integration)
  for (const c of reported) if (!overridden.has(c.kind) && c.kind !== "setup") out.push(c)
  return dedupeChecks(out)
}

/** The checks a fix submission must have run: every non-optional, non-setup command of the plan. */
export const requiredChecks = (checks: CheckCommand[]) => checks.filter((c) => !c.optional && c.kind !== "setup")

export const hasTestRunner = (toolchain: Toolchain | undefined) => !!toolchain?.checks.some((c) => c.kind === "unit" || c.kind === "integration")

/** Summarises a runner's output: pass/fail counts when recognisable. */
export function parseCheckOutput(kind: CheckKind, stdout: string, stderr: string): { passed?: number; failed?: number; summary: string } {
  const text = `${stdout}\n${stderr}`
  const num = (re: RegExp) => {
    const m = re.exec(text)
    return m ? Number(m[1]) : undefined
  }
  const patterns: Array<{ passed: RegExp; failed: RegExp }> = [
    { passed: /(\d+) pass(?:ed|ing)?\b/i, failed: /(\d+) fail(?:ed|ing|ures?)?\b/i }, // bun, mocha, vitest-ish
    { passed: /Tests:\s+(?:\d+ failed, )?(\d+) passed/i, failed: /Tests:\s+(\d+) failed/i }, // jest
    { passed: /(\d+) passed/i, failed: /(\d+) failed/i }, // pytest / vitest
    { passed: /\+(\d+)(?: ~\d+)?(?: -\d+)?: (?:All tests passed|Some tests failed)/, failed: /-(\d+): Some tests failed/ }, // flutter/dart test
    { passed: /Executed (\d+) tests?, with (\d+) failures?/, failed: /Executed \d+ tests?, with (\d+) failures?/ }, // xcodebuild / swift
    { passed: /Passed!\s+-\s+Failed:\s+\d+,\s+Passed:\s+(\d+)/, failed: /Failed:\s+(\d+),/ }, // dotnet
    { passed: /(\d+) passed;/, failed: /(\d+) failed;/ }, // cargo
  ]
  let passed: number | undefined
  let failed: number | undefined
  for (const p of patterns) {
    passed ??= num(p.passed)
    failed ??= num(p.failed)
    if (passed !== undefined || failed !== undefined) break
  }
  if (kind === "unit" || kind === "integration") {
    if (/^ok\s+\S+/m.test(text) && failed === undefined) passed ??= (text.match(/^ok\s+/gm) ?? []).length // go test
    if (/--- FAIL/.test(text)) failed = (text.match(/--- FAIL/g) ?? []).length
  }
  const summary = [passed !== undefined ? `${passed} passed` : undefined, failed !== undefined ? `${failed} failed` : undefined].filter(Boolean).join(", ")
  return { passed, failed, summary: summary || lastMeaningfulLine(text) }
}

function lastMeaningfulLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^[-=]+$/.test(l))
  return (lines[lines.length - 1] ?? "").slice(0, 200)
}
