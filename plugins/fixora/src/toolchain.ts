// Detects the project's ecosystems and the lint / typecheck / test commands Fixora runs in the
// worktree. Detection reads marker files only; option overrides win.

import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import type { FixoraOptions } from "./options.js"
import type { CheckCommand, CheckKind } from "./types.js"

export type EcosystemId = "flutter" | "dart" | "node" | "gradle" | "maven" | "xcode" | "spm" | "python" | "go" | "dotnet" | "rust"

export interface Ecosystem {
  id: EcosystemId
  /** Repo-relative directory ("" = root). */
  root: string
  checks: CheckCommand[]
  /** Builds a test command limited to the given test files (repo-relative). */
  subset?: (files: string[]) => string | undefined
  testFilePatterns: RegExp[]
  testDirs: string[]
}

const MIN = 60_000
const DEFAULT_TIMEOUT = 10 * MIN

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export async function detectEcosystems(repoRoot: string, timeoutMs = DEFAULT_TIMEOUT): Promise<Ecosystem[]> {
  const out: Ecosystem[] = []
  const roots = await candidateRoots(repoRoot)
  for (const dir of roots) {
    const rel = relative(repoRoot, dir).replace(/\\/g, "/")
    const has = (f: string) => existsSync(join(dir, f))
    const cmd = (kind: CheckKind, command: string, optional = false): CheckCommand => ({ kind, command, cwd: rel, timeoutMs, optional })

    if (has("pubspec.yaml")) {
      const pubspec = await readFile(join(dir, "pubspec.yaml"), "utf8").catch(() => "")
      const flutter = /^\s*flutter:\s*$/m.test(pubspec) || /sdk:\s*flutter/.test(pubspec)
      const bin = flutter ? "flutter" : "dart"
      out.push({
        id: flutter ? "flutter" : "dart",
        root: rel,
        checks: [cmd("lint", `${bin} analyze`), cmd("unit", `${bin} test`), ...(has("integration_test") && flutter ? [cmd("integration", "flutter test integration_test", true)] : [])],
        subset: (files) => (files.length ? `${bin} test ${files.map(q).join(" ")}` : undefined),
        testFilePatterns: [/_test\.dart$/],
        testDirs: ["test", "integration_test"],
      })
    }
    if (has("package.json")) {
      const pkg = (await readJson(join(dir, "package.json"))) ?? {}
      const scripts = (pkg.scripts ?? {}) as Record<string, string>
      const runner = has("bun.lock") || has("bun.lockb") ? "bun" : has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm"
      const run = (script: string) => (runner === "npm" ? `npm run ${script}` : `${runner} run ${script}`)
      const checks: CheckCommand[] = []
      if (scripts.lint) checks.push(cmd("lint", run("lint")))
      if (scripts.typecheck) checks.push(cmd("typecheck", run("typecheck")))
      else if (has("tsconfig.json")) checks.push(cmd("typecheck", runner === "bun" ? "bunx tsc --noEmit" : "npx tsc --noEmit", true))
      if (scripts.test && !/no test specified/.test(scripts.test)) checks.push(cmd("unit", runner === "bun" && /^bun test/.test(scripts.test) ? "bun test" : run("test")))
      else if (runner === "bun") checks.push(cmd("unit", "bun test", true))
      for (const s of ["test:integration", "test:e2e", "integration"]) if (scripts[s]) checks.push(cmd("integration", run(s), true))
      const testCmd = scripts.test ?? ""
      const subset = (files: string[]) => {
        if (!files.length) return undefined
        if (/vitest/.test(testCmd)) return `${runner === "npm" ? "npx" : runner === "bun" ? "bunx" : `${runner} exec`} vitest run ${files.map(q).join(" ")}`
        if (/jest/.test(testCmd)) return `${runner === "npm" ? "npx" : runner === "bun" ? "bunx" : `${runner} exec`} jest ${files.map(q).join(" ")}`
        if (runner === "bun" || /bun test/.test(testCmd)) return `bun test ${files.map(q).join(" ")}`
        return undefined
      }
      out.push({ id: "node", root: rel, checks, subset, testFilePatterns: [/\.(test|spec)\.[cm]?[jt]sx?$/, /(^|\/)__tests__\//], testDirs: ["test", "tests", "__tests__", "spec"] })
    }
    if (has("gradlew") || has("build.gradle") || has("build.gradle.kts")) {
      const gw = has("gradlew") ? "./gradlew" : "gradle"
      out.push({
        id: "gradle",
        root: rel,
        checks: [cmd("build", `${gw} compileDebugKotlin compileDebugJavaWithJavac --quiet`, true), cmd("unit", `${gw} testDebugUnitTest --quiet`), cmd("lint", `${gw} lintDebug --quiet`, true)],
        subset: (files) => {
          const classes = files.map((f) => /([A-Za-z0-9_]+)\.(kt|java)$/.exec(f)?.[1]).filter(Boolean)
          return classes.length ? `${gw} testDebugUnitTest --quiet ${classes.map((c) => `--tests "*${c}*"`).join(" ")}` : undefined
        },
        testFilePatterns: [/(^|\/)src\/(test|androidTest)\//, /Test\.(kt|java)$/],
        testDirs: ["src/test", "src/androidTest"],
      })
    } else if (has("pom.xml")) {
      out.push({ id: "maven", root: rel, checks: [cmd("build", "mvn -q -DskipTests compile"), cmd("unit", "mvn -q test")], testFilePatterns: [/Test\.java$/], testDirs: ["src/test"] })
    }
    const xcodeproj = (await readdir(dir).catch(() => [])).filter((f) => /\.(xcworkspace|xcodeproj)$/.test(f))
    if (xcodeproj.length > 0 && !has("Package.swift")) {
      out.push({ id: "xcode", root: rel, checks: [cmd("build", "xcodebuild build -quiet CODE_SIGNING_ALLOWED=NO", true)], testFilePatterns: [/Tests?\.swift$/, /(^|\/)\w+Tests\//], testDirs: [] })
    }
    if (has("Package.swift")) {
      out.push({ id: "spm", root: rel, checks: [cmd("build", "swift build"), cmd("unit", "swift test")], subset: (files) => (files.length ? `swift test --filter ${files.map((f) => /([A-Za-z0-9_]+)\.swift$/.exec(f)?.[1]).filter(Boolean).join("|")}` : undefined), testFilePatterns: [/Tests?\.swift$/], testDirs: ["Tests"] })
    }
    if (has("pyproject.toml") || has("setup.py") || has("pytest.ini") || has("requirements.txt")) {
      const py = await readFile(join(dir, "pyproject.toml"), "utf8").catch(() => "")
      const checks: CheckCommand[] = [cmd("syntax", "python -m compileall -q .", true)]
      if (/\[tool\.ruff\]/.test(py) || has("ruff.toml") || has(".ruff.toml")) checks.push(cmd("lint", "ruff check ."))
      if (/\[tool\.mypy\]/.test(py) || has("mypy.ini")) checks.push(cmd("typecheck", "mypy .", true))
      checks.push(cmd("unit", "pytest -q"))
      out.push({ id: "python", root: rel, checks, subset: (files) => (files.length ? `pytest -q ${files.map(q).join(" ")}` : undefined), testFilePatterns: [/(^|\/)test_[^/]+\.py$/, /_test\.py$/, /(^|\/)tests?\//], testDirs: ["tests", "test"] })
    }
    if (has("go.mod")) {
      out.push({ id: "go", root: rel, checks: [cmd("typecheck", "go vet ./..."), cmd("unit", "go test ./...")], subset: (files) => {
        const dirs = [...new Set(files.map((f) => dirname(f)).map((d) => (d === "." || d === "" ? "." : `./${d}`)))]
        return dirs.length ? `go test ${dirs.map((d) => `${d}/...`).join(" ")}` : undefined
      }, testFilePatterns: [/_test\.go$/], testDirs: [] })
    }
    const dotnet = (await readdir(dir).catch(() => [])).some((f) => /\.(sln|csproj|fsproj)$/.test(f))
    if (dotnet) out.push({ id: "dotnet", root: rel, checks: [cmd("build", "dotnet build --nologo -v q"), cmd("unit", "dotnet test --nologo -v q --no-build")], testFilePatterns: [/Tests?\.cs$/, /(^|\/)\w+\.Tests\//], testDirs: [] })
    if (has("Cargo.toml")) out.push({ id: "rust", root: rel, checks: [cmd("typecheck", "cargo check --quiet"), cmd("unit", "cargo test --quiet")], testFilePatterns: [/(^|\/)tests\//, /_test\.rs$/], testDirs: ["tests"] })
  }
  return dedupe(out)
}

const q = (s: string) => (/[\s"']/.test(s) ? JSON.stringify(s) : s)

function dedupe(list: Ecosystem[]): Ecosystem[] {
  const seen = new Set<string>()
  return list.filter((e) => {
    const k = `${e.id}:${e.root}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** Root plus first-level workspace/package directories (monorepos), without descending into vendored dirs. */
async function candidateRoots(repoRoot: string): Promise<string[]> {
  const roots = [repoRoot]
  const SKIP = new Set(["node_modules", ".git", "build", "dist", ".dart_tool", "Pods", "vendor", ".dxcoder", "target", ".venv", "venv"])
  const MARKERS = ["pubspec.yaml", "package.json", "build.gradle", "build.gradle.kts", "gradlew", "go.mod", "pyproject.toml", "Cargo.toml", "Package.swift", "pom.xml"]
  const scan = async (dir: string, depth: number) => {
    if (depth > 4) return
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || SKIP.has(entry.name) || entry.name.startsWith(".")) continue
      const sub = join(dir, entry.name)
      const names = await readdir(sub).catch(() => [] as string[])
      if (MARKERS.some((m) => names.includes(m)) || names.some((n) => /\.(sln|csproj|fsproj|xcodeproj|xcworkspace)$/.test(n))) roots.push(sub)
      await scan(sub, depth + 1)
    }
  }
  await scan(repoRoot, 1)
  return roots
}

/** Picks the ecosystem whose root is the nearest ancestor of the given repo-relative paths. */
export function nearestEcosystems(ecosystems: Ecosystem[], paths: string[]): Ecosystem[] {
  if (ecosystems.length <= 1 || paths.length === 0) return ecosystems
  const picked = new Set<Ecosystem>()
  for (const p of paths) {
    let best: Ecosystem | undefined
    for (const e of ecosystems) {
      const root = e.root ? `${e.root}/` : ""
      if (p.startsWith(root) && (!best || root.length > (best.root ? best.root.length + 1 : 0))) best = e
    }
    if (best) picked.add(best)
  }
  return picked.size > 0 ? [...picked] : ecosystems
}

/** Applies option overrides (null = keep detected, "" = disable kind, string = replace). */
export function mergeOverrides(detected: Ecosystem[], overrides: FixoraOptions["testCommands"], timeoutMs: number): CheckCommand[] {
  const out: CheckCommand[] = []
  const overridden = new Set<CheckKind>()
  const add = (kind: CheckKind, command: string | undefined) => {
    if (command === undefined) return
    overridden.add(kind)
    if (command.trim()) out.push({ kind, command: command.trim(), cwd: "", timeoutMs })
  }
  add("lint", overrides.lint)
  add("typecheck", overrides.typecheck)
  add("unit", overrides.unit)
  add("integration", overrides.integration)
  for (const e of detected) for (const c of e.checks) if (!overridden.has(c.kind)) out.push({ ...c, timeoutMs })
  return out
}

export function isTestFile(path: string, ecosystems: Ecosystem[]): boolean {
  const patterns = ecosystems.length ? ecosystems.flatMap((e) => e.testFilePatterns) : [/(^|\/)(test|tests|spec|__tests__)\//, /[._-](test|spec)\.[a-z]+$/, /Tests?\.[a-z]+$/]
  return patterns.some((p) => p.test(path))
}

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
