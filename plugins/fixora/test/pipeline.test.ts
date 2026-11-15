// Orchestration end to end, without git or processes: a pasted crash → scripted agent sessions
// (prepare, triage, fix, review, publish, restore) that answer through the plugin's own tools →
// approvals → final report. Then feedback, rejected approvals, restart, dry run, dirty checkout,
// cancellation and the repository lock.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runFeedback, runFix, runPaste, runReset, runRestart, runRetry, runStatus, startPipeline } from "../src/flows.js"
import { readOptions } from "../src/options.js"
import type { Runtime } from "../src/progress.js"
import { loadRun } from "../src/state.js"
import { registerPluginTools } from "../src/tools.js"
import type { RunRecord, WorkerInfo } from "../src/types.js"
import { mockCtx, toolCtx, type MockCtx, type Worker } from "./mock-ctx.js"

let root: string
let repo: string
let mock: MockCtx
let rt: Runtime

const SHA = (n: number) => n.toString(16).padStart(40, "0")
const BASE_SHA = SHA(0xb7e21c0)
const HEAD_SHA = SHA(0x9fceb02)
const STASH_SHA = SHA(0x5745a5)
let commits = 0

const FLAGS = { dryRun: false, ticket: true, mr: true, push: true, auto: false, force: false, forceTriage: false }

/** Knobs the tests turn. */
const state = { dirty: false, holdTriage: undefined as Promise<void> | undefined, cancelInFix: false, restorePrompts: [] as string[], publishPrompts: [] as string[], preparePrompts: [] as string[] }

const STATUS = " M src/cart/service.ts\n?? src/cart/guard.test.ts\n"
const DIFF = [
  "diff --git a/src/cart/service.ts b/src/cart/service.ts",
  "--- a/src/cart/service.ts",
  "+++ b/src/cart/service.ts",
  "@@ -1,3 +1,4 @@",
  " export function applyCoupon(c: { id: string } | undefined) {",
  "+  if (!c) return undefined",
  "   return c.id",
  " }",
  "diff --git a/src/cart/guard.test.ts b/src/cart/guard.test.ts",
  "--- /dev/null",
  "+++ b/src/cart/guard.test.ts",
  "@@ -0,0 +1,5 @@",
  '+import { expect, test } from "bun:test"',
  '+import { applyCoupon } from "./service"',
  '+test("returns undefined for a missing coupon", () => {',
  "+  expect(applyCoupon(undefined)).toBeUndefined()",
  "+})",
  "",
].join("\n")

/** The scripted agent: reacts to the phase recorded for its session. */
const worker: Worker = async (prompt, session, tool) => {
  const w = mock.storage.get(`fixora/worker/${session.id}`) as WorkerInfo
  const runId = w.runId!
  const call = async (name: string, input: unknown) => {
    const r = await tool(name).execute(input, toolCtx(session.id))
    if ((r.output as { ok?: boolean }).ok !== true) throw new Error(`${name} rejected: ${r.content}`)
    return r
  }
  switch (w.phase) {
    case "prepare": {
      state.preparePrompts.push(prompt.text)
      const base = { version: 1, runId, repoRoot: repo, previousBranch: "main", previousHeadSha: HEAD_SHA, conventionFiles: [], notes: [] }
      if (/Step 1 — inspect/.test(prompt.text) && state.dirty) {
        await call("fixora_submit_prepare", { ...base, stage: "inspect", dirty: true, status: " M README.md\n", dirtyFiles: 1 })
        return
      }
      const stashApproved = /approved stashing/.test(prompt.text)
      const branch = /already has branch `([^`]+)`/.exec(prompt.text)?.[1] ?? /Fallback branch name[^`]*`([^`]+)`/.exec(prompt.text)![1]!
      await call("fixora_submit_prepare", { ...base, stage: "ready", dirty: state.dirty, stashRef: stashApproved ? STASH_SHA : null, baseRef: "origin/main", baseSha: BASE_SHA, remoteUrl: "git@git.corp.io:team/shop.git", branch, created: true, toolchain: { ecosystems: [{ id: "node", root: "" }], checks: [{ kind: "unit", command: "bun test", cwd: "" }, { kind: "typecheck", command: "bunx tsc --noEmit", cwd: "", optional: true }], setup: [] } })
      return
    }
    case "triage": {
      if (state.holdTriage) await state.holdTriage
      await call("fixora_submit_triage", {
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
      return
    }
    case "fix":
    case "feedback": {
      if (state.cancelInFix) {
        rt.inflight.get(runId)!.controller.abort()
        return
      }
      const attempt = Number(/attempt (\d+)/.exec(prompt.text)?.[1] ?? "1")
      const feedback = w.phase === "feedback"
      if (feedback && /question:/i.test(prompt.text)) {
        await call("fixora_submit_fix", { version: 1, runId, attempt, summary: "Answered a question", filesChanged: [], rationale: "No change: the guard already handles both undefined and null.", alternativesRejected: [], testsAdded: [], commandsRun: [], risk: { level: "low", publicApiChange: false, behaviourChange: "", rollback: "" }, changesMade: false, unresolved: [] })
        return
      }
      await call("fixora_submit_fix", {
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
        status: STATUS,
        diff: feedback ? DIFF.replace("if (!c)", "if (c == null)") : DIFF,
      })
      return
    }
    case "review": {
      const attempt = Number(/review attempt (\d+)/.exec(prompt.text)?.[1] ?? "1")
      await call("fixora_submit_review", { version: 1, runId, attempt, verdict: "approve", rootCauseAddressed: true, regressionTestPresent: true, findings: [], summary: "Minimal guard with a regression test; nothing to object to." })
      return
    }
    case "publish": {
      state.publishPrompts.push(prompt.text)
      const g = w.grants ?? {}
      const sha = SHA(0xc0ffee + ++commits)
      await call("fixora_submit_publish", {
        version: 1,
        runId,
        ...(g.commit ? { committed: { sha, files: ["src/cart/service.ts", "src/cart/guard.test.ts"] } } : {}),
        ...(g.push ? { pushed: { remote: "origin", branch: w.branch, remoteSha: sha } } : {}),
        ...(g.mr ? { mrSkipped: { reason: "no GitLab / GitHub MCP and no glab", compareUrl: "https://git.corp.io/team/shop (branch → main)" } } : {}),
        errors: [],
      })
      return
    }
    case "restore": {
      state.restorePrompts.push(prompt.text)
      await call("fixora_submit_ops", { version: 1, runId, op: "restore", ok: true, results: { branch: "main", stashPopped: /stash pop/.test(prompt.text) }, errors: [] })
      return
    }
    case "clean": {
      await call("fixora_submit_ops", { version: 1, runId, op: "clean", ok: true, results: { localDeleted: true }, errors: [] })
      return
    }
    default:
      throw new Error(`unexpected phase ${w.phase} for skill ${prompt.skills?.[0]?.id}`)
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fixora-orch-"))
  repo = join(root, "repo")
  await writeFile(join(root, "trace.txt"), `TypeError: Cannot read properties of undefined (reading 'id')\n    at applyCoupon (src/cart/service.ts:2:12)\n    at pay (src/checkout.ts:40:5)\n`)
  await writeFile(join(root, "trace2.txt"), `RangeError: Invalid array length\n    at buildRows (src/table/rows.ts:17:3)\n    at render (src/table/index.ts:9:5)\n`)
  const options = { jira: { project: undefined }, testCommands: { fullSuiteMaxMinutes: 1 } }
  mock = mockCtx({ directory: repo, options, worker })
  const opts = readOptions(options)
  if (!opts.ok) throw new Error(opts.errors.join())
  rt = { ctx: mock.ctx, opts: opts.value, services: {}, emit: async (name, data) => void mock.rpcEvents.push({ name, data }), inflight: new Map(), lockPollMs: 5 }
  await registerPluginTools(mock.ctx, { rt: () => rt, isWorkerSession: async (id) => mock.sessions.has(id), start: async () => ({ started: [], errors: [] }) })
  // The checkout the agent "works in": the plugin only ever checks that triaged paths exist here.
  const fs = await import("node:fs/promises")
  await fs.mkdir(join(repo, "src", "cart"), { recursive: true })
  await fs.writeFile(join(repo, "src", "cart", "service.ts"), "export function applyCoupon(c: { id: string } | undefined) {\n  return c.id\n}\n")
})
afterAll(() => rm(root, { recursive: true, force: true }))
beforeEach(() => {
  state.dirty = false
  state.cancelInFix = false
  state.holdTriage = undefined
})

const fixerPrompts = (run: RunRecord) => mock.sessions.get(run.sessions.fixer!)!.prompts
const phasesOf = (run: RunRecord) => fixerPrompts(run).map((p) => p.skills?.[0]?.id)

describe("pipeline orchestration", () => {
  let runId: string

  test("paste → prepare → triage → fix → review → publish → restore, everything through the agent", async () => {
    const run = await runPaste(rt, { sessionID: "origin", file: join(root, "trace.txt"), flags: FLAGS })
    runId = run.runId
    if (run.status !== "done") throw new Error(`${run.status} at ${run.step}: ${run.error}\n${mock.synthetics.map((s) => s.description).join("\n")}`)
    expect(run.runId.startsWith("manual-")).toBe(true)
    expect(run.repo).toBe(repo)
    expect(run.pipeline).toMatchObject({ analysed: true, fixed: true, validated: true, reviewed: true, committed: true, pushed: true, mrOpened: false, loopClosed: true })
    expect(run.approvals.ticket).toBe("skipped")
    expect(run.approvals.publish).toBe("approved")
    expect(run.triage?.confidence).toBe(0.9)
    expect(run.tests?.allPassed).toBe(true)
    expect(run.tests?.commands.map((c) => `${c.kind}:${c.command}`)).toEqual(["unit:bun test"])
    expect(run.change).toMatchObject({ paths: ["src/cart/service.ts", "src/cart/guard.test.ts"], added: 6, deleted: 0 })
    expect(run.reviews[0]?.verdict).toBe("approve")
    expect(run.commitShas).toHaveLength(1)
    expect(run.branch!.startsWith("fixora/manual-")).toBe(true)
    expect(run.base.sha).toBe(BASE_SHA)
    expect(run.toolchain?.checks.map((c) => c.command)).toEqual(["bun test", "bunx tsc --noEmit"])
    expect(run.mrUrl).toBeUndefined()
    expect(String(run.meta?.compareUrl)).toContain("git.corp.io")
    // The checkout was restored by the agent, as the last prompt of the fixer session.
    expect(run.checkout).toMatchObject({ active: false, previousBranch: "main", previousHeadSha: HEAD_SHA })
    expect(run.checkout.restoredAt).toBeDefined()
    expect(run.checkout.stashRef).toBeUndefined()
    expect(run.timings.restore?.status).toBe("ok")
    expect(phasesOf(run)).toEqual(["fixora-prepare", "fixora-triage", "fixora-fix", "fixora-publish", "fixora-ops"])
    expect(state.restorePrompts.at(-1)).toContain("git checkout main")
    expect(state.restorePrompts.at(-1)).not.toContain("stash pop")
    // Worker sessions were created in the session's checkout with static permission rules; reviewer separate.
    const fixer = mock.sessions.get(run.sessions.fixer!)!
    expect(fixer.location?.directory).toBe(repo)
    expect(fixer.agent).toBe("build")
    expect(Array.isArray(fixer.permissions)).toBe(true)
    expect(run.sessions.reviewer).not.toBe(run.sessions.fixer)
    expect(mock.sessions.get(run.sessions.reviewer!)!.prompts[0]!.skills?.[0]?.id).toBe("fixora-review")
    // The publish prompt carried the approved grants and the exact commands.
    const publish = state.publishPrompts.at(-1)!
    expect(publish).toContain("git add -- src/cart/service.ts src/cart/guard.test.ts")
    expect(publish).toContain("git commit -F")
    expect(publish).toContain("git push -u origin fixora/")
    expect(publish).toContain("compareUrl")
    // The approval dialog carried human-readable resources and the preview path.
    const gate = mock.permissionRequests.find((p) => p.action === "fixora.publish")!
    expect(gate.resources.some((r) => r.startsWith("push branch fixora/"))).toBe(true)
    expect(gate.resources.some((r) => r.includes("+6 −0"))).toBe(true)
    expect(existsSync(join(run.folder, "publish-preview.md"))).toBe(true)
    // Artefacts in the run folder; no mapping.md any more.
    for (const f of ["crash.json", "crash.md", "project.md", "limits.json", "triage.json", "fix.1.json", "diff.1.patch", "verification.1.json", "review.1.json", "commit-message.txt", "mr.md"]) expect(existsSync(join(run.folder, f))).toBe(true)
    expect(existsSync(join(run.folder, "mapping.md"))).toBe(false)
    const commitMessage = readFileSync(join(run.folder, "commit-message.txt"), "utf8")
    expect(commitMessage.startsWith("fix(cart): Guard missing coupon in applyCoupon")).toBe(true)
    expect(commitMessage).toContain(`Fixora-Run: ${run.runId}`)
    expect(readFileSync(join(run.folder, "crash.md"), "utf8")).toContain("src/cart/service.ts")
    // Progress rows and RPC events were emitted; the final report was presented after restore.
    expect(mock.rpcEvents.some((e) => e.name === "run.started")).toBe(true)
    expect(mock.rpcEvents.filter((e) => e.name === "run.stage").length).toBeGreaterThan(10)
    expect(mock.rpcEvents.some((e) => e.name === "run.done")).toBe(true)
    const final = mock.synthetics.filter((s) => s.resume).pop()!
    expect(final.text).toContain("finished in")
    expect(final.text).toContain(run.branch!)
    expect(final.text).toContain("restored to `main`")
    // Nothing in the plugin ever shelled out: the only "git" is inside prompts to the agent.
    expect(mock.permissionRequests.map((p) => p.action)).toEqual(["fixora.publish"])
  })

  test("re-running the same crash is refused; status renders; retry of a done run is refused", async () => {
    await expect(runFix(rt, { sessionID: "origin", ref: `manual:${runId.replace("manual-", "")}`, flags: FLAGS })).rejects.toThrow("already")
    await runStatus(rt, { sessionID: "origin", runId })
    expect(mock.synthetics.pop()!.text).toContain("| analyse | ok |")
    expect(mock.synthetics.pop()!.text ?? "").toBeDefined()
    await expect(runRetry(rt, { sessionID: "origin", runId, fresh: false, flags: FLAGS })).rejects.toThrow("already done")
  })

  test("feedback: a question gets an answer without changes; a change request re-runs validate → review → publish; the checkout is restored both times", async () => {
    mock.synthetics.length = 0
    state.restorePrompts.length = 0
    mock.assistantText = "Yes: the guard returns early for both undefined and null."
    const answered = await runFeedback(rt, { sessionID: "origin", runId, message: "Question: does the guard also cover null?" })
    expect(answered.status).toBe("done")
    expect(answered.counters.feedback).toBe(1)
    expect(answered.commitShas).toHaveLength(1)
    expect(mock.synthetics.some((s) => s.text.includes("the guard returns early"))).toBe(true)
    expect(state.restorePrompts).toHaveLength(1)
    // The feedback round re-checked the branch out (prepare with the existing branch name).
    expect(state.preparePrompts.at(-1)).toContain(`already has branch \`${answered.branch}\``)
    const changed = await runFeedback(rt, { sessionID: "origin", runId, message: "also guard null coupons" })
    if (changed.status !== "done") throw new Error(`${changed.status} at ${changed.step}: ${changed.error}`)
    expect(changed.counters.feedback).toBe(2)
    expect(changed.commitShas).toHaveLength(2)
    expect(changed.reviews).toHaveLength(2)
    expect(changed.pipeline.pushed).toBe(true)
    expect(state.restorePrompts).toHaveLength(2)
    expect(readFileSync(join(changed.folder, "diff.3.patch"), "utf8")).toContain("c == null")
  })

  test("a rejected publish approval stops cleanly (checkout restored) and can be retried from publish", async () => {
    mock.rejectPermissions.add("fixora.publish")
    state.restorePrompts.length = 0
    state.publishPrompts.length = 0
    const run = await runFix(rt, { sessionID: "origin", ref: `manual:${runId.replace("manual-", "")}`, flags: { ...FLAGS, force: true } })
    expect(run.status).toBe("rejected")
    expect(run.step).toBe("publish")
    expect(run.pipeline.committed).toBe(false)
    expect(run.pipeline.pushed).toBe(false)
    expect(run.checkout.active).toBe(false)
    expect(state.restorePrompts).toHaveLength(1)
    expect(state.publishPrompts).toHaveLength(0)
    expect(/-r\d+$/.test(run.branch!)).toBe(true) // a forced re-run gets a fresh branch name
    mock.rejectPermissions.delete("fixora.publish")
    const retried = await runRetry(rt, { sessionID: "origin", runId, from: "publish", fresh: false, flags: FLAGS })
    expect(retried.status).toBe("done")
    expect(retried.pipeline.pushed).toBe(true)
    // Only prepare (re-checkout), publish and restore were prompted on the retry.
    const after = fixerPrompts(retried).slice(-3).map((p) => p.skills?.[0]?.id)
    expect(after).toEqual(["fixora-prepare", "fixora-publish", "fixora-ops"])
    expect(state.restorePrompts).toHaveLength(2)
  })

  test("restart creates a new branch and a fresh cycle", async () => {
    const restarted = await runRestart(rt, { sessionID: "origin", runId, flags: FLAGS })
    if (restarted.status !== "done") throw new Error(`${restarted.status} at ${restarted.step}: ${restarted.error}`)
    expect(restarted.counters.restarts).toBeGreaterThanOrEqual(1)
    expect(/-r\d+$/.test(restarted.branch!)).toBe(true)
    expect(restarted.commitShas).toHaveLength(1)
    expect(restarted.checkout.active).toBe(false)
  })

  test("dry run stops before commit, writes the MR body and still restores the checkout", async () => {
    state.restorePrompts.length = 0
    const gatesBefore = mock.permissionRequests.filter((p) => p.action === "fixora.publish").length
    const base = (await loadRun(mock.ctx, runId))!
    const run = await startPipeline(rt, { ...base, flags: { dryRun: true, ticket: false, mr: true, push: true, auto: false, force: true, testFirst: false }, status: "running", commitShas: [], pipeline: { analysed: false, ticketed: false, fixed: false, validated: false, reviewed: false, committed: false, pushed: false, mrOpened: false, loopClosed: false }, timings: {}, branch: undefined, checkout: { active: false }, sessions: {}, reviews: [], fix: undefined, tests: undefined, change: undefined, triage: undefined, counters: { fixRounds: 0, reviewRounds: 0, feedback: 0, restarts: 5, workerPrompts: 0 } }, { from: "detect" })
    expect(run.status).toBe("done")
    expect(run.commitShas).toHaveLength(0)
    expect(existsSync(join(run.folder, "mr.md"))).toBe(true)
    expect(readFileSync(join(run.folder, "mr.md"), "utf8")).toContain("## Root cause")
    expect(state.restorePrompts).toHaveLength(1)
    expect(mock.permissionRequests.filter((p) => p.action === "fixora.publish").length).toBe(gatesBefore) // no gate in a dry run
  })
})

describe("dirty checkout", () => {
  test("the user is asked before anything is stashed; approved → stash, work, pop", async () => {
    state.dirty = true
    state.restorePrompts.length = 0
    state.preparePrompts.length = 0
    const run = await runPaste(rt, { sessionID: "origin", file: join(root, "trace2.txt"), flags: FLAGS })
    if (run.status !== "done") throw new Error(`${run.status} at ${run.step}: ${run.error}`)
    const stash = mock.permissionRequests.find((p) => p.action === "fixora.stash")!
    expect(stash.resources[0]).toContain("stash 1 uncommitted change(s)")
    expect(run.approvals.stash).toBe("approved")
    expect(run.checkout.stashRef).toBe(STASH_SHA)
    expect(run.checkout.active).toBe(false)
    expect(state.preparePrompts).toHaveLength(2)
    expect(state.preparePrompts[1]).toContain("git stash push -u -m")
    expect(state.restorePrompts.at(-1)).toContain("git stash pop")
    expect(existsSync(join(run.folder, "stash-preview.md"))).toBe(true)
    expect(mock.rpcEvents.some((e) => e.name === "run.awaiting" && (e.data as { kind: string }).kind === "stash")).toBe(true)
  })

  test("declined → blocked: dirty-worktree, nothing touched, no restore prompt", async () => {
    state.dirty = true
    state.restorePrompts.length = 0
    mock.rejectPermissions.add("fixora.stash")
    const run = await runPaste(rt, { sessionID: "origin", file: join(root, "trace2.txt"), flags: { ...FLAGS, force: true } })
    mock.rejectPermissions.delete("fixora.stash")
    expect(run.status).toBe("blocked")
    expect(run.blockedReason).toBe("dirty-worktree")
    expect(run.checkout.active).toBe(false)
    expect(run.branch).toBeUndefined()
    expect(state.restorePrompts).toHaveLength(0)
    // Retry resumes at prepare.
    state.dirty = false
    const retried = await runRetry(rt, { sessionID: "origin", runId: run.runId, fresh: false, flags: FLAGS })
    expect(retried.status).toBe("done")
    expect(retried.timings.prepare?.status).toBe("ok")
  })
})

describe("cancellation and the repository lock", () => {
  test("cancelling during the fix phase still restores the checkout", async () => {
    state.cancelInFix = true
    state.restorePrompts.length = 0
    const run = await runPaste(rt, { sessionID: "origin", file: join(root, "trace.txt"), flags: { ...FLAGS, force: true } })
    expect(run.status).toBe("cancelled")
    expect(run.step).toBe("fix")
    expect(run.checkout.active).toBe(false)
    expect(state.restorePrompts).toHaveLength(1)
  })

  test("two runs on the same checkout run one after the other", async () => {
    let release!: () => void
    state.holdTriage = new Promise<void>((r) => (release = r))
    const first = runPaste(rt, { sessionID: "origin", file: join(root, "trace.txt"), flags: { ...FLAGS, force: true } })
    await new Promise((r) => setTimeout(r, 20))
    const second = runPaste(rt, { sessionID: "origin", file: join(root, "trace2.txt"), flags: { ...FLAGS, force: true } })
    await new Promise((r) => setTimeout(r, 40))
    expect(mock.synthetics.some((s) => /waiting for the checkout/.test(s.text))).toBe(true)
    state.holdTriage = undefined
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a.status).toBe("done")
    expect(b.status).toBe("done")
    // The second run started its prepare phase only after the first restored the checkout.
    const aRestore = Date.parse(a.checkout.restoredAt!)
    const bPrepare = Date.parse(b.timings.prepare!.startedAt)
    expect(bPrepare).toBeGreaterThanOrEqual(aRestore)
  })
})

describe("reset", () => {
  test("asks first, then forgets every record and optionally the run folders; remotes untouched", async () => {
    const seed = await runPaste(rt, { sessionID: "origin", file: join(root, "trace2.txt"), flags: { ...FLAGS, force: true } })
    expect(seed.status).toBe("done")
    const before = [...mock.storage.keys()].filter((k) => k.startsWith("fixora/"))
    expect(before.length).toBeGreaterThan(5)
    mock.rejectPermissions.add("fixora.reset")
    await expect(runReset(rt, { sessionID: "origin", files: false })).rejects.toThrow("rejected fixora.reset")
    mock.rejectPermissions.delete("fixora.reset")
    expect([...mock.storage.keys()].filter((k) => k.startsWith("fixora/")).length).toBe(before.length)
    const counts = await runReset(rt, { sessionID: "origin", files: true })
    expect(counts.run).toBeGreaterThan(0)
    expect([...mock.storage.keys()].filter((k) => k.startsWith("fixora/"))).toEqual([])
    expect(existsSync(join(repo, ".dxcoder", "fixora"))).toBe(false)
    const gate = mock.permissionRequests.find((p) => p.action === "fixora.reset")!
    expect(gate.resources.some((r) => r.includes("merge requests and Jira tickets are kept"))).toBe(true)
    expect(mock.synthetics.at(-1)!.description).toContain("fixora reset")
    expect(mock.synthetics.at(-1)!.text).toContain("- run: ")
  })
})
