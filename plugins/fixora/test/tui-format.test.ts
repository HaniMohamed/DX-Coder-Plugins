// The panel's pure layout and formatting helpers: column widths per panel width, wrapping,
// progress, crash ordering and the text of every row.

import { describe, expect, test } from "bun:test"
import { breakpoint, collapseStages, compactNumber, confidenceToneKey, counterLine, crashGlyph, crashImpact, crashMeta, crashSubline, crashTally, crashTone, crashesLayout, displayWidth, fit, fixBadge, groupCrashes, groupRuns, padDisplay, progressBar, progressOf, relTime, runLinks, runsLayout, sortCrashes, stageTitle, stageTitleWidth, stageTone, STATE_ORDER, STATUS_SHORT, statusTone, truncate, wrap } from "../src/tui/format.js"
import { emptyStages, type CrashRow, type RunView, type StageView } from "../src/tui/store.js"
import type { CrashFix } from "../src/types.js"

const fix = (over: Partial<CrashFix> = {}): CrashFix => ({ runId: "sentry-1", state: "mr_open", label: "fixed · MR !418 draft", at: "2026-11-14T10:00:00.000Z", jiraKey: "DE-456", jiraUrl: "https://jira/DE-456", mrUrl: "https://gl/mr/418", mrRef: "MR !418", mrStatus: "draft", ...over })
const crash = (over: Partial<CrashRow> = {}): CrashRow => ({ source: "sentry", id: "1", title: "TypeError in cart", ...over })

describe("text helpers", () => {
  test("displayWidth counts terminal columns", () => {
    expect(displayWidth("abc")).toBe(3)
    expect(displayWidth("✓ ok")).toBe(4)
    expect(displayWidth("日本")).toBe(4)
    expect(displayWidth("é")).toBe(1)
  })
  test("padDisplay pads or truncates to the exact width", () => {
    expect(padDisplay("ab", 5)).toBe("ab   ")
    expect(padDisplay("ab", 5, "right")).toBe("   ab")
    expect(padDisplay("abcdefgh", 5)).toBe("abcd…")
    expect(padDisplay("日本語です", 5)).toBe("日本…")
    expect(displayWidth(padDisplay("日本語です", 5))).toBe(5)
    expect(padDisplay("", 3)).toBe("   ")
  })
  test("truncate collapses whitespace and keeps the ellipsis inside the width", () => {
    expect(truncate("a   b\n c", 10)).toBe("a b c")
    expect(truncate("abcdef", 3)).toBe("ab…")
    expect(truncate("abcdef", 1)).toBe("…")
    expect(truncate("abcdef", 0)).toBe("")
  })
  test("wrap breaks on words, hard-breaks long tokens and marks a cut last line", () => {
    expect(wrap("the quick brown fox jumps", 10)).toEqual(["the quick", "brown fox", "jumps"])
    expect(wrap("abcdefghijklmnop xy", 6)).toEqual(["abcdef", "ghijkl", "mnop", "xy"])
    expect(wrap("one two three four five six", 9, 2)).toEqual(["one two", "three fo…"])
    expect(wrap("", 10)).toEqual([])
    expect(wrap("   ", 10)).toEqual([])
    for (const line of wrap("a very long root cause explanation that goes on and on for a while", 17)) expect(displayWidth(line)).toBeLessThanOrEqual(17)
  })
  test("compactNumber and crashImpact", () => {
    expect(compactNumber(540)).toBe("540")
    expect(compactNumber(1840)).toBe("1.8k")
    expect(compactNumber(12400)).toBe("12k")
    expect(compactNumber(1_200_000)).toBe("1.2M")
    expect(crashImpact({ userCount: 540 })).toBe("540 users")
    expect(crashImpact({ eventCount: 1840 })).toBe("1.8k events")
    expect(crashImpact({})).toBe("")
    expect(crashMeta({ platform: "android", appVersion: "3.2.1" })).toBe("android v3.2.1")
  })
  test("relTime takes the clock", () => {
    const now = Date.parse("2026-11-15T12:00:00.000Z")
    expect(relTime(now - 20_000, now)).toBe("now")
    expect(relTime(now - 5 * 60_000, now)).toBe("5m ago")
    expect(relTime(now - 3 * 3_600_000, now)).toBe("3h ago")
    expect(relTime(now - 3 * 86_400_000, now)).toBe("3d ago")
  })
})

describe("tones", () => {
  test("status, stage, crash and confidence tones", () => {
    expect(statusTone("done")).toBe("success")
    expect(statusTone("running")).toBe("accent")
    expect(statusTone("awaiting-approval")).toBe("warning")
    expect(statusTone("review-exhausted")).toBe("error")
    expect(statusTone("cancelled")).toBe("muted")
    expect(stageTone("ok")).toBe("success")
    expect(stageTone("pending")).toBe("muted")
    expect(crashTone(undefined)).toBe("base")
    expect(crashTone("reopened")).toBe("warning")
    expect(crashTone("mr_closed")).toBe("error")
    expect(crashTone("in_progress")).toBe("accent")
    expect(crashTone("merged")).toBe("success")
    expect(crashTone("skipped")).toBe("muted")
    expect(confidenceToneKey(0.9)).toBe("success")
    expect(confidenceToneKey(0.6)).toBe("warning")
    expect(confidenceToneKey(0.2)).toBe("error")
  })
  test("short status labels fit the narrow chip column", () => {
    for (const label of Object.values(STATUS_SHORT)) expect(displayWidth(label)).toBeLessThanOrEqual(9)
  })
})

describe("columns", () => {
  test("fit drops optional columns by priority and gives the rest to the flex column", () => {
    const cols = [
      { id: "a", min: 4 },
      { id: "t", min: 10, flex: true },
      { id: "x", min: 6, priority: 1 },
      { id: "y", min: 8, priority: 2 },
    ]
    expect(fit(60, cols)).toEqual({ a: 4, t: 10 + 60 - (4 + 10 + 6 + 8 + 3), x: 6, y: 8 })
    // y (priority 2) goes first, then x
    expect(fit(24, cols)).toEqual({ a: 4, t: 12, x: 6 })
    expect(fit(16, cols)).toEqual({ a: 4, t: 11 })
    // priority-0 columns are never dropped even when they do not fit
    expect(fit(5, cols)).toEqual({ a: 4, t: 10 })
    const sum = (l: Record<string, number>) => Object.values(l).reduce((s, w) => s + w, 0) + Object.keys(l).length - 1
    expect(sum(fit(60, cols))).toBe(60)
    expect(sum(fit(24, cols))).toBe(24)
  })
  test("breakpoints", () => {
    expect(breakpoint(40)).toBe("narrow")
    expect(breakpoint(55)).toBe("narrow")
    expect(breakpoint(56)).toBe("medium")
    expect(breakpoint(83)).toBe("medium")
    expect(breakpoint(84)).toBe("wide")
  })
  test("runs layout per width", () => {
    const ids = (w: number) => Object.keys(runsLayout(w)).sort()
    expect(ids(40)).toEqual(["age", "chip", "cursor", "glyph", "title"])
    expect(ids(48)).toEqual(["age", "chip", "cursor", "glyph", "progress", "title"])
    expect(ids(68)).toEqual(["age", "chip", "cursor", "glyph", "progress", "stage", "title"])
    expect(ids(69)).toEqual(["age", "chip", "cursor", "glyph", "progress", "stage", "title"])
    expect(ids(70)).toEqual(["age", "chip", "cursor", "glyph", "links", "progress", "stage", "title"])
    expect(ids(84)).toEqual(["age", "chip", "cursor", "glyph", "links", "progress", "stage", "title"])
    expect(ids(120)).toEqual(["age", "chip", "cursor", "glyph", "links", "progress", "stage", "title"])
    expect(runsLayout(84).chip).toBe(16)
    expect(runsLayout(55).chip).toBe(9)
    for (const w of [40, 48, 55, 56, 68, 69, 84, 120]) {
      const l = runsLayout(w)
      expect(Object.values(l).reduce((s, x) => s + x, 0) + Object.keys(l).length - 1).toBe(w)
      expect(l.title).toBeGreaterThanOrEqual(12)
    }
  })
  test("crashes layout per width: badge from 56, platform from 69", () => {
    const ids = (w: number) => Object.keys(crashesLayout(w)).sort()
    expect(ids(40)).toEqual(["age", "cursor", "glyph", "impact", "title"])
    expect(ids(55)).toEqual(["age", "cursor", "glyph", "impact", "title"])
    expect(ids(56)).toEqual(["age", "badge", "cursor", "glyph", "impact", "title"])
    expect(ids(68)).toEqual(["age", "badge", "cursor", "glyph", "impact", "title"])
    expect(ids(69)).toEqual(["age", "badge", "cursor", "glyph", "impact", "platform", "title"])
    expect(ids(120)).toEqual(["age", "badge", "cursor", "glyph", "impact", "platform", "title"])
    expect(crashesLayout(120).title).toBe(120 - (2 + 2 + 7 + 10 + 18 + 12) - 6)
  })
  test("stage titles shrink below 70 columns", () => {
    expect(stageTitle("publish", 80)).toBe("Ticket · commit · push · MR")
    expect(stageTitle("publish", 50)).toBe("Publish")
    expect(stageTitle("analyse", 50)).toBe("Root cause")
    expect(stageTitleWidth(80)).toBe(28)
    expect(stageTitleWidth(50)).toBe(11)
    for (const w of [50, 80]) for (const s of emptyStages()) expect(displayWidth(stageTitle(s.step, w))).toBeLessThanOrEqual(stageTitleWidth(w))
  })
})

describe("pipeline", () => {
  const stages = (statuses: StageView["status"][]): StageView[] => emptyStages().map((s, i) => ({ ...s, status: statuses[i] ?? "pending", durationMs: statuses[i] === "ok" ? 1000 : undefined }))
  test("progressOf counts finished stages and names the current one", () => {
    const p = progressOf(stages(["ok", "ok", "skipped", "running"]))
    expect(p).toMatchObject({ done: 3, total: 11, current: "analyse" })
    expect(p.pct).toBeCloseTo(3 / 11)
    expect(progressOf(stages(["ok", "failed"])).current).toBe("fetch")
    expect(progressOf([])).toEqual({ done: 0, total: 0, current: undefined, pct: 0 })
  })
  test("progressBar fills proportionally and never exceeds the width", () => {
    const b = progressBar(6, 11, 10)
    expect(b.filled + b.empty).toHaveLength(10)
    expect(b.filled).toBe("▰".repeat(5))
    expect(progressBar(11, 11, 8).filled).toBe("▰".repeat(8))
    expect(progressBar(0, 0, 4)).toEqual({ filled: "", empty: "▱▱▱▱" })
  })
  test("counterLine mentions only what happened", () => {
    expect(counterLine(undefined)).toBe("")
    expect(counterLine({ fixRounds: 1, reviewRounds: 1, feedback: 0, restarts: 0 })).toBe("")
    expect(counterLine({ fixRounds: 2, reviewRounds: 3, feedback: 1, restarts: 1 })).toBe("fix ×2 · review ×3 · feedback 1 · restarts 1")
  })
  test("collapseStages folds four or more leading finished stages", () => {
    expect(collapseStages(stages(["ok", "ok", "ok", "running"]), true).every((r) => r.kind === "stage")).toBe(true)
    const rows = collapseStages(stages(["ok", "ok", "skipped", "ok", "running"]), true)
    expect(rows[0]).toEqual({ kind: "collapsed", count: 4, durationMs: 3000 })
    expect(rows).toHaveLength(1 + 11 - 4)
    expect(collapseStages(stages(["ok", "ok", "ok", "ok", "running"]), false)).toHaveLength(11)
    // nothing to fold when everything is done
    expect(collapseStages(stages(Array(11).fill("ok")), true)).toHaveLength(11)
  })
})

describe("runs", () => {
  const run = (over: Partial<RunView>): RunView => ({ runId: "r", sessionID: "s", title: "t", status: "done", step: "done", stages: emptyStages(), startedAt: 0, updatedAt: 0, ...over })
  test("groupRuns splits active and finished, omitting empty groups", () => {
    const groups = groupRuns([run({ runId: "a", status: "running" }), run({ runId: "b", status: "done" }), run({ runId: "c", status: "awaiting-approval" })])
    expect(groups.map((g) => [g.key, g.rows.map((r) => r.runId)])).toEqual([
      ["active", ["a", "c"]],
      ["finished", ["b"]],
    ])
    expect(groupRuns([run({ status: "failed" })]).map((g) => g.key)).toEqual(["finished"])
  })
  test("runLinks", () => {
    expect(runLinks({ mrUrl: "u", mrStatus: "merged", jiraKey: "DE-7" })).toBe("MR merged · DE-7")
    expect(runLinks({ mrUrl: "u" })).toBe("MR open")
    expect(runLinks({})).toBe("")
  })
})

describe("crashes", () => {
  test("sortCrashes orders by state then impact; by source groups per source first", () => {
    const rows = [crash({ id: "fixed", state: "merged", userCount: 900 }), crash({ id: "new-small", userCount: 10 }), crash({ id: "back", state: "reopened", userCount: 5 }), crash({ id: "new-big", userCount: 500 }), crash({ id: "events", eventCount: 3 }), crash({ id: "cl", source: "crashlytics", state: "new", userCount: 1 })]
    expect(sortCrashes(rows, "state").map((c) => c.id)).toEqual(["new-big", "new-small", "cl", "events", "back", "fixed"])
    expect(sortCrashes(rows, "source").map((c) => c.id)).toEqual(["cl", "new-big", "new-small", "events", "back", "fixed"])
    expect(STATE_ORDER[0]).toBe("new")
  })
  test("groupCrashes buckets by state or by source", () => {
    const rows = sortCrashes([crash({ id: "a" }), crash({ id: "b", state: "failed" }), crash({ id: "c", state: "in_progress" }), crash({ id: "d", state: "released" }), crash({ id: "e", source: "crashlytics", state: "reopened" })], "state")
    expect(groupCrashes(rows, "state").map((g) => [g.label, g.rows.map((c) => c.id)])).toEqual([
      ["New", ["a"]],
      ["Came back / failed", ["e", "b"]],
      ["In progress", ["c"]],
      ["Fixed", ["d"]],
    ])
    expect(groupCrashes(sortCrashes(rows, "source"), "source").map((g) => g.label)).toEqual(["Crashlytics", "Sentry"])
  })
  test("crashTally", () => {
    expect(crashTally([crash(), crash({ state: "new" }), crash({ state: "mr_open" }), crash({ state: "awaiting" }), crash({ state: "reopened" }), crash({ state: "mr_closed" })])).toEqual({ total: 6, new: 2, fixed: 1, inProgress: 1, reopened: 1, failed: 1, candidates: 3 })
  })
  test("fixBadge and glyph", () => {
    expect(fixBadge(fix({ release: "3.2.2", mrStatus: "merged" }))).toBe("DE-456 · MR !418 merged · release 3.2.2")
    expect(fixBadge(undefined)).toBe("")
    expect(crashGlyph(crash())).toBe("·")
    expect(crashGlyph(crash({ fix: fix({ state: "reopened" }) }))).toBe("↻")
  })
  test("crashSubline lists the fix, the links and the crash URL", () => {
    const lines = crashSubline(crash({ url: "https://sentry/1", fingerprint: "abcdef0123456789", fix: fix({ note: "reopened ×1", stillSeen: true, state: "merged" }) }))
    expect(lines).toEqual([
      { text: "✓ fixed · MR !418 draft · still seen · run sentry-1" },
      { text: "reopened ×1" },
      { text: "Jira DE-456", href: "https://jira/DE-456" },
      { text: "MR !418 draft", href: "https://gl/mr/418" },
      { text: "Sentry · abcdef012345", href: "https://sentry/1" },
    ])
    expect(crashSubline(crash({ runId: "r9" }))).toEqual([{ text: "run r9" }])
    expect(crashSubline(crash())).toEqual([])
  })
})
