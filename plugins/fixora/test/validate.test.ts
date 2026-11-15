import { describe, expect, test } from "bun:test"
import { parsePorcelain } from "../src/git.js"
import { checkChangedFiles, diffStats, filterDiff, isToolMissing, kindOfCommand, reportFromCommands, splitDiff, summarizeChecks, summaryFromSubmission } from "../src/validate.js"

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " x",
  "+y",
  "-z",
  "diff --git a/bun.lock b/bun.lock",
  "--- a/bun.lock",
  "+++ b/bun.lock",
  "@@ -1 +1,2 @@",
  "+lock",
  "+lock2",
  "diff --git a/test/a.test.ts b/test/a.test.ts",
  "--- /dev/null",
  "+++ b/test/a.test.ts",
  "@@ -0,0 +1,2 @@",
  "+t1",
  "+t2",
].join("\n")

describe("parsePorcelain", () => {
  test("newline and NUL formats, renames, untracked, directories dropped", () => {
    expect(parsePorcelain(" M src/a.ts\n?? test/a.test.ts\nA  new.ts\n D gone.ts\nR  old.ts -> new2.ts\n!! ignored.log\n?? dir/\n")).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "test/a.test.ts", status: "untracked" },
      { path: "new.ts", status: "added" },
      { path: "gone.ts", status: "deleted" },
      { path: "new2.ts", status: "renamed" },
    ])
    expect(parsePorcelain("R  new2.ts\0old.ts\0 M src\\win.ts\0")).toEqual([
      { path: "new2.ts", status: "renamed" },
      { path: "src/win.ts", status: "modified" },
    ])
    expect(parsePorcelain("")).toEqual([])
  })
})

describe("diffs", () => {
  test("splitDiff / filterDiff / diffStats", () => {
    expect(splitDiff(DIFF).map((s) => s.path)).toEqual(["src/a.ts", "bun.lock", "test/a.test.ts"])
    const kept = filterDiff(DIFF, (p) => p !== "bun.lock")
    expect(kept).not.toContain("lock2")
    expect(kept).toContain("+t2")
    expect(diffStats(kept)).toEqual({ added: 3, deleted: 1 })
    expect(filterDiff("no headers here\n+x", () => false)).toBe("no headers here\n+x")
  })

  test("summaryFromSubmission drops generated paths from both status and diff", () => {
    const s = summaryFromSubmission({ status: " M src/a.ts\n?? test/a.test.ts\n M bun.lock\n M .dart_tool/x\n", diff: DIFF })
    expect(s.paths).toEqual(["src/a.ts", "test/a.test.ts"])
    expect(s.added).toBe(3)
    expect(s.deleted).toBe(1)
    expect(s.diff).not.toContain("bun.lock")
    expect(s.diffHash).toHaveLength(16)
    expect(summaryFromSubmission({ status: s.files, diff: s.diff }).diffHash).toBe(s.diffHash)
  })
})

describe("checkChangedFiles / summarizeChecks / isToolMissing", () => {
  test("limits and forbidden paths", () => {
    const limits = { denyPaths: ["docs/**"], maxFiles: 2, maxLines: 50 }
    expect(checkChangedFiles({ paths: ["src/a.ts"], added: 10, deleted: 2 }, limits)).toEqual([])
    const problems = checkChangedFiles({ paths: ["src/a.ts", "bun.lock", "docs/x.md"], added: 60, deleted: 0 }, limits)
    expect(problems.join("\n")).toContain("bun.lock: matches protected pattern")
    expect(problems.join("\n")).toContain("docs/x.md: matches protected pattern docs/**")
    expect(problems.join("\n")).toContain("3 files changed (limit 2)")
    expect(problems.join("\n")).toContain("60 diff lines (limit 50)")
  })
  test("summaries and missing tools", () => {
    const r = { kind: "unit" as const, command: "bun test", cwd: "", exitCode: 0, durationMs: 10, outputTail: "", summary: "3 passed" }
    expect(summarizeChecks({ diffHash: "x", commands: [r, { ...r, kind: "lint", exitCode: 1, summary: "" }], allPassed: false })).toBe("unit ✓ (3 passed) · lint ✗")
    expect(isToolMissing({ ...r, exitCode: 127, outputTail: "sh: tsc: command not found" })).toBe(true)
    expect(isToolMissing({ ...r, exitCode: 1, outputTail: "1 fail" })).toBe(false)
  })
})

describe("reportFromCommands", () => {
  const checks = [
    { kind: "lint" as const, command: "bun run lint", cwd: "" },
    { kind: "typecheck" as const, command: "bunx tsc --noEmit", cwd: "", optional: true },
    { kind: "unit" as const, command: "bun test", cwd: "" },
  ]
  test("kinds come from the plan or the command text; counts from the output; optional missing tools pass", () => {
    const report = reportFromCommands(
      [
        { command: "bun run lint", exitCode: 0, durationMs: 100, summary: "clean" },
        { command: "bunx tsc --noEmit", exitCode: 127, durationMs: 5, summary: "", outputTail: "bunx: command not found: tsc" },
        { command: "bun test src/cart", exitCode: 0, durationMs: 900, summary: "", outputTail: " 14 pass\n 0 fail" },
        { command: "flutter analyze", exitCode: 1, durationMs: 1, summary: "2 issues", cwd: "apps/mobile" },
      ],
      "h1",
      checks,
    )
    expect(report.commands.map((c) => `${c.kind}:${c.cwd}:${c.exitCode}`)).toEqual(["lint::0", "typecheck::127", "unit::0", "lint:apps/mobile:1"])
    expect(report.commands[2]).toMatchObject({ passed: 14, failed: 0, summary: "14 passed, 0 failed" })
    expect(report.allPassed).toBe(false)
    expect(reportFromCommands([{ command: "bunx tsc --noEmit", exitCode: 127, durationMs: 5, summary: "command not found" }], "h", checks).allPassed).toBe(true)
    expect(kindOfCommand("go vet ./...", [])).toBe("typecheck")
    expect(kindOfCommand("pytest -q", [])).toBe("unit")
    expect(kindOfCommand("bun run lint -- src", checks)).toBe("lint")
  })
})
