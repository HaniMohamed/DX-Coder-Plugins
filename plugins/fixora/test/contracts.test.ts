import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseJsonFile, validateFix, validateOps, validatePrepare, validatePublish, validateReview, validateTicket, validateTriage } from "../src/contracts.js"

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
    expect(text).toContain("does not exist in the repository")
    expect(text).toContain("at least one mappedFrames entry")
    expect(text).toContain("rejected alternative")
    expect(text).toContain("looks like a generic credential")
  })

  test("non-fixable classifications need less", () => {
    const r = validateTriage({ version: 1, runId: "sentry-4523123", classification: "third_party_only", mappedFrames: [], rootCause: "all frames are in UIKit", category: "other", confidence: 0.7, confidenceReasons: [], suspectCommits: [], introducedInRelease: null, fixStrategy: "", alternatives: [], risk: { level: "low", notes: [] }, suggestedTests: [], relatedCrashes: [], flaggedContent: [] }, triageCtx)
    expect(r.ok).toBe(true)
  })

  test("a placeholder suspect-commit sha drops the entry instead of refusing the report", () => {
    const base = example("fixora-triage") as Record<string, unknown>
    const r = validateTriage(
      {
        ...base,
        suspectCommits: [
          { sha: "unknown", subject: "n/a", why: "no single commit stands out in git blame" },
          { sha: "HEAD", subject: "current tip", why: "the unchecked access has been there since the file was created" },
          { sha: "commit 3f2a1c9d (feat(cart): coupon expiry)", subject: "feat(cart): coupon expiry", why: "removed the null check" },
          { sha: "3f2a1c9", subject: "feat(cart): coupon expiry", date: "2026-11-02", why: "removed the null check" },
        ],
      },
      triageCtx,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.suspectCommits.map((c) => c.sha)).toEqual(["3f2a1c9d", "3f2a1c9"])
  })

  test("a suspect commit still needs subject and why", () => {
    const base = example("fixora-triage") as Record<string, unknown>
    const r = validateTriage({ ...base, suspectCommits: [{ sha: "3f2a1c9", why: "" }] }, triageCtx)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join("\n")).toContain("suspectCommits[0].subject is required")
    expect(r.errors.join("\n")).toContain("suspectCommits[0].why must be at least 5 characters")
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

  test("every required check must appear in commandsRun", () => {
    const ex = example("fixora-fix")
    const r = validateFix(ex, { ...fixCtx, requiredChecks: ["bun test src/cart", "bun run lint"] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("commandsRun does not contain `bun run lint`")
    expect(validateFix(ex, { ...fixCtx, requiredChecks: ["bun test"] }).ok).toBe(true) // prefix match
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

const SHA = "9fceb02a1b2c3d4e5f60718293a4b5c6d7e8f901"

describe("validatePrepare", () => {
  const ctx = { runId: "sentry-1", branchPrefix: "fixora/", baseBranch: "main" }
  const base = { version: 1, runId: "sentry-1", repoRoot: "/repo", previousBranch: "main", previousHeadSha: SHA, conventionFiles: [], notes: [] }
  test("inspect stage reports a dirty checkout; ready stage needs branch, shas and a stash when dirty", () => {
    const inspect = validatePrepare({ ...base, stage: "inspect", dirty: true, status: " M a.ts\n", dirtyFiles: 1 }, ctx)
    expect(inspect.ok && inspect.value.dirty).toBe(true)
    expect(validatePrepare({ ...base, stage: "inspect", dirty: true }, ctx).ok).toBe(false)
    const ready = validatePrepare({ ...base, stage: "ready", dirty: false, baseRef: "origin/main", baseSha: SHA, remoteUrl: null, branch: "fixora/sentry-1-x", created: true, toolchain: { ecosystems: [], checks: [], setup: [] } }, ctx)
    if (!ready.ok) throw new Error(ready.errors.join("; "))
    expect(ready.value.remoteUrl).toBeNull()
    const dirtyNoStash = validatePrepare({ ...base, stage: "ready", dirty: true, baseRef: "origin/main", baseSha: SHA, branch: "fixora/x", toolchain: { ecosystems: [], checks: [] } }, ctx)
    expect(!dirtyNoStash.ok && dirtyNoStash.errors.join()).toContain("no stashRef")
    const badBranch = validatePrepare({ ...base, stage: "ready", dirty: false, baseRef: "origin/main", baseSha: SHA, branch: "feature/x", toolchain: { ecosystems: [], checks: [] } }, ctx)
    expect(!badBranch.ok && badBranch.errors.join()).toContain('must start with "fixora/"')
    const wrongBranch = validatePrepare({ ...base, stage: "ready", dirty: false, baseRef: "origin/main", baseSha: SHA, branch: "fixora/other", toolchain: { ecosystems: [], checks: [] } }, { ...ctx, existingBranch: "fixora/sentry-1-x" })
    expect(!wrongBranch.ok && wrongBranch.errors.join()).toContain("already uses branch")
    expect(validatePrepare({ ...base, stage: "inspect", dirty: true, status: " M a.ts\n", branch: "fixora/sentry-1-x" }, ctx).ok).toBe(true)
    const notExact = validatePrepare({ ...base, stage: "ready", dirty: false, baseRef: "origin/main", baseSha: SHA, branch: "fixora/fix/other", toolchain: { ecosystems: [], checks: [] } }, { ...ctx, expectedBranch: "fixora/fix/DE-456-x" })
    expect(!notExact.ok && notExact.errors.join()).toContain('use exactly that name (got "fixora/fix/other")')
    expect(validatePrepare({ ...base, stage: "ready", dirty: false, baseRef: "origin/main", baseSha: SHA, branch: "fixora/fix/DE-456-x", toolchain: { ecosystems: [], checks: [] } }, { ...ctx, expectedBranch: "fixora/fix/DE-456-x" }).ok).toBe(true)
    const blocked = validatePrepare({ version: 1, runId: "sentry-1", stage: "inspect", blocked: "base-missing", blockedDetail: "no such ref" }, ctx)
    expect(blocked.ok && blocked.value.blocked).toBe("base-missing")
    expect(validatePrepare({ ...base, stage: "ready", stashRef: "nothex" }, ctx).ok).toBe(false)
  })
})

describe("validateTicket / validatePublish / validateOps", () => {
  test("ticket keys and actions", () => {
    expect(validateTicket({ version: 1, runId: "r", action: "created", key: "APP-12", url: "https://j/browse/APP-12" }, { runId: "r" }).ok).toBe(true)
    expect(validateTicket({ version: 1, runId: "r", action: "created", key: "nope" }, { runId: "r" }).ok).toBe(false)
    expect(validateTicket({ version: 1, runId: "r", action: "failed" }, { runId: "r" }).ok).toBe(false)
    expect(validateTicket({ version: 1, runId: "r", action: "failed", error: "403" }, { runId: "r" }).ok).toBe(true)
  })
  test("publish: parts only when granted, the run's branch, hex shas, MR urls; partial results accepted", () => {
    const ctx = { runId: "r", grants: { commit: true, push: true, mr: true }, branch: "fixora/r-x", remote: "origin" }
    const ok = validatePublish({ version: 1, runId: "r", committed: { sha: SHA, files: ["a.ts"] }, pushed: { remote: "origin", branch: "fixora/r-x", remoteSha: SHA }, mr: { url: "https://github.com/a/b/pull/7", provider: "gh" }, errors: [] }, ctx)
    if (!ok.ok) throw new Error(ok.errors.join("; "))
    expect(ok.value.mr?.id).toBe("7")
    const partial = validatePublish({ version: 1, runId: "r", committed: { sha: SHA, files: [] }, errors: ["push: remote rejected"] }, ctx)
    expect(partial.ok).toBe(true)
    const bad = validatePublish({ version: 1, runId: "r", committed: { sha: "zz" }, pushed: { remote: "origin", branch: "main" }, mr: { url: "https://x/y", provider: "glab" }, errors: [] }, { ...ctx, grants: { commit: true } })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.errors.join("\n")).toContain("hex commit id")
      expect(bad.errors.join("\n")).toContain('branch must be "fixora/r-x"')
      expect(bad.errors.join("\n")).toContain("push was not granted")
      expect(bad.errors.join("\n")).toContain("not granted in this phase")
      expect(bad.errors.join("\n")).toContain("merge request / pull request URL")
    }
    expect(validatePublish({ version: 1, runId: "r", errors: [] }, ctx).ok).toBe(false)
  })
  test("ops", () => {
    expect(validateOps({ version: 1, runId: "r", op: "restore", ok: true, results: { branch: "main" }, errors: [] }, { runId: "r" }).ok).toBe(true)
    expect(validateOps({ version: 1, runId: "r", op: "restore", ok: false, results: {}, errors: [] }, { runId: "r" }).ok).toBe(false)
    expect(validateOps({ version: 1, op: "sync", ok: true, results: { status: "merged" }, errors: [] }, {}).ok).toBe(true)
    expect(validateOps({ version: 1, runId: "other", op: "clean", ok: true, errors: [] }, { runId: "r" }).ok).toBe(false)
  })
})
