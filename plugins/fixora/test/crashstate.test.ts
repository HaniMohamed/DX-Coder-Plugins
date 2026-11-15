// What the crash list says about crashes Fixora already handled: state, label, links, reopen
// detection, the tally line and the markdown table.

import { describe, expect, test } from "bun:test"
import { crashFixOf, describeTally, isFixCandidate, isFixed, nextCommands, tallyFixes } from "../src/crashstate.js"
import { fixCell, fixLinks, renderCrashTable } from "../src/render.js"
import type { CrashIndexEntry, CrashSummary } from "../src/types.js"
import { sampleRun } from "./state.test.js"

const NOW = "2026-11-15T12:00:00.000Z"
const index = (over: Partial<CrashIndexEntry> = {}): CrashIndexEntry => ({ fingerprint: "abcdef0123456789abcdef0123456789", runIds: ["sentry-4523123"], reopened: { count: 0 }, ...over })

describe("crashFixOf", () => {
  test("an open draft MR: fixed, with the Jira and MR links and the provider-specific MR ref", () => {
    const fix = crashFixOf(sampleRun(), { now: NOW })
    expect(fix.state).toBe("mr_open")
    expect(fix.label).toBe("fixed · MR !418 draft")
    expect(fix).toMatchObject({ runId: "sentry-4523123", jiraKey: "APP-1831", jiraUrl: "https://jira.example.com/browse/APP-1831", mrUrl: "https://gitlab.example.com/mobile/shop/-/merge_requests/418", mrRef: "MR !418", branch: "fixora/sentry-4523123-typeerror", attempts: 1 })
    expect(isFixed(fix.state)).toBe(true)
    expect(isFixCandidate(fix.state)).toBe(false)
  })

  test("github provider: PR #n", () => {
    expect(crashFixOf(sampleRun({ mrProvider: "github-mcp", mrId: "12", mrStatus: "open" })).label).toBe("fixed · PR #12 open")
    expect(crashFixOf(sampleRun({ mrProvider: "url", mrId: undefined })).label).toBe("fixed · MR draft")
  })

  test("merged MR: fixed · merged; still seen after the merge is flagged, not reopened", () => {
    const run = sampleRun({ mrStatus: "merged", meta: { mergedAt: "2026-11-14T12:00:00.000Z" } })
    const quiet = crashFixOf(run, { crash: { lastSeen: "2026-11-14T11:00:00.000Z" }, now: NOW })
    expect(quiet.state).toBe("merged")
    expect(quiet.label).toBe("fixed · MR !418 merged")
    expect(quiet.at).toBe("2026-11-14T12:00:00.000Z")
    expect(quiet.stillSeen).toBeUndefined()
    const loud = crashFixOf(run, { crash: { lastSeen: "2026-11-15T01:00:00.000Z" }, now: NOW })
    expect(loud.state).toBe("merged")
    expect(loud.stillSeen).toBe(true)
    expect(loud.note).toContain("still seen after the merge")
  })

  test("marked fixed in a release: released, unless the source saw it again afterwards (reopened with the reason)", () => {
    const idx = index({ fixedIn: { release: "2.3.1", platform: "android", markedBy: "ses", at: "2026-11-14T12:00:00.000Z", runId: "sentry-4523123" } })
    const run = sampleRun({ mrStatus: "merged" })
    const ok = crashFixOf(run, { index: idx, crash: { lastSeen: "2026-11-14T11:00:00.000Z", appVersion: "2.3.1" }, now: NOW })
    expect(ok.state).toBe("released")
    expect(ok.label).toBe("fixed in 2.3.1 (android)")
    expect(ok.release).toBe("2.3.1")
    expect(nextCommands(ok)).toEqual([])
    const shipped = crashFixOf(run, { index: idx, crash: { lastSeen: "2026-11-15T01:00:00.000Z", appVersion: "2.3.2" }, now: NOW })
    expect(shipped.state).toBe("reopened")
    expect(shipped.stillSeen).toBe(true)
    expect(shipped.label).toBe("came back after the fix in 2.3.1")
    expect(shipped.note).toBe("seen again in 2.3.2 (fixed in 2.3.1)")
    expect(isFixCandidate(shipped.state)).toBe(true)
    const old = crashFixOf(run, { index: idx, crash: { lastSeen: "2026-11-15T01:00:00.000Z", appVersion: "2.3.0" }, now: NOW })
    expect(old.note).toBe("seen in 2.3.0, fix shipped in 2.3.1")
    // The index already recorded a reopen (a later fetch detected it): reopened even without list data.
    const recorded = crashFixOf(run, { index: index({ ...idx, reopened: { count: 2, reason: "incomplete-fix" } }), now: NOW })
    expect(recorded.state).toBe("reopened")
    expect(recorded.reopened).toBe(2)
    expect(recorded.note).toBe("likely incomplete fix")
  })

  test("a release marked on another run of the same fingerprint does not claim this run", () => {
    const idx = index({ fixedIn: { release: "2.3.1", markedBy: "ses", at: "2026-11-14T12:00:00.000Z", runId: "manual-other" } })
    expect(crashFixOf(sampleRun(), { index: idx, now: NOW }).state).toBe("mr_open")
  })

  test("closed MR, done without MR, dry run, skipped, failed / blocked, running, awaiting", () => {
    expect(crashFixOf(sampleRun({ mrStatus: "closed" }))).toMatchObject({ state: "mr_closed", label: "MR !418 closed without merging" })
    expect(crashFixOf(sampleRun({ mrUrl: undefined, mrId: undefined, mrStatus: undefined }))).toMatchObject({ state: "fixed", label: "fixed · pushed, no MR" })
    expect(crashFixOf(sampleRun({ mrUrl: undefined, mrStatus: undefined, flags: { ...sampleRun().flags, dryRun: true } }))).toMatchObject({ state: "fixed", label: "fixed (dry run, not committed)" })
    expect(crashFixOf(sampleRun({ mrUrl: undefined, mrStatus: undefined, status: "skipped", skipReason: "third-party only" }))).toMatchObject({ state: "skipped", label: "skipped: third-party only" })
    const blocked = crashFixOf(sampleRun({ mrUrl: undefined, mrStatus: undefined, status: "blocked", blockedReason: "base-missing", step: "prepare", error: "fatal: couldn't find remote ref main\nmore" }))
    expect(blocked).toMatchObject({ state: "failed", label: "blocked at prepare (base-missing)", note: "fatal: couldn't find remote ref main" })
    expect(isFixCandidate(blocked.state)).toBe(true)
    expect(crashFixOf(sampleRun({ status: "review-exhausted", step: "review", mrUrl: undefined, mrStatus: undefined })).label).toBe("review-exhausted at review")
    // An MR that exists outranks a later failed round: the fix is still there to look at.
    expect(crashFixOf(sampleRun({ status: "review-exhausted", step: "review" })).state).toBe("mr_open")
    expect(crashFixOf(sampleRun({ status: "running", step: "analyse" }))).toMatchObject({ state: "in_progress", label: "finding the root cause" })
    // In flight in this process wins over a stale record.
    expect(crashFixOf(sampleRun({ status: "failed" }), { inflight: true }).state).toBe("in_progress")
    expect(crashFixOf(sampleRun({ status: "awaiting-approval", step: "publish" }))).toMatchObject({ state: "awaiting", label: "waiting for your approval" })
  })

  test("reopen history is kept as a note on later states; attempts count restarts", () => {
    const fix = crashFixOf(sampleRun({ reopened: { count: 1, fixedIn: "2.3.0", previousRunId: "sentry-4523123" }, counters: { fixRounds: 0, reviewRounds: 0, feedback: 0, restarts: 1, workerPrompts: 2 } }))
    expect(fix.state).toBe("mr_open")
    expect(fix.note).toBe("reopened ×1 (was fixed in 2.3.0)")
    expect(fix.attempts).toBe(2)
  })

  test("next commands depend on the state", () => {
    expect(nextCommands(crashFixOf(sampleRun()))).toEqual(['/fixora feedback sentry-4523123 "…"', "/fixora fixed sentry-4523123 --release <version>"])
    expect(nextCommands(crashFixOf(sampleRun({ mrStatus: "merged" })))).toEqual(["/fixora fixed sentry-4523123 --release <version>"])
    expect(nextCommands(crashFixOf(sampleRun({ mrStatus: "closed" })), "sentry:4523123")).toEqual(["/fixora restart sentry-4523123", "/fixora fix sentry:4523123 --force"])
    expect(nextCommands(crashFixOf(sampleRun({ status: "failed", mrUrl: undefined, mrStatus: undefined })))).toEqual(["/fixora retry sentry-4523123"])
  })
})

const summary = (over: Partial<CrashSummary>): CrashSummary => ({ source: "sentry", id: "1", title: "crash", userCount: 10, eventCount: 20, lastSeen: "2026-11-15T10:00:00.000Z", appVersion: "2.3.2", ...over })

describe("tally and table", () => {
  const merged = crashFixOf(sampleRun({ mrStatus: "merged" }), { now: NOW })
  const open = crashFixOf(sampleRun({ runId: "crashlytics-abc", jiraKey: undefined, jiraUrl: undefined, mrId: "419", mrUrl: "https://gitlab.example.com/mobile/shop/-/merge_requests/419", mrStatus: "open" }), { now: NOW })
  const failed = crashFixOf(sampleRun({ runId: "sentry-9", status: "failed", step: "fix", error: "no report", mrUrl: undefined, mrStatus: undefined, jiraKey: undefined, jiraUrl: undefined }), { now: NOW })
  const list: CrashSummary[] = [
    summary({ id: "4523123", title: "TypeError in applyCoupon", userCount: 540, state: merged.state, runId: merged.runId, fix: merged }),
    summary({ source: "crashlytics", id: "abc", title: "Null check operator used on a null value", userCount: 300, platform: "android", state: open.state, runId: open.runId, fix: open, ref: "crashlytics:abc@1:1:android:x" }),
    summary({ id: "9", title: "RangeError", userCount: 50, state: failed.state, runId: failed.runId, fix: failed }),
    summary({ id: "10", title: "Fresh one", userCount: 5 }),
  ]

  test("tally line", () => {
    const t = tallyFixes(list)
    expect(t).toMatchObject({ total: 4, fixed: 2, candidates: 2, byState: { merged: 1, mr_open: 1, failed: 1, new: 1 } })
    expect(describeTally(t)).toBe("2 of 4 already fixed by Fixora (1 merged · 1 MR open) · 1 failed · 1 new")
    expect(describeTally(tallyFixes([summary({})]))).toBe("1 crash(es), none fixed by Fixora yet · 1 new")
  })

  test("links and cells", () => {
    expect(fixLinks(merged)).toBe("[APP-1831](https://jira.example.com/browse/APP-1831) · [MR !418 merged](https://gitlab.example.com/mobile/shop/-/merge_requests/418)")
    expect(fixLinks(open)).toBe("[MR !419 open](https://gitlab.example.com/mobile/shop/-/merge_requests/419)")
    expect(fixLinks(failed)).toBe("—")
    expect(fixCell(list[3]!)).toBe("new")
    expect(fixCell(list[0]!)).toBe("✓ **fixed · MR !418 merged** · [APP-1831](https://jira.example.com/browse/APP-1831) · [MR !418 merged](https://gitlab.example.com/mobile/shop/-/merge_requests/418)")
    expect(fixCell(list[2]!)).toBe("✗ **failed at fix**")
  })

  test("the table marks handled crashes and lists their details, links and next commands", () => {
    const md = renderCrashTable(list, { now: NOW })
    expect(md.startsWith("2 of 4 already fixed by Fixora (1 merged · 1 MR open) · 1 failed · 1 new.\n")).toBe(true)
    expect(md).toContain("| # | Ref | Title | Users | Events | Version | Last seen | Fixora |")
    expect(md).toContain("| 1 | `sentry:4523123` | TypeError in applyCoupon | 540 | 20 | 2.3.2 | 2h ago | ✓ **fixed · MR !418 merged** · [APP-1831](https://jira.example.com/browse/APP-1831) · [MR !418 merged](https://gitlab.example.com/mobile/shop/-/merge_requests/418) |")
    expect(md).toContain("| 4 | `sentry:10` | Fresh one | 5 | 20 | 2.3.2 | 2h ago | new |")
    expect(md).toContain("**Already handled by Fixora**")
    expect(md).toContain("- **#1** TypeError in applyCoupon: ✓ fixed · MR !418 merged · run `sentry-4523123` · branch `fixora/sentry-4523123-typeerror` · [APP-1831](https://jira.example.com/browse/APP-1831) · [MR !418 merged](https://gitlab.example.com/mobile/shop/-/merge_requests/418) · 26h ago. Next: `/fixora fixed sentry-4523123 --release <version>`")
    expect(md).toContain("- **#3** RangeError: ✗ failed at fix · run `sentry-9` · branch `fixora/sentry-4523123-typeerror` · 26h ago. no report. Next: `/fixora retry sentry-9`")
    expect(md).toContain('skipped by "Fix the top N"')
    // Nothing handled: no tally, no details block.
    const plain = renderCrashTable([list[3]!], { now: NOW })
    expect(plain.startsWith("| # |")).toBe(true)
    expect(plain).not.toContain("Already handled")
  })
})
