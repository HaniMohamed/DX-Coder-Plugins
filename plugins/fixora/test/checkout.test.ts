import { describe, expect, test } from "bun:test"
import { manualRestoreCommands, markPrepared, markRestored, needsCheckout, needsPrepare, restorePlan } from "../src/checkout.js"
import { sampleRun } from "./state.test.js"

describe("checkout", () => {
  test("which steps need the fix branch", () => {
    expect(needsCheckout("detect")).toBe(false)
    expect(needsCheckout("fetch")).toBe(false)
    expect(needsCheckout("prepare")).toBe(true)
    expect(needsCheckout("fix")).toBe(true)
    expect(needsCheckout("publish")).toBe(true)
    expect(needsCheckout("restore")).toBe(false)
    expect(needsCheckout("done")).toBe(false)
  })

  test("markPrepared / markRestored keep the previous branch and the stash", () => {
    const run = sampleRun({ checkout: { active: false }, branch: undefined, base: { remote: "origin", branch: "main" } })
    expect(needsPrepare(run)).toBe(true)
    markPrepared(run, { previousBranch: "feature/x", previousHeadSha: "9fceb02a1b2c3d4e5f60718293a4b5c6d7e8f901", stashRef: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d", branch: "fixora/sentry-1-x", gitRoot: "/repo", baseSha: "b7e21c0ffee1234567890abcdef1234567890abcd", remoteUrl: "git@gitlab.example.com:mobile/shop.git", at: "2026-11-15T10:00:00.000Z" })
    expect(run.checkout).toEqual({ active: true, previousBranch: "feature/x", previousHeadSha: "9fceb02a1b2c3d4e5f60718293a4b5c6d7e8f901", stashRef: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d", preparedAt: "2026-11-15T10:00:00.000Z", restoredAt: undefined })
    expect(run.branch).toBe("fixora/sentry-1-x")
    expect(run.base.sha).toBe("b7e21c0ffee1234567890abcdef1234567890abcd")
    expect(run.base.remoteUrl).toBe("git@gitlab.example.com:mobile/shop.git")
    expect(needsPrepare(run)).toBe(false)
    const plan = restorePlan(run)
    expect(plan[1]).toBe("git checkout feature/x")
    expect(plan.some((l) => l.startsWith("git stash list"))).toBe(true)
    expect(plan.some((l) => l.startsWith("git stash pop"))).toBe(true)
    expect(manualRestoreCommands(run)).toEqual(["git checkout feature/x", 'git stash list   # find "fixora/sentry-4523123"', "git stash pop stash@{n}"])
    markRestored(run, "2026-11-15T10:30:00.000Z")
    expect(run.checkout.active).toBe(false)
    expect(run.checkout.restoredAt).toBe("2026-11-15T10:30:00.000Z")
    expect(run.checkout.stashRef).toBeDefined()
  })

  test("a detached HEAD restores to the commit; no stash → no stash steps", () => {
    const run = sampleRun({ checkout: { active: true, previousBranch: "HEAD", previousHeadSha: "9fceb02a1b2c3d4e5f60718293a4b5c6d7e8f901" } })
    const plan = restorePlan(run)
    expect(plan[1]).toBe("git checkout 9fceb02a1b2c3d4e5f60718293a4b5c6d7e8f901")
    expect(plan.some((l) => l.includes("stash"))).toBe(false)
  })
})
