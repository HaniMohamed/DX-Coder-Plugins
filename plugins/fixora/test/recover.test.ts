// `/fixora recover`: merge requests Fixora opened → run records. Pure parsing against the real MR
// layout (renderMr), ranking, the rebuilt record, the report, the recover phase policy, and the
// orchestration end to end with a scripted worker (MCP pages and CLI files).

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCommand } from "../src/command.js"
import { validateRecover } from "../src/contracts.js"
import { runRecover } from "../src/flows.js"
import { mrListProviderOrder, renderMrList } from "../src/mr.js"
import { readOptions } from "../src/options.js"
import { guardWorkerMcp, guardWorkerShell } from "../src/permissions.js"
import type { Runtime } from "../src/progress.js"
import { recoverPrompt } from "../src/prompts.js"
import { normalizeMrList, parseFixoraMr, parseTrailers, rankCandidates, rebuildIndex, rebuildRun, renderRecoverReport, type MrListing } from "../src/recover.js"
import { renderMr, renderRunStatus } from "../src/render.js"
import { readRemoteUrl, remoteUrlFromConfig } from "../src/repo.js"
import { registerPluginTools, type RecoverRecord } from "../src/tools.js"
import type { RunRecord, WorkerInfo } from "../src/types.js"
import { fakeMcpTool, mockCtx, toolCtx, type MockCtx, type Worker } from "./mock-ctx.js"

/** A finished run the way the pipeline leaves it, so renderMr produces the real description layout. */
function doneRun(o: { runId: string; source: RunRecord["source"]; crashId: string; title: string; jira?: boolean; review?: boolean }): RunRecord {
  const at = "2026-11-10T10:00:00.000Z"
  return {
    version: 1,
    runId: o.runId,
    source: o.source,
    crashId: o.crashId,
    fingerprint: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    title: o.title,
    originSessionID: "origin",
    repo: "/repo",
    createdAt: at,
    updatedAt: at,
    step: "done",
    status: "done",
    flags: { dryRun: false, ticket: true, push: true, mr: true, auto: false, force: false, testFirst: false },
    base: { remote: "origin", branch: "main" },
    branch: `fixora/${o.runId}-null-coupon`,
    checkout: { active: false },
    sessions: {},
    jiraKey: o.jira ? "DE-456" : undefined,
    jiraUrl: o.jira ? "https://jira.example.com/browse/DE-456" : undefined,
    commitShas: [],
    triage: { version: 1, runId: o.runId, classification: "fixable", mappedFrames: [{ index: 0, file: "src/cart/service.ts", line: 2, evidence: "reads c.id without a guard" }], rootCause: "applyCoupon dereferences a missing coupon when the cart is empty.", category: "null-deref", confidence: 0.8, confidenceReasons: ["frame maps"], suspectCommits: [{ sha: "abcdef1234", subject: "add coupons", why: "introduced the call" }], introducedInRelease: "2.3.0", fixStrategy: "guard", alternatives: [], risk: { level: "low", notes: [] }, suggestedTests: [], relatedCrashes: [], flaggedContent: [] },
    fix: { version: 1, runId: o.runId, attempt: 1, summary: "Guard applyCoupon against a missing coupon", filesChanged: ["src/cart/service.ts", "src/cart/guard.test.ts"], rationale: "Return undefined when no coupon is set instead of reading its id.", alternativesRejected: [], testsAdded: [{ file: "src/cart/guard.test.ts", name: "missing coupon", kind: "regression" }], commandsRun: [], risk: { level: "low", publicApiChange: false, behaviourChange: "none for valid coupons", rollback: "revert" }, changesMade: true, unresolved: [] },
    tests: { diffHash: "x", commands: [{ kind: "unit", command: "bun test", cwd: "", exitCode: 0, durationMs: 1200, outputTail: "", summary: "12 passed" }], allPassed: true },
    reviews: o.review === false ? [] : [{ version: 1, runId: o.runId, attempt: 1, verdict: "approve_with_nits", rootCauseAddressed: true, regressionTestPresent: true, findings: [{ category: "style", severity: "minor", file: "src/cart/service.ts", line: 3, message: "prefer optional chaining" }], summary: "Correct and minimal." }],
    counters: { fixRounds: 1, reviewRounds: 1, feedback: 0, restarts: 0, workerPrompts: 3 },
    pipeline: { analysed: true, ticketed: !!o.jira, fixed: true, validated: true, reviewed: true, committed: true, pushed: true, mrOpened: true, loopClosed: !!o.jira },
    timings: {},
    approvals: {},
    folder: `/repo/.dxcoder/fixora/${o.runId}`,
    meta: {},
  }
}

const crash = { id: "4523123", source: "sentry" as const, title: "TypeError in applyCoupon", exceptionType: "TypeError", message: "Cannot read properties of undefined (reading 'id')", frames: [], language: "js" as const, rawStackTrace: "", fingerprint: "a1b2c3d4e5f60718293a4b5c6d7e8f90", symbolication: "ok" as const, fetchedAt: "", url: "https://acme.sentry.io/issues/4523123/", userCount: 540, eventCount: 1830, appVersion: "2.3.1" }

/** GitLab API shape of an MR Fixora opened for `run`. */
function gitlabMr(run: RunRecord, o: { iid: number; state?: "opened" | "merged" | "closed"; draft?: boolean; branch?: string; updated?: string; labels?: string[] } = { iid: 418 }): Record<string, unknown> {
  const { title, body } = renderMr(run, { crash: run.source === "sentry" ? crash : undefined, draft: o.draft ?? true, base: "main" })
  return {
    id: 90000 + o.iid,
    iid: o.iid,
    title,
    description: body,
    state: o.state ?? "opened",
    draft: o.draft ?? true,
    source_branch: o.branch ?? run.branch,
    target_branch: "main",
    web_url: `https://gitlab.example.com/mobile/shop/-/merge_requests/${o.iid}`,
    labels: o.labels ?? ["fixora"],
    created_at: "2026-11-10T10:05:00.000Z",
    updated_at: o.updated ?? "2026-11-10T11:00:00.000Z",
    merged_at: o.state === "merged" ? "2026-11-11T09:00:00.000Z" : null,
    sha: "0123456789abcdef0123456789abcdef01234567",
    merge_commit_sha: o.state === "merged" ? "fedcba9876543210fedcba9876543210fedcba98" : null,
    author: { username: "fixora-bot" },
  }
}

describe("recover · parsing", () => {
  const run = doneRun({ runId: "sentry-4523123", source: "sentry", crashId: "4523123", title: "TypeError in applyCoupon", jira: true })

  test("normalizes GitLab, GitHub and gh shapes, nested pages and JSON text", () => {
    const gl = gitlabMr(run, { iid: 418, state: "merged" })
    const gh = { number: 77, title: "Guard x (fixes crash crashlytics:abc)", body: "…", state: "closed", merged_at: "2026-11-11T09:00:00Z", html_url: "https://github.com/acme/shop/pull/77", head: { ref: "fixora/crashlytics-abc", sha: "aa" }, base: { ref: "main" }, labels: [{ name: "fixora" }], user: { login: "bot" } }
    const cli = { number: 78, title: "Draft: Y (fixes crash manual:zz)", body: "", state: "OPEN", isDraft: true, url: "https://github.com/acme/shop/pull/78", headRefName: "fixora/manual-zz", baseRefName: "develop", labels: [{ name: "fixora" }], headRefOid: "bb", mergeCommit: null, author: { login: "bot" } }
    const list = normalizeMrList([[gl], { pull_requests: [gh] }, JSON.stringify([cli]), "not json"])
    expect(list.map((m) => m.id)).toEqual(["418", "77", "78"])
    expect(list[0]).toMatchObject({ status: "merged", sourceBranch: run.branch, targetBranch: "main", labels: ["fixora"], author: "fixora-bot", mergeCommitSha: "fedcba9876543210fedcba9876543210fedcba98" })
    expect(list[1]).toMatchObject({ status: "merged", sourceBranch: "fixora/crashlytics-abc", url: "https://github.com/acme/shop/pull/77", author: "bot" })
    expect(list[2]).toMatchObject({ status: "draft", targetBranch: "develop", sha: "bb" })
    // The same MR listed twice (two pages overlapping) is kept once.
    expect(normalizeMrList([[gl], [gl]]).length).toBe(1)
  })

  test("reads every fact Fixora wrote into the description", () => {
    const [mr] = normalizeMrList([gitlabMr(run, { iid: 418 })])
    const facts = parseFixoraMr(mr!)!
    expect(facts).toMatchObject({
      runId: "sentry-4523123",
      source: "sentry",
      crashId: "4523123",
      summary: "Guard applyCoupon against a missing coupon",
      fingerprintShort: "a1b2c3d4e5f6",
      target: "main",
      jiraKey: "DE-456",
      jiraUrl: "https://jira.example.com/browse/DE-456",
      crashUrl: "https://acme.sentry.io/issues/4523123/",
      exceptionType: "TypeError",
      message: "Cannot read properties of undefined (reading 'id')",
      users: 540,
      events: 1830,
      appVersion: "2.3.1",
      rootCause: "applyCoupon dereferences a missing coupon when the cart is empty.",
      confidence: 0.8,
      category: "null-deref",
      introducedInRelease: "2.3.0",
      filesChanged: ["src/cart/service.ts", "src/cart/guard.test.ts"],
      rationale: "Return undefined when no coupon is set instead of reading its id.",
      riskLevel: "low",
      reviewVerdict: "approve_with_nits",
      reviewRounds: 2,
      restarts: 0,
    })
  })

  test("a footer-only description (title edited by a human) still yields the run; a foreign MR does not", () => {
    const edited: MrListing = { url: "https://gitlab.example.com/x/-/merge_requests/1", id: "1", title: "Fix the coupon crash", body: "stuff\n\n---\nGenerated by Fixora · run `crashlytics-deadbeef` · fingerprint `0123456789ab` · target `develop`", labels: ["fixora"] }
    expect(parseFixoraMr(edited)).toMatchObject({ runId: "crashlytics-deadbeef", source: "crashlytics", crashId: "deadbeef", fingerprintShort: "0123456789ab", target: "develop", summary: "Fix the coupon crash" })
    const foreign: MrListing = { url: "https://gitlab.example.com/x/-/merge_requests/2", id: "2", title: "Bump deps", body: "routine", labels: ["fixora"] }
    expect(parseFixoraMr(foreign)).toBeUndefined()
    const bare: MrListing = { url: "https://gitlab.example.com/x/-/merge_requests/3", id: "3", title: "Null guard (fixes crash manual:7fcb3db2d5)", body: "", labels: [], sourceBranch: "fixora/manual-7fcb3db2d5-x-r3" }
    expect(parseFixoraMr(bare)).toMatchObject({ runId: "manual-7fcb3db2d5", restarts: 2, filesChanged: [] })
  })

  test("trailer pairs come from git log lines; the first pair per run wins", () => {
    const t = parseTrailers("Fixora-Run: sentry-1\nFixora-Fingerprint: AAAA\nFixora-Run: sentry-2\nFixora-Fingerprint: bbbb\nFixora-Run: sentry-1\nFixora-Fingerprint: cccc\nnoise\n")
    expect([...t.entries()]).toEqual([
      ["sentry-1", "aaaa"],
      ["sentry-2", "bbbb"],
    ])
    expect(parseTrailers(undefined).size).toBe(0)
  })

  test("ranking keeps one MR per run: merged beats open beats closed; a restart supersedes its closed MR; foreign labelled MRs are reported", () => {
    const other = doneRun({ runId: "crashlytics-abc", source: "crashlytics", crashId: "abc", title: "NPE in Cart", review: false })
    const mrs = normalizeMrList([
      gitlabMr(run, { iid: 1, state: "closed", updated: "2026-11-01T00:00:00Z" }),
      gitlabMr(run, { iid: 2, state: "opened", branch: `${run.branch}-r2`, updated: "2026-11-02T00:00:00Z" }),
      gitlabMr(other, { iid: 3, state: "merged" }),
      gitlabMr(other, { iid: 4, state: "opened", updated: "2026-11-09T00:00:00Z" }),
      { iid: 5, title: "Bump deps", description: "", web_url: "https://gitlab.example.com/mobile/shop/-/merge_requests/5", labels: ["fixora"], state: "opened" },
      { iid: 6, title: "Unrelated", description: "", web_url: "https://gitlab.example.com/mobile/shop/-/merge_requests/6", labels: ["chore"], state: "opened" },
    ])
    const { picks, skipped } = rankCandidates(mrs, { label: "fixora" })
    // Newest first: the merged MR of the other crash was updated after the restart's open MR.
    expect(picks.map((p) => [p.facts.runId, p.mr.id])).toEqual([
      ["crashlytics-abc", "3"],
      ["sentry-4523123", "2"],
    ])
    expect(skipped.map((s) => s.mr.id).sort()).toEqual(["1", "4", "5"])
    expect(skipped.find((s) => s.mr.id === "5")!.reason).toContain("not generated by Fixora")
    expect(skipped.find((s) => s.mr.id === "1")!.reason).toContain("superseded")
  })

  test("the rebuilt record is a done run with links, a minimal triage / fix / review and the recovery marked", () => {
    const [mr] = normalizeMrList([gitlabMr(run, { iid: 418, state: "merged", branch: `${run.branch}-r2` })])
    const facts = parseFixoraMr(mr!)!
    const at = "2026-11-17T12:00:00.000Z"
    const full = rebuildRun({ candidate: { mr: mr!, facts }, repo: "/work/shop", sessionID: "s1", provider: "gitlab-mcp", remote: "origin", remoteUrl: "git@gitlab.example.com:mobile/shop.git", baseBranch: "develop", trailers: new Map([["sentry-4523123", "a1b2c3d4e5f60718293a4b5c6d7e8f90"]]), at, folder: "/work/shop/.dxcoder/fixora/sentry-4523123" })
    expect(full).toMatchObject({
      runId: "sentry-4523123",
      status: "done",
      step: "done",
      title: "TypeError: Cannot read properties of undefined (reading 'id')",
      fingerprint: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      branch: `${run.branch}-r2`,
      base: { remote: "origin", branch: "main", remoteUrl: "git@gitlab.example.com:mobile/shop.git" },
      jiraKey: "DE-456",
      mrUrl: "https://gitlab.example.com/mobile/shop/-/merge_requests/418",
      mrId: "418",
      mrStatus: "merged",
      mrProvider: "gitlab-mcp",
      createdAt: "2026-11-10T10:05:00.000Z",
      updatedAt: "2026-11-11T09:00:00.000Z",
      counters: { restarts: 1, reviewRounds: 1 },
      pipeline: { analysed: true, ticketed: true, reviewed: true, mrOpened: true, loopClosed: true },
      meta: { recoveredFrom: "https://gitlab.example.com/mobile/shop/-/merge_requests/418", recoveredAt: at, fingerprintPartial: false, mergedAt: "2026-11-11T09:00:00.000Z", appVersion: "2.3.1", users: 540 },
    })
    expect(full.triage?.rootCause).toBe("applyCoupon dereferences a missing coupon when the cart is empty.")
    expect(full.triage?.confidence).toBe(0.8)
    expect(full.fix?.filesChanged).toEqual(["src/cart/service.ts", "src/cart/guard.test.ts"])
    expect(full.reviews[0]?.verdict).toBe("approve_with_nits")
    expect(full.commitShas).toEqual(["0123456789abcdef0123456789abcdef01234567", "fedcba9876543210fedcba9876543210fedcba98"])
    expect(rebuildIndex(full)).toMatchObject({ fingerprint: full.fingerprint, runIds: ["sentry-4523123"] })
    // Without a trailer the footer prefix is kept on the run but never indexed.
    const partial = rebuildRun({ candidate: { mr: mr!, facts }, repo: "/work/shop", sessionID: "s1", provider: "glab", remote: "origin", baseBranch: "main", trailers: new Map(), at, folder: "/f" })
    expect(partial.fingerprint).toBe("a1b2c3d4e5f6")
    expect(partial.meta?.fingerprintPartial).toBe(true)
    expect(rebuildIndex(partial)).toBeUndefined()
    expect(renderRunStatus(partial)).toContain("Recovered from the merge request")
    expect(renderRunStatus(partial)).toContain("fingerprint prefix only")
  })

  test("the report tallies, lists every recovered run with its links and says what was left out", () => {
    const [mr] = normalizeMrList([gitlabMr(run, { iid: 418, state: "merged" })])
    const facts = parseFixoraMr(mr!)!
    const rebuilt = rebuildRun({ candidate: { mr: mr!, facts }, repo: "/r", sessionID: "s", provider: "glab", remote: "origin", baseBranch: "main", trailers: new Map(), at: "2026-11-17T12:00:00.000Z", folder: "/f" })
    const md = renderRecoverReport({ label: "fixora", provider: "glab", listed: 3, recovered: [rebuilt], known: [{ runId: "manual-1", mrUrl: "u" }], skipped: [{ mr: { url: "https://x/-/merge_requests/5", id: "5", title: "Bump", body: "", labels: [] }, reason: "not generated by Fixora" }], errors: [], dryRun: false })
    expect(md).toContain("recovered 1 run(s)")
    expect(md).toContain("3 merge request(s) labelled `fixora` via glab · 1 recovered (1 merged) · 1 already known (kept; `--force` overwrites) · 1 skipped.")
    expect(md).toContain("| `sentry-4523123` |")
    expect(md).toContain("[DE-456](https://jira.example.com/browse/DE-456)")
    expect(md).toContain("[!418 merged](https://gitlab.example.com/mobile/shop/-/merge_requests/418)")
    expect(md).toContain("root cause 80% · 2 file(s) · review approve_with_nits · fingerprint (prefix)")
    expect(md).toContain("- https://x/-/merge_requests/5: not generated by Fixora")
    expect(md).toContain("/fixora fixed sentry-4523123 --release <version>")
    const empty = renderRecoverReport({ label: "fixora", provider: "gh", listed: 0, recovered: [], known: [], skipped: [], errors: ["gh: not logged in"], dryRun: true })
    expect(empty).toContain("would recover 0 run(s)")
    expect(empty).toContain("`/fixora recover --all`")
    expect(renderRecoverReport({ label: undefined, provider: "glab", listed: 40, recovered: [], known: [], skipped: [], errors: [], dryRun: false })).toContain("40 merge request(s) listed (no label filter) via glab")
    // Unlabelled MRs are recognised by their title / description alone.
    const unlabelled = normalizeMrList([gitlabMr(run, { iid: 2660, labels: [] }), { iid: 1, title: "Bump deps", description: "", web_url: "https://x/-/merge_requests/1", labels: [] }])
    const ranked = rankCandidates(unlabelled, { label: undefined })
    expect(ranked.picks.map((p) => p.facts.runId)).toEqual(["sentry-4523123"])
    expect(ranked.skipped).toEqual([])
  })
})

describe("recover · plan, prompt, policy, command", () => {
  const remote = { host: "gitlab.example.com", owner: "mobile", repo: "shop", kind: "gitlab" as const, web: "https://gitlab.example.com/mobile/shop" }

  test("provider order: a connected list tool on the matching forge first, then the CLI; unknown forges try everything", () => {
    const services = { gitlab: { id: "gitlab" as const, namespace: "gitlab", serverName: "gitlab", status: "connected", toolIds: [], capabilities: { createMr: "gitlab_create_merge_request", listMrs: "gitlab_list_merge_requests" } } }
    expect(mrListProviderOrder(services, remote)).toEqual(["gitlab-mcp", "glab"])
    expect(mrListProviderOrder({}, remote)).toEqual(["glab"])
    expect(mrListProviderOrder(services, { ...remote, kind: "github" })).toEqual(["gh"])
    expect(mrListProviderOrder(services, undefined)).toEqual(["gitlab-mcp", "glab", "gh"])
  })

  test("the GitLab input follows the tool's schema (array labels, aliases); the CLI commands write numbered JSON files", () => {
    const services = { gitlab: { id: "gitlab" as const, namespace: "gitlab", serverName: "gitlab", status: "connected", toolIds: [], capabilities: { createMr: "x", listMrs: "gitlab_list_merge_requests" } } }
    const plan = renderMrList({ provider: "gitlab-mcp", remote, label: "fixora", state: "open", limit: 500, services, toolProps: () => ({ projectId: {}, state: {}, labels: { type: "array" }, perPage: {}, page: {} }), outFile: "/r/.dxcoder/fixora/recover/recover-1" })!
    expect(plan.toolId).toBe("gitlab_list_merge_requests")
    expect(plan.input).toEqual({ projectId: "mobile/shop", state: "opened", labels: ["fixora"], perPage: 100, page: 1 })
    expect(plan.perPage).toBe(100)
    const glab = renderMrList({ provider: "glab", remote: undefined, label: "fixora", state: "all", limit: 200, services: {}, toolProps: () => ({}), outFile: "/r/.dxcoder/fixora/recover/recover-1" })!
    expect(glab.command).toBe("glab mr list --label fixora --all --output json --per-page 100 --page 1 > /r/.dxcoder/fixora/recover/recover-1.1.json")
    const gh = renderMrList({ provider: "gh", remote: { ...remote, kind: "github" }, label: "fixora", state: "merged", limit: 50, services: {}, toolProps: () => ({}), outFile: "/r/x" })!
    expect(gh.command).toContain("gh pr list --label fixora --state merged --limit 50 --json number,title,body,")
    expect(gh.command).toEndWith("> /r/x.1.json")
    // Without a schema the input is sent as is (comma-joined labels).
    const bare = renderMrList({ provider: "gitlab-mcp", remote: undefined, label: "fixora", state: "all", limit: 10, services, toolProps: () => ({}), outFile: "/o" })!
    expect(bare.input).toMatchObject({ project_id: "<owner/repo>", state: "all", labels: "fixora", per_page: 10, page: 1, order_by: "updated_at", sort: "desc" })
    // --all: no label, a title search where the forge offers one.
    const all = renderMrList({ provider: "gitlab-mcp", remote, label: undefined, state: "all", limit: 10, services, toolProps: () => ({}), outFile: "/o" })!
    expect(all.input).toMatchObject({ project_id: "mobile/shop", search: "fixes crash", in: "title" })
    expect(all.input).not.toHaveProperty("labels")
    expect(renderMrList({ provider: "glab", label: undefined, state: "open", limit: 200, services: {}, toolProps: () => ({}), outFile: "/o" })!.command).toBe("glab mr list --output json --per-page 100 --page 1 > /o.1.json")
    expect(renderMrList({ provider: "gh", label: undefined, state: "all", limit: 200, services: {}, toolProps: () => ({}), outFile: "/o" })!.command).toContain(`gh pr list --search '"fixes crash" in:title' --state all --limit 200`)
  })

  test("the prompt lists git remote / fetch / log, then the paged script or the CLI command and the submission", () => {
    const services = { gitlab: { id: "gitlab" as const, namespace: "gitlab", serverName: "gitlab", status: "connected", toolIds: [], capabilities: { createMr: "x", listMrs: "gitlab_list_merge_requests" } } }
    const plan = renderMrList({ provider: "gitlab-mcp", remote: undefined, label: "fixora", state: "all", limit: 200, services, toolProps: () => ({}), outFile: "/r/.dxcoder/fixora/recover/recover-1" })!
    const p = recoverPrompt({ requestId: "recover-1", repo: "/r", remote: "origin", label: "fixora", plan, commitsFile: "/r/.dxcoder/fixora/recover/recover-1.commits.txt", outFile: "/r/.dxcoder/fixora/recover/recover-1" })
    expect(p.skills).toEqual(["fixora-ops"])
    expect(p.text).toContain("1. `git remote get-url origin`")
    expect(p.text).toContain("2. `git fetch origin --no-tags`")
    expect(p.text).toContain("3. `git log --all --grep='^Fixora-Run:' --format=%B | grep '^Fixora-' > /r/.dxcoder/fixora/recover/recover-1.commits.txt`")
    expect(p.text).toContain("tools.gitlab.list_merge_requests({ ...input, page })")
    expect(p.text).toContain('provider: "gitlab-mcp", remoteUrl: "<remote url from step 1>", raw: pages, commitsFile: "/r/.dxcoder/fixora/recover/recover-1.commits.txt"')
    const cli = renderMrList({ provider: "glab", remote: undefined, label: "fixora", state: "all", limit: 200, services: {}, toolProps: () => ({}), outFile: "/r/.dxcoder/fixora/recover/recover-1" })!
    const q = recoverPrompt({ requestId: "recover-1", repo: "/r", remote: "origin", remoteUrl: "git@gitlab.example.com:mobile/shop.git", label: "fixora", plan: cli, commitsFile: "/c", outFile: "/r/.dxcoder/fixora/recover/recover-1" })
    expect(q.text).toContain("1. The remote `origin` is git@gitlab.example.com:mobile/shop.git")
    expect(q.text).toContain("4. `glab mr list --label fixora --all --output json --per-page 100 --page 1 > /r/.dxcoder/fixora/recover/recover-1.1.json`")
    expect(q.text).toContain("run the same command again with `--page 2`")
    expect(q.text).toContain('rawFile: "/r/.dxcoder/fixora/recover/recover-1.1.json"')
  })

  test("the recover phase allows fetch, log, remote get-url, glab / gh list and nothing that writes", () => {
    const w: WorkerInfo = { role: "fixer", repo: "/r", phase: "recover", requestId: "recover-1", grants: {} }
    const shell = (command: string) => guardWorkerShell({ tool: "bash", input: { command }, worker: w })
    expect(shell("git remote get-url origin")).toBeUndefined()
    expect(shell("git fetch origin --no-tags")).toBeUndefined()
    expect(shell("git log --all --grep='^Fixora-Run:' --format=%B | grep '^Fixora-' > /r/.dxcoder/fixora/recover/x.txt")).toBeUndefined()
    expect(shell("glab mr list --label fixora --all --output json --per-page 100 --page 1 > /r/.dxcoder/fixora/recover/x.1.json")).toBeUndefined()
    expect(shell("gh pr list --label fixora --state all --limit 200 --json number > /r/x.1.json")).toBeUndefined()
    expect(shell("git fetch --prune origin")).toContain("no pruning")
    expect(shell("git checkout main")).toContain("recover only fetches and reads history")
    expect(shell("glab mr merge 418")).toContain("recover runs git fetch / git log, glab mr list and gh pr list only")
    expect(shell("gh pr close 77")).toContain("recover runs")
    const services = { gitlab: { id: "gitlab" as const, namespace: "gitlab", serverName: "gitlab", status: "connected", toolIds: [], capabilities: { createMr: "gitlab_create_merge_request", listMrs: "gitlab_list_merge_requests", updateMr: "gitlab_update_merge_request" } } }
    expect(guardWorkerMcp("gitlab_list_merge_requests", w, services)).toBeUndefined()
    expect(guardWorkerMcp("gitlab_create_merge_request", w, services)).toContain("not approved")
    expect(guardWorkerMcp("gitlab_update_merge_request", w, services)).toContain("not granted")
  })

  test("the command grammar", () => {
    expect(parseCommand("recover")).toEqual({ verb: "recover", dryRun: false, force: false, state: "all", limit: 200, label: undefined, all: false })
    expect(parseCommand("recover --dry-run --force --state merged --limit 50 --label crashfix")).toEqual({ verb: "recover", dryRun: true, force: true, state: "merged", limit: 50, label: "crashfix", all: false })
    expect(parseCommand("recover --all")).toMatchObject({ verb: "recover", all: true, label: undefined })
    expect(parseCommand("recover --all --label x")).toMatchObject({ error: expect.stringContaining("drop --label") })
    expect(parseCommand("recover --state=Open")).toMatchObject({ verb: "recover", state: "open" })
    expect(parseCommand("recover --state nope")).toMatchObject({ error: expect.stringContaining("--state must be all, open, merged, closed") })
    expect(parseCommand("recover --limit 0")).toMatchObject({ error: expect.stringContaining("--limit must be an integer >= 1") })
    expect(parseCommand("doctor --tool gitlab_list_merge_requests")).toEqual({ verb: "doctor", all: false, probe: false, tool: "gitlab_list_merge_requests" })
  })

  test("the submission contract", () => {
    expect(validateRecover({ version: 1, requestId: "recover-1", provider: "glab", rawFile: "/r/x.1.json", errors: [] }, { requestId: "recover-1" })).toMatchObject({ ok: true, value: { provider: "glab", rawFile: "/r/x.1.json" } })
    expect(validateRecover({ version: 1, requestId: "recover-2", provider: "glab", raw: [], errors: [] }, { requestId: "recover-1" })).toMatchObject({ ok: false, errors: ['requestId must be "recover-1"'] })
    expect(validateRecover({ version: 1, requestId: "recover-1", provider: "gitlab-mcp", errors: [] }, { requestId: "recover-1" })).toMatchObject({ ok: false, errors: [expect.stringContaining("raw (the listing reply) or rawFile")] })
    expect(validateRecover({ version: 1, requestId: "recover-1", provider: "gh", errors: ["gh: not logged in"] }, { requestId: "recover-1" })).toMatchObject({ ok: true })
    expect(validateRecover({ version: 1, requestId: "recover-1", provider: "svn", raw: [], errors: [] }, { requestId: "recover-1" })).toMatchObject({ ok: false })
  })

  test("the remote url comes from .git/config, through a gitdir pointer too", async () => {
    expect(remoteUrlFromConfig('[core]\n\tbare = false\n[remote "upstream"]\n\turl = a\n[remote "origin"]\n\turl = git@gitlab.example.com:mobile/shop.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n', "origin")).toBe("git@gitlab.example.com:mobile/shop.git")
    expect(remoteUrlFromConfig('[remote "upstream"]\n\turl = a\n', "origin")).toBeUndefined()
    const root = await mkdtemp(join(tmpdir(), "fixora-remote-"))
    try {
      await mkdir(join(root, "main", ".git"), { recursive: true })
      await writeFile(join(root, "main", ".git", "config"), '[remote "origin"]\n\turl = https://github.com/acme/shop.git\n')
      await mkdir(join(root, "main", "packages", "app"), { recursive: true })
      expect(await readRemoteUrl(join(root, "main", "packages", "app"), "origin")).toBe("https://github.com/acme/shop.git")
      await mkdir(join(root, "main", ".git", "worktrees", "wt"), { recursive: true })
      await writeFile(join(root, "main", ".git", "worktrees", "wt", "commondir"), "../..\n")
      await mkdir(join(root, "wt"), { recursive: true })
      await writeFile(join(root, "wt", ".git"), `gitdir: ${join(root, "main", ".git", "worktrees", "wt")}\n`)
      expect(await readRemoteUrl(join(root, "wt"), "origin")).toBe("https://github.com/acme/shop.git")
      expect(await readRemoteUrl(join(root, "nowhere"), "origin")).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("recover · orchestration", () => {
  let root: string
  let repo: string
  let mock: MockCtx
  let rt: Runtime
  const prompts: string[] = []
  const mode: { via: "mcp" | "cli"; fail?: string } = { via: "mcp" }
  const runA = doneRun({ runId: "sentry-4523123", source: "sentry", crashId: "4523123", title: "TypeError in applyCoupon", jira: true })
  const runB = doneRun({ runId: "crashlytics-deadbeef", source: "crashlytics", crashId: "deadbeef", title: "NPE in CartFragment", review: false })
  const listing = () => [gitlabMr(runA, { iid: 418, state: "merged" }), gitlabMr(runB, { iid: 420, state: "opened" }), { iid: 5, title: "Bump deps", description: "", web_url: "https://gitlab.example.com/mobile/shop/-/merge_requests/5", labels: ["fixora"], state: "opened" }]
  const COMMITS = "Fixora-Run: sentry-4523123\nFixora-Fingerprint: a1b2c3d4e5f60718293a4b5c6d7e8f90\n"

  const worker: Worker = async (prompt, session, tool) => {
    const w = mock.storage.get(`fixora/worker/${session.id}`) as WorkerInfo
    if (w.phase !== "recover") throw new Error(`unexpected phase ${w.phase}`)
    prompts.push(prompt.text)
    const record = mock.storage.get(`fixora/recover/${w.requestId}`) as RecoverRecord
    const submit = async (input: Record<string, unknown>) => {
      const r = await tool("fixora_submit_recover").execute({ version: 1, requestId: w.requestId, errors: [], ...input }, toolCtx(session.id))
      if ((r.output as { ok?: boolean }).ok !== true) throw new Error(`submit_recover rejected: ${r.content}`)
      return r.content ?? ""
    }
    if (mode.fail) return void (await submit({ provider: record.plan.provider, remoteUrl: "<remote url from step 1>", errors: [mode.fail] }))
    const commitsFile = join(repo, ".dxcoder", "fixora", "recover", `${w.requestId}.commits.txt`)
    await writeFile(commitsFile, COMMITS)
    if (mode.via === "mcp") {
      expect(record.plan.toolId).toBe("gitlab_list_merge_requests")
      // Two pages: the first full (per_page 2), the second short.
      const all = listing()
      await submit({ provider: "gitlab-mcp", remoteUrl: "git@gitlab.example.com:mobile/shop.git", raw: [all.slice(0, 2), all.slice(2)], commitsFile })
    } else {
      expect(record.plan.command).toContain("glab mr list --label fixora --all --output json")
      const base = join(repo, ".dxcoder", "fixora", "recover", w.requestId!)
      await writeFile(`${base}.1.json`, JSON.stringify(listing().slice(0, 2)))
      await writeFile(`${base}.2.json`, JSON.stringify(listing().slice(2)))
      await submit({ provider: "glab", remoteUrl: "git@gitlab.example.com:mobile/shop.git", rawFile: `${base}.1.json`, commitsFile })
    }
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "fixora-recover-"))
    repo = join(root, "repo")
    await mkdir(join(repo, ".git"), { recursive: true })
    await writeFile(join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@gitlab.example.com:mobile/shop.git\n')
    mock = mockCtx({ directory: repo, options: {}, worker })
    const opts = readOptions({})
    if (!opts.ok) throw new Error(opts.errors.join())
    rt = { ctx: mock.ctx, opts: opts.value, services: {}, emit: async () => {}, inflight: new Map() }
    await registerPluginTools(mock.ctx, { rt: () => rt, isWorkerSession: async (id) => mock.sessions.has(id), start: async () => ({ started: [], errors: [] }) })
    mock.mcpServers.push({ name: "gitlab", status: "connected" })
    mock.mcpTools.push(fakeMcpTool("gitlab_create_merge_request", { project_id: {} }), fakeMcpTool("gitlab_list_merge_requests", { project_id: { type: "string" }, state: {}, labels: { type: "array" }, per_page: {}, page: {} }))
  })
  afterAll(() => rm(root, { recursive: true, force: true }))

  const fixoraKeys = () => [...mock.storage.keys()].filter((k) => k.startsWith("fixora/run/") || k.startsWith("fixora/crash/"))

  test("dry run: the worker lists through the MCP tool, the report is presented, nothing is written and no approval is asked", async () => {
    mode.via = "mcp"
    const out = await runRecover(rt, { sessionID: "origin", dryRun: true, limit: 2 })
    expect(out.provider).toBe("gitlab-mcp")
    expect(out.listed).toBe(3)
    expect(out.recovered.map((r) => r.runId)).toEqual(["sentry-4523123", "crashlytics-deadbeef"])
    expect(out.skipped.map((s) => s.mr.id)).toEqual(["5"])
    expect(fixoraKeys()).toEqual([])
    expect(mock.permissionRequests.some((p) => p.action === "fixora.recover")).toBe(false)
    expect(mock.sessions.get(out.recovered[0]!.originSessionID)).toBeUndefined() // origin is not a created session
    const session = [...mock.sessions.values()].find((s) => s.title === "Fixora recover · merge requests")!
    expect(session.location?.directory).toBe(repo)
    expect(session.agent).toBe("build")
    expect(prompts.at(-1)).toContain("The remote `origin` is git@gitlab.example.com:mobile/shop.git")
    expect(prompts.at(-1)).toContain('"project_id":"mobile/shop"')
    expect(prompts.at(-1)).toContain('"labels":["fixora"]')
    expect(prompts.at(-1)).toContain("if (!Array.isArray(items) || items.length < 2) break")
    const last = mock.synthetics.at(-1)!
    expect(last.description).toContain("would be recovered")
    expect(last.text).toContain("would recover 2 run(s)")
    expect(last.text).toContain("`/fixora recover` to write these records")
  })

  test("the real run asks once, writes the runs and the crash index (full fingerprints only), saves mr.md, and a rejected approval writes nothing", async () => {
    mode.via = "mcp"
    mock.rejectPermissions.add("fixora.recover")
    await expect(runRecover(rt, { sessionID: "origin" })).rejects.toThrow("rejected fixora.recover")
    mock.rejectPermissions.delete("fixora.recover")
    expect(fixoraKeys()).toEqual([])
    const out = await runRecover(rt, { sessionID: "origin" })
    expect(out.recovered.length).toBe(2)
    const gate = mock.permissionRequests.filter((p) => p.action === "fixora.recover").at(-1)!
    expect(gate.resources[0]).toContain("write 2 run record(s) rebuilt from merge requests (1 merged, 1 draft), 1 with a Jira ticket")
    expect(gate.resources.at(-1)).toContain("only read, never changed")
    const a = mock.storage.get("fixora/run/sentry-4523123") as RunRecord
    expect(a).toMatchObject({ status: "done", mrStatus: "merged", mrProvider: "gitlab-mcp", jiraKey: "DE-456", fingerprint: "a1b2c3d4e5f60718293a4b5c6d7e8f90", repo, base: { remoteUrl: "git@gitlab.example.com:mobile/shop.git" } })
    expect(a.folder).toBe(join(repo, ".dxcoder", "fixora", "sentry-4523123"))
    expect(readFileSync(join(a.folder, "mr.md"), "utf8")).toContain("## Root cause")
    const b = mock.storage.get("fixora/run/crashlytics-deadbeef") as RunRecord
    expect(b.meta?.fingerprintPartial).toBe(true)
    expect(mock.storage.get("fixora/crash/a1b2c3d4e5f60718293a4b5c6d7e8f90")).toMatchObject({ runIds: ["sentry-4523123"] })
    expect(mock.storage.get(`fixora/crash/${b.fingerprint}`)).toBeUndefined()
    expect(mock.synthetics.at(-1)!.text).toContain("recovered 2 run(s)")
  })

  test("a second recovery keeps known runs unless --force; the CLI path reads the numbered page files", async () => {
    mode.via = "cli"
    const saved = rt.services
    rt.services = {}
    const before = mock.mcpTools.splice(0, mock.mcpTools.length)
    try {
      const kept = await runRecover(rt, { sessionID: "origin" })
      expect(kept.provider).toBe("glab")
      expect(kept.recovered).toEqual([])
      expect(kept.known.map((k) => k.runId).sort()).toEqual(["crashlytics-deadbeef", "sentry-4523123"])
      expect(mock.synthetics.at(-1)!.text).toContain("2 already known (kept; `--force` overwrites)")
      const forced = await runRecover(rt, { sessionID: "origin", force: true })
      expect(forced.recovered.length).toBe(2)
      expect((mock.storage.get("fixora/run/sentry-4523123") as RunRecord).mrProvider).toBe("glab")
      const gate = mock.permissionRequests.filter((p) => p.action === "fixora.recover").at(-1)!
      expect(gate.resources.some((r) => r.includes("overwrite 2 existing run record(s) (--force)"))).toBe(true)
    } finally {
      mock.mcpTools.push(...before)
      rt.services = saved
    }
  })

  test("a listing that failed is reported, not written", async () => {
    mode.via = "mcp"
    mode.fail = "page 1: 401 Unauthorized"
    try {
      const out = await runRecover(rt, { sessionID: "origin", force: true })
      expect(out.recovered).toEqual([])
      expect(out.errors).toEqual(["page 1: 401 Unauthorized"])
      // The placeholder the script carries when the remote was unknown is never stored as a url.
      const record = [...mock.storage.entries()].filter(([k]) => k.startsWith("fixora/recover/")).map(([, v]) => v as RecoverRecord).find((r) => r.result?.errors.includes("page 1: 401 Unauthorized"))!
      expect(record.result?.remoteUrl).toBeUndefined()
      expect(mock.synthetics.at(-1)!.text).toContain("Errors: page 1: 401 Unauthorized")
    } finally {
      mode.fail = undefined
    }
  })

  test("a worker that never submits stops with a readable message", async () => {
    const quiet: Worker = async () => {}
    const prev = mock.worker
    mock.worker = quiet
    try {
      await expect(runRecover(rt, { sessionID: "origin" })).rejects.toThrow("did not report the merge requests")
    } finally {
      mock.worker = prev
    }
    expect(existsSync(join(repo, ".dxcoder", "fixora", "recover"))).toBe(true)
  })
})
