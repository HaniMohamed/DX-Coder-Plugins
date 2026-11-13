// End-to-end: a pasted crash on a tiny Bun project → worktree → scripted worker (triage, fix with a
// real test file, review) → real `bun test` checks → secret scan → commit → approval → push to a
// bare remote → MR fallback (local remote has no forge) → done. Then feedback and restart flows.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runFeedback, runFix, runPaste, runRestart, runRetry, runStatus, startPipeline } from "../src/flows.js"
import { git, runGit } from "../src/git.js"
import { readOptions } from "../src/options.js"
import type { Runtime } from "../src/progress.js"
import { loadRun } from "../src/state.js"
import { registerPluginTools } from "../src/tools.js"
import { detectEcosystems } from "../src/toolchain.js"
import { mockCtx, type MockCtx, type Worker } from "./mock-ctx.js"

let root: string
let remote: string
let repo: string
let mock: MockCtx
let rt: Runtime

const SERVICE = `export function applyCoupon(c: { id: string } | undefined) {\n  return c.id\n}\n`
const FIXED = `export function applyCoupon(c: { id: string } | undefined) {\n  if (!c) return undefined\n  return c.id\n}\n`
const TEST = `import { expect, test } from "bun:test"\nimport { applyCoupon } from "./service"\ntest("returns undefined for a missing coupon", () => {\n  expect(applyCoupon(undefined)).toBeUndefined()\n})\n`

/** The scripted worker: reacts to the skill it is asked to follow. */
const worker: Worker = async (prompt, session, tool) => {
  const skill = prompt.skills?.[0]?.id
  const runId = /run (\S+?)[:,]/.exec(prompt.text)?.[1] ?? /runId "([^"]+)"/.exec(prompt.text)![1]!
  const call = (name: string, input: unknown) => tool(name).execute(input, { sessionID: session.id, agent: "build", messageID: "m", id: "c", signal: new AbortController().signal, progress: async () => {} })
  if (skill === "fixora-triage") {
    const r = await call("fixora_submit_triage", {
      version: 1,
      runId,
      classification: "fixable",
      mappedFrames: [{ index: 0, file: "src/cart/service.ts", line: 2, function: "applyCoupon", evidence: "line 2 reads c.id without a guard" }],
      rootCause: "applyCoupon dereferences its argument, which is undefined when the coupon lookup fails upstream.",
      category: "null-deref",
      confidence: 0.9,
      confidenceReasons: ["frame maps exactly"],
      suspectCommits: [],
      introducedInRelease: null,
      fixStrategy: "Return undefined early when the coupon is missing.",
      alternatives: [{ strategy: "throw a typed error", rejectedBecause: "callers expect undefined" }],
      risk: { level: "low", notes: [] },
      suggestedTests: ["applyCoupon(undefined) returns undefined"],
      relatedCrashes: [],
      flaggedContent: [],
    })
    if ((r.output as { ok: boolean }).ok !== true) throw new Error(`triage rejected: ${r.content}`)
    return
  }
  if (skill === "fixora-fix") {
    const wt = session.location!.directory
    const attempt = Number(/attempt (\d+)/.exec(prompt.text)?.[1] ?? "1")
    const feedback = /feedback from the user/.test(prompt.text)
    if (feedback && /question:/i.test(prompt.text)) {
      await call("fixora_submit_fix", { version: 1, runId, attempt, summary: "Answered a question", filesChanged: [], rationale: "No change: the guard already handles both undefined and null.", alternativesRejected: [], testsAdded: [], commandsRun: [], risk: { level: "low", publicApiChange: false, behaviourChange: "", rollback: "" }, changesMade: false, unresolved: [] })
      return
    }
    await writeFile(join(wt, "src", "cart", "service.ts"), feedback ? FIXED.replace("if (!c)", "if (c == null)") : FIXED)
    await writeFile(join(wt, "src", "cart", "guard.test.ts"), feedback ? `${TEST}test("returns undefined for null", () => {\n  expect(applyCoupon(null as never)).toBeUndefined()\n})\n` : TEST)
    const r = await call("fixora_submit_fix", {
      version: 1,
      runId,
      attempt,
      summary: feedback ? "Also guard null coupons" : "Guard missing coupon in applyCoupon",
      filesChanged: ["src/cart/service.ts", "src/cart/guard.test.ts"],
      rationale: "Return early when the coupon is missing instead of dereferencing undefined; mirrors the guard style in src/cart.",
      alternativesRejected: [{ strategy: "throw", reason: "callers expect undefined" }],
      testsAdded: [{ file: "src/cart/guard.test.ts", name: "returns undefined for a missing coupon", kind: "regression" }],
      commandsRun: [{ command: "bun test", exitCode: 0, durationMs: 100, summary: "2 pass" }],
      risk: { level: "low", publicApiChange: false, behaviourChange: "missing coupons yield undefined", rollback: "revert the commit" },
      changesMade: true,
      unresolved: [],
    })
    if ((r.output as { ok: boolean }).ok !== true) throw new Error(`fix rejected: ${r.content}`)
    return
  }
  if (skill === "fixora-review") {
    const attempt = Number(/attempt (\d+)/.exec(prompt.text)?.[1] ?? "1")
    await call("fixora_submit_review", { version: 1, runId, attempt, verdict: "approve", rootCauseAddressed: true, regressionTestPresent: true, findings: [], summary: "Minimal guard with a regression test; nothing to object to." })
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fixora-e2e-"))
  remote = join(root, "remote.git")
  repo = join(root, "repo")
  await runGit(root, ["init", "--bare", "--initial-branch=main", remote])
  await runGit(root, ["clone", "--quiet", remote, repo])
  await runGit(repo, ["config", "user.email", "t@example.com"])
  await runGit(repo, ["config", "user.name", "T"])
  await mkdir(join(repo, "src", "cart"), { recursive: true })
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "shop", type: "module", scripts: { test: "bun test" } }))
  await writeFile(join(repo, "bun.lock"), "")
  await writeFile(join(repo, "src", "cart", "service.ts"), SERVICE)
  await writeFile(join(repo, "src", "cart", "service.test.ts"), `import { expect, test } from "bun:test"\nimport { applyCoupon } from "./service"\ntest("id", () => { expect(applyCoupon({ id: "a" })).toBe("a") })\n`)
  await writeFile(join(repo, "trace.txt"), `TypeError: Cannot read properties of undefined (reading 'id')\n    at applyCoupon (src/cart/service.ts:2:12)\n    at pay (src/checkout.ts:40:5)\n`)
  await runGit(repo, ["add", "."])
  await runGit(repo, ["commit", "--quiet", "-m", "init"])
  await runGit(repo, ["push", "--quiet", "-u", "origin", "main"])

  const options = { jira: { project: undefined }, testCommands: { fullSuiteMaxMinutes: 1 }, worktree: { root: join(root, "worktrees") } }
  mock = mockCtx({ directory: repo, options, worker, worktreeRoot: join(root, "worktrees") })
  await mkdir(join(root, "worktrees"), { recursive: true })
  const opts = readOptions(options)
  if (!opts.ok) throw new Error(opts.errors.join())
  rt = { ctx: mock.ctx, opts: opts.value, services: {}, emit: async (name, data) => void mock.rpcEvents.push({ name, data }), inflight: new Map() }
  await registerPluginTools(mock.ctx, {
    options: () => rt.opts,
    ecosystems: async (runId) => {
      const run = await loadRun(mock.ctx, runId)
      return run?.worktree ? detectEcosystems(run.worktree) : []
    },
    hasTestRunner: async () => true,
    isWorkerSession: async (id) => mock.sessions.has(id),
    start: async () => ({ started: [], errors: [] }),
  })
})
afterAll(() => rm(root, { recursive: true, force: true }))

describe("pipeline end to end", () => {
  let runId: string

  test("paste → draft MR fallback (local remote) with everything verified", async () => {
    const run = await runPaste(rt, { sessionID: "origin", file: "trace.txt", flags: { dryRun: false, ticket: true, mr: true, push: true, auto: false, force: false, forceTriage: false } })
    runId = run.runId
    if (run.status !== "done") throw new Error(`${run.status} at ${run.step}: ${run.error}\n${mock.synthetics.map((s) => s.description).join("\n")}`)
    expect(run.runId.startsWith("manual-")).toBe(true)
    expect(run.pipeline).toMatchObject({ analysed: true, fixed: true, validated: true, reviewed: true, committed: true, pushed: true, mrOpened: false, loopClosed: true })
    expect(run.approvals.ticket).toBe("skipped")
    expect(run.approvals.publish).toBe("approved")
    expect(run.triage?.confidence).toBe(0.9)
    expect(run.tests?.allPassed).toBe(true)
    expect(run.tests?.commands.map((c) => c.command)).toEqual(["bun test src/cart/guard.test.ts", "bun test"])
    expect(run.reviews[0]?.verdict).toBe("approve")
    expect(run.commitShas).toHaveLength(1)
    expect(run.branch!.startsWith("fixora/manual-")).toBe(true)
    expect(await git.remoteBranchSha(repo, "origin", run.branch!)).toBe(run.commitShas[0])
    expect(run.mrUrl).toBeUndefined()
    expect(String(run.meta?.compareUrl ?? "")).toBe("") // local path remote: nothing to link
    // The approval dialog carried human-readable resources and the preview path.
    const publish = mock.permissionRequests.find((p) => p.action === "fixora.publish")!
    expect(publish.resources.some((r) => r.startsWith("push branch fixora/"))).toBe(true)
    expect(publish.resources.some((r) => r.includes("checks: unit ✓"))).toBe(true)
    expect(existsSync(join(run.folder, "publish-preview.md"))).toBe(true)
    // Artefacts in the run folder.
    for (const f of ["crash.json", "crash.md", "mapping.md", "project.md", "triage.json", "fix.1.json", "diff.1.patch", "verification.1.json", "review.1.json", "commit-message.txt", "mr.md", "run.log"]) expect(existsSync(join(run.folder, f))).toBe(true)
    const commitMessage = readFileSync(join(run.folder, "commit-message.txt"), "utf8")
    expect(commitMessage.startsWith("fix(cart): Guard missing coupon in applyCoupon")).toBe(true)
    expect(commitMessage).toContain(`Fixora-Run: ${run.runId}`)
    // Worker sessions ran in the worktree with confined permissions; reviewer was a separate session.
    const fixer = mock.sessions.get(run.sessions.fixer!)!
    expect(fixer.location?.directory).toBe(run.worktree)
    expect(Array.isArray(fixer.permissions)).toBe(true)
    expect(run.sessions.reviewer).not.toBe(run.sessions.fixer)
    expect(fixer.prompts.map((p) => p.skills?.[0]?.id)).toEqual(["fixora-triage", "fixora-fix"])
    // Progress rows and RPC events were emitted; the final report was presented.
    expect(mock.rpcEvents.some((e) => e.name === "run.started")).toBe(true)
    expect(mock.rpcEvents.filter((e) => e.name === "run.stage").length).toBeGreaterThan(10)
    expect(mock.rpcEvents.some((e) => e.name === "run.done")).toBe(true)
    const final = mock.synthetics.filter((s) => s.resume).pop()!
    expect(final.text).toContain("finished in")
    expect(final.text).toContain(run.branch!)
    // The main checkout was never touched.
    expect(await git.isClean(repo)).toBe(true)
    expect(await git.currentBranch(repo)).toBe("main")
  })

  test("re-running the same crash is refused; status renders; retry of a done run is refused", async () => {
    await expect(runFix(rt, { sessionID: "origin", ref: `manual:${runId.replace("manual-", "")}`, flags: { dryRun: false, ticket: true, mr: true, push: true, auto: false, force: false, forceTriage: false } })).rejects.toThrow("already")
    await runStatus(rt, { sessionID: "origin", runId })
    expect(mock.synthetics.pop()!.text).toContain("| analyse | ok |")
    await expect(runRetry(rt, { sessionID: "origin", runId, fresh: false, flags: { dryRun: false, ticket: true, mr: true, push: true, auto: false, force: false, forceTriage: false } })).rejects.toThrow("already done")
  })

  test("feedback: a question gets an answer without changes; a change request re-runs validate → push", async () => {
    mock.synthetics.length = 0
    const answered = await runFeedback(rt, { sessionID: "origin", runId, message: "Question: does the guard also cover null?" })
    expect(answered.counters.feedback).toBe(1)
    expect(answered.commitShas).toHaveLength(1)
    const changed = await runFeedback(rt, { sessionID: "origin", runId, message: "also guard null coupons" })
    if (changed.status !== "done") throw new Error(`${changed.status} at ${changed.step}: ${changed.error}`)
    expect(changed.counters.feedback).toBe(2)
    expect(changed.commitShas).toHaveLength(2)
    expect(changed.reviews).toHaveLength(2)
    expect(await git.remoteBranchSha(repo, "origin", changed.branch!)).toBe(changed.commitShas[1])
    expect(readFileSync(join(changed.worktree!, "src", "cart", "service.ts"), "utf8")).toContain("c == null")
  })

  test("a rejected publish approval stops cleanly and can be retried from push", async () => {
    mock.rejectPermissions.add("fixora.publish")
    const run = await runFix(rt, { sessionID: "origin", ref: `manual:${runId.replace("manual-", "")}`, flags: { dryRun: false, ticket: true, mr: true, push: true, auto: false, force: true, forceTriage: false } })
    expect(run.status).toBe("rejected")
    expect(run.step).toBe("push")
    expect(run.pipeline.committed).toBe(true)
    expect(run.pipeline.pushed).toBe(false)
    mock.rejectPermissions.delete("fixora.publish")
    const retried = await runRetry(rt, { sessionID: "origin", runId, from: "push", fresh: false, flags: { dryRun: false, ticket: true, mr: true, push: true, auto: false, force: false, forceTriage: false } })
    expect(retried.status).toBe("done")
    expect(retried.pipeline.pushed).toBe(true)
  })

  test("restart creates a new branch and a fresh cycle", async () => {
    const restarted = await runRestart(rt, { sessionID: "origin", runId, flags: { dryRun: false, ticket: true, mr: true, push: true, auto: false, force: false, forceTriage: false } })
    if (restarted.status !== "done") throw new Error(`${restarted.status} at ${restarted.step}: ${restarted.error}`)
    expect(restarted.counters.restarts).toBeGreaterThanOrEqual(1)
    expect(/-r\d+$/.test(restarted.branch!)).toBe(true)
    expect(await git.remoteBranchSha(repo, "origin", restarted.branch!)).toBe(restarted.commitShas[0])
  })

  test("dry run stops before commit and writes the MR body", async () => {
    const run = await startPipeline(rt, { ...(await loadRun(mock.ctx, runId))!, flags: { dryRun: true, ticket: false, mr: true, push: true, auto: false, force: true, testFirst: false }, status: "running", commitShas: [], pipeline: { analysed: false, ticketed: false, fixed: false, validated: false, reviewed: false, committed: false, pushed: false, mrOpened: false, loopClosed: false }, timings: {}, branch: undefined, worktree: undefined, sessions: {}, reviews: [], fix: undefined, tests: undefined, triage: undefined, counters: { fixRounds: 0, reviewRounds: 0, feedback: 0, restarts: 5, workerPrompts: 0 } }, { from: "detect" })
    expect(run.status).toBe("done")
    expect(run.commitShas).toHaveLength(0)
    expect(existsSync(join(run.folder, "mr.md"))).toBe(true)
    expect(readFileSync(join(run.folder, "mr.md"), "utf8")).toContain("## Root cause")
  })
})
