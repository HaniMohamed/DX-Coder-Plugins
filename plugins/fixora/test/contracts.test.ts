import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseJsonFile, validateFix, validateReview, validateTriage } from "../src/contracts.js"

const example = (skill: string) => {
  const text = readFileSync(join(import.meta.dir, "..", "skills", skill, "SKILL.md"), "utf8")
  const m = /```json\n([\s\S]*?)```/.exec(text)
  if (!m) throw new Error(`no JSON example in ${skill}`)
  return JSON.parse(m[1]!) as Record<string, unknown>
}

const triageCtx = { runId: "sentry-4523123", fileExists: (p: string) => p === "src/cart/service.ts" }

describe("validateTriage", () => {
  test("accepts the skill example and normalises optional fields", () => {
    const r = validateTriage(example("fixora-triage"), triageCtx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.classification).toBe("fixable")
    expect(r.value.introducedInRelease).toBeNull()
    expect(r.value.mappedFrames[0]!.file).toBe("src/cart/service.ts")
  })

  test("rejects wrong runId, missing files, bad confidence, missing alternatives, secrets", () => {
    const bad = { ...example("fixora-triage"), runId: "other", confidence: 1.5, alternatives: [], mappedFrames: [{ index: 0, file: "src/missing.ts", evidence: "line 1 does it" }], fixStrategy: `token = "abcdefghijklmnopqrstuvwxyz"` }
    const r = validateTriage(bad, triageCtx)
    expect(r.ok).toBe(false)
    if (r.ok) return
    const text = r.errors.join("\n")
    expect(text).toContain('runId must be "sentry-4523123"')
    expect(text).toContain("confidence must be <= 1")
    expect(text).toContain("does not exist in the worktree")
    expect(text).toContain("at least one mappedFrames entry")
    expect(text).toContain("rejected alternative")
    expect(text).toContain("looks like a generic credential")
  })

  test("non-fixable classifications need less", () => {
    const r = validateTriage({ version: 1, runId: "sentry-4523123", classification: "third_party_only", mappedFrames: [], rootCause: "all frames are in UIKit", category: "other", confidence: 0.7, confidenceReasons: [], suspectCommits: [], introducedInRelease: null, fixStrategy: "", alternatives: [], risk: { level: "low", notes: [] }, suggestedTests: [], relatedCrashes: [], flaggedContent: [] }, triageCtx)
    expect(r.ok).toBe(true)
  })
})

const fixCtx = {
  runId: "sentry-4523123",
  attempt: 1,
  changedFiles: ["src/cart/service.ts", "src/cart/service.test.ts"],
  forbidden: (p: string) => (p.endsWith(".lock") ? "lockfile" : undefined),
  maxFilesChanged: 10,
  hasTestRunner: true,
  requireTestChange: true,
  isTestFile: (p: string) => /\.test\./.test(p),
  testFirst: false,
}

describe("validateFix", () => {
  test("accepts the skill example", () => {
    const r = validateFix(example("fixora-fix"), fixCtx)
    expect(r.ok).toBe(true)
  })

  test("filesChanged must match git in both directions; forbidden paths and limits", () => {
    const ex = example("fixora-fix")
    const r = validateFix({ ...ex, filesChanged: ["src/cart/service.ts"] }, { ...fixCtx, changedFiles: ["src/cart/service.ts", "src/cart/service.test.ts", "bun.lock"], maxFilesChanged: 2 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    const text = r.errors.join("\n")
    expect(text).toContain('missing "src/cart/service.test.ts"')
    expect(text).toContain('"bun.lock" must not be changed: lockfile')
    expect(text).toContain("3 files changed, limit is 2")
    const r2 = validateFix({ ...ex, filesChanged: ["src/cart/service.ts", "src/cart/service.test.ts", "src/other.ts"] }, fixCtx)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.errors.join("\n")).toContain('lists "src/other.ts" but git reports no change')
  })

  test("requires a test change and commands, unless unresolved explains", () => {
    const ex = example("fixora-fix")
    const r = validateFix({ ...ex, filesChanged: ["src/cart/service.ts"], testsAdded: [], commandsRun: [] }, { ...fixCtx, changedFiles: ["src/cart/service.ts"] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.join("\n")).toContain("no test file was added or changed")
      expect(r.errors.join("\n")).toContain("commandsRun is empty")
    }
    const r2 = validateFix({ ...ex, filesChanged: ["src/cart/service.ts"], testsAdded: [], unresolved: ["no test harness for native code"] }, { ...fixCtx, changedFiles: ["src/cart/service.ts"] })
    expect(r2.ok).toBe(true)
  })

  test("test-first mode requires the reproduction evidence; changesMade=false needs no files", () => {
    const ex = example("fixora-fix")
    const r = validateFix({ ...ex, reproduction: { mode: "test-first", failingBefore: false, passingAfter: true } }, { ...fixCtx, testFirst: true })
    expect(r.ok).toBe(false)
    const r2 = validateFix({ ...ex, changesMade: false, filesChanged: [], commandsRun: [], testsAdded: [], unresolved: ["needs a product decision"] }, { ...fixCtx, changedFiles: [] })
    expect(r2.ok).toBe(true)
  })
})

describe("validateReview", () => {
  const ctx = { runId: "sentry-4523123", attempt: 1, knownFiles: ["src/cart/service.ts", "src/cart/service.test.ts"] }
  test("accepts the skill example and keeps reject", () => {
    const r = validateReview(example("fixora-review"), ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.verdict).toBe("reject")
  })

  test("recomputes consistency: blocker ⇒ reject, minors ⇒ approve_with_nits, rootCauseAddressed=false ⇒ reject", () => {
    const base = example("fixora-review")
    const r = validateReview({ ...base, verdict: "approve" }, ctx)
    if (!r.ok) throw new Error(r.errors.join())
    expect(r.value.verdict).toBe("reject")
    const nits = validateReview({ ...base, verdict: "approve", findings: [base.findings![1 as never]] }, ctx)
    if (!nits.ok) throw new Error(nits.errors.join())
    expect(nits.value.verdict).toBe("approve_with_nits")
    const rc = validateReview({ ...base, verdict: "approve", findings: [], rootCauseAddressed: false }, ctx)
    if (!rc.ok) throw new Error(rc.errors.join())
    expect(rc.value.verdict).toBe("reject")
  })

  test("findings must cite known files", () => {
    const base = example("fixora-review")
    const r = validateReview({ ...base, findings: [{ category: "scope", severity: "major", file: "src/elsewhere.ts", message: "unrelated change here" }] }, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain("not in the diff")
  })
})

describe("parseJsonFile", () => {
  test("reports invalid JSON", () => {
    const r = parseJsonFile("{nope", () => ({ ok: true, value: 1 }))
    expect(r.ok).toBe(false)
  })
})
