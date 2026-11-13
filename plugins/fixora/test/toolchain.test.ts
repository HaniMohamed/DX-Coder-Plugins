import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULTS } from "../src/options.js"
import { detectEcosystems, isTestFile, mergeOverrides, nearestEcosystems, parseCheckOutput } from "../src/toolchain.js"
import { checkChangedFiles, isToolMissing, summarizeChecks } from "../src/validate.js"

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fixora-toolchain-"))
  const put = async (p: string, content = "") => {
    await mkdir(join(root, p, ".."), { recursive: true })
    await writeFile(join(root, p), content)
  }
  await put("package.json", JSON.stringify({ name: "shop", scripts: { lint: "eslint .", test: "vitest run", typecheck: "tsc --noEmit", "test:integration": "vitest run -c it" } }))
  await put("pnpm-lock.yaml")
  await put("tsconfig.json", "{}")
  await put("apps/mobile/pubspec.yaml", "name: my_app\ndependencies:\n  flutter:\n    sdk: flutter\n")
  await put("apps/mobile/integration_test/app_test.dart")
  await put("apps/mobile/android/gradlew", "#!/bin/sh")
  await put("services/api/go.mod", "module github.com/acme/shop\n")
  await put("services/py/pyproject.toml", "[tool.ruff]\nline-length = 100\n")
  await put("services/net/Shop.sln")
  await put("node_modules/skip/package.json", "{}")
})
afterAll(() => rm(root, { recursive: true, force: true }))

describe("detectEcosystems", () => {
  test("finds root and nested ecosystems with the right commands", async () => {
    const eco = await detectEcosystems(root)
    const ids = eco.map((e) => `${e.id}@${e.root}`)
    expect(ids).toContain("node@")
    expect(ids).toContain("flutter@apps/mobile")
    expect(ids).toContain("gradle@apps/mobile/android")
    expect(ids).toContain("go@services/api")
    expect(ids).toContain("python@services/py")
    expect(ids).toContain("dotnet@services/net")
    expect(ids.some((i) => i.includes("node_modules"))).toBe(false)
    const node = eco.find((e) => e.id === "node")!
    expect(node.checks.map((c) => c.command)).toEqual(["pnpm run lint", "pnpm run typecheck", "pnpm run test", "pnpm run test:integration"])
    expect(node.subset!(["src/x.test.ts"])).toBe("pnpm exec vitest run src/x.test.ts")
    const flutter = eco.find((e) => e.id === "flutter")!
    expect(flutter.checks.map((c) => c.command)).toEqual(["flutter analyze", "flutter test", "flutter test integration_test"])
    expect(flutter.subset!(["test/cart_test.dart"])).toBe("flutter test test/cart_test.dart")
    const py = eco.find((e) => e.id === "python")!
    expect(py.checks.map((c) => c.command)).toContain("ruff check .")
    expect(py.checks.map((c) => c.command)).toContain("pytest -q")
    const go = eco.find((e) => e.id === "go")!
    expect(go.subset!(["cart/service_test.go", "cmd/api/main_test.go"])).toBe("go test ./cart/... ./cmd/api/...")
  })

  test("nearestEcosystems picks the deepest root for mapped paths", async () => {
    const eco = await detectEcosystems(root)
    expect(nearestEcosystems(eco, ["apps/mobile/lib/x.dart"]).map((e) => e.id)).toEqual(["flutter"])
    expect(nearestEcosystems(eco, ["apps/mobile/android/app/src/main/A.kt"]).map((e) => e.id)).toEqual(["gradle"])
    expect(nearestEcosystems(eco, ["src/x.ts"]).map((e) => e.id)).toEqual(["node"])
    expect(nearestEcosystems(eco, []).length).toBe(eco.length)
  })

  test("mergeOverrides replaces or disables kinds", async () => {
    const eco = (await detectEcosystems(root)).filter((e) => e.id === "node")
    const merged = mergeOverrides(eco, { ...DEFAULTS.testCommands, unit: "bun test", lint: "" }, 1000)
    expect(merged.map((c) => `${c.kind}:${c.command}`)).toEqual(["unit:bun test", "typecheck:pnpm run typecheck", "integration:pnpm run test:integration"])
    expect(merged.every((c) => c.timeoutMs === 1000)).toBe(true)
  })

  test("isTestFile", async () => {
    const eco = await detectEcosystems(root)
    expect(isTestFile("src/cart/service.test.ts", eco)).toBe(true)
    expect(isTestFile("apps/mobile/test/cart_test.dart", eco)).toBe(true)
    expect(isTestFile("services/api/cart/service_test.go", eco)).toBe(true)
    expect(isTestFile("src/cart/service.ts", eco)).toBe(false)
    expect(isTestFile("spec/x_spec.rb", [])).toBe(true)
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

describe("checkChangedFiles / summarizeChecks", () => {
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
