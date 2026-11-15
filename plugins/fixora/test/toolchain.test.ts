import { describe, expect, test } from "bun:test"
import { DEFAULTS } from "../src/options.js"
import { applyOverrides, hasTestRunner, isTestFile, normalizeChecks, normalizeEcosystems, parseCheckOutput, requiredChecks } from "../src/toolchain.js"

describe("normalizeChecks / normalizeEcosystems", () => {
  test("reads what the prepare phase reported, drops junk, dedupes", () => {
    const checks = normalizeChecks([
      { kind: "lint", command: "flutter analyze", cwd: "./apps/mobile/" },
      { kind: "unit", command: " flutter test ", cwd: "apps/mobile" },
      { kind: "unit", command: "flutter test", cwd: "apps/mobile" },
      { kind: "nope", command: "x" },
      { command: "" },
      "garbage",
      { kind: "typecheck", command: "npx tsc --noEmit", optional: true },
    ])
    expect(checks).toEqual([
      { kind: "lint", command: "flutter analyze", cwd: "apps/mobile", optional: false },
      { kind: "unit", command: "flutter test", cwd: "apps/mobile", optional: false },
      { kind: "unit", command: "x", cwd: "", optional: false },
      { kind: "typecheck", command: "npx tsc --noEmit", cwd: "", optional: true },
    ])
    expect(normalizeChecks("nope")).toEqual([])
    expect(normalizeEcosystems([{ id: "Flutter", root: "./apps/mobile/" }, { id: "node", root: "" }, { id: "node", root: "" }, { root: "x" }])).toEqual([
      { id: "flutter", root: "apps/mobile" },
      { id: "node", root: "" },
    ])
  })
})

describe("applyOverrides / requiredChecks / hasTestRunner", () => {
  const reported = [
    { kind: "setup" as const, command: "bun install", cwd: "" },
    { kind: "lint" as const, command: "bun run lint", cwd: "" },
    { kind: "typecheck" as const, command: "bun run typecheck", cwd: "", optional: true },
    { kind: "unit" as const, command: "bun test", cwd: "" },
  ]
  test("option overrides replace or disable kinds; setup never stays in the plan", () => {
    const merged = applyOverrides(reported, { ...DEFAULTS.testCommands, unit: "bun test --bail", lint: "" })
    expect(merged.map((c) => `${c.kind}:${c.command}`)).toEqual(["unit:bun test --bail", "typecheck:bun run typecheck"])
    expect(applyOverrides(reported, DEFAULTS.testCommands).map((c) => c.command)).toEqual(["bun run lint", "bun run typecheck", "bun test"])
  })
  test("required = non-optional, non-setup", () => {
    expect(requiredChecks(reported).map((c) => c.command)).toEqual(["bun run lint", "bun test"])
    expect(hasTestRunner({ ecosystems: [], checks: reported, conventionFiles: [] })).toBe(true)
    expect(hasTestRunner({ ecosystems: [], checks: [reported[1]!], conventionFiles: [] })).toBe(false)
    expect(hasTestRunner(undefined)).toBe(false)
  })
})

describe("isTestFile", () => {
  test("per ecosystem patterns, generic fallback", () => {
    const eco = [{ id: "node", root: "" }, { id: "flutter", root: "apps/mobile" }, { id: "go", root: "services/api" }]
    expect(isTestFile("src/cart/service.test.ts", eco)).toBe(true)
    expect(isTestFile("apps/mobile/test/cart_test.dart", eco)).toBe(true)
    expect(isTestFile("services/api/cart/service_test.go", eco)).toBe(true)
    expect(isTestFile("src/cart/service.ts", eco)).toBe(false)
    expect(isTestFile("spec/x_spec.rb", [])).toBe(true)
    expect(isTestFile("Tests/FooTests.swift", [{ id: "spm", root: "" }])).toBe(true)
  })
})

describe("parseCheckOutput", () => {
  test("recognises common runners", () => {
    expect(parseCheckOutput("unit", " 34 pass\n 2 fail\n", "")).toMatchObject({ passed: 34, failed: 2 })
    expect(parseCheckOutput("unit", "Tests:       1 failed, 14 passed, 15 total", "")).toMatchObject({ passed: 14, failed: 1 })
    expect(parseCheckOutput("unit", "===== 12 passed, 1 failed in 0.5s =====", "")).toMatchObject({ passed: 12, failed: 1 })
    expect(parseCheckOutput("unit", "00:03 +42 -1: Some tests failed.", "")).toMatchObject({ passed: 42, failed: 1 })
    expect(parseCheckOutput("unit", "ok  \tgithub.com/acme/shop/cart\t0.1s\n--- FAIL: TestX\nFAIL", "")).toMatchObject({ failed: 1 })
    expect(parseCheckOutput("unit", "test result: ok. 7 passed; 0 failed;", "")).toMatchObject({ passed: 7, failed: 0 })
    expect(parseCheckOutput("lint", "", "src/x.ts:1:1 error no-unused-vars").summary).toContain("no-unused-vars")
  })
})
