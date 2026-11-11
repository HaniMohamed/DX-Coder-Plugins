import { describe, expect, test } from "bun:test"
import { computeGapReport, decidePush, estimateVerdict, MARKER, matchHints, normalizeTitle, renderGapReport, tokens } from "../src/audit.js"
import type { ExistingSubtask, SubtasksFile } from "../src/schema.js"

const plan: SubtasksFile = {
  version: 1,
  issue: "PROJ-1",
  generatedAt: "2026-01-31T10:00:00.000Z",
  summary: "Export invoices via a new endpoint and a nightly job.",
  subtasks: [
    { id: "S1", title: "Add invoice export endpoint", description: "d", storyPoints: 3, dependsOn: [], parallel: true, assumptions: [], confidence: "high", matchedExisting: null },
    {
      id: "S2",
      title: "Schedule nightly export job",
      description: "d",
      storyPoints: 2,
      dependsOn: ["S1"],
      parallel: false,
      assumptions: [],
      confidence: "medium",
      matchedExisting: { key: "PROJ-2", summary: "Nightly export cron job", existingPoints: 1, verdict: "partial" },
    },
    { id: "S3", title: "Remove legacy CSV mapper", description: "d", storyPoints: 1, dependsOn: [], parallel: true, assumptions: [], confidence: "low", matchedExisting: null },
  ],
}

const existing: ExistingSubtask[] = [
  { key: "PROJ-2", summary: "Nightly export cron job", status: "To Do", storyPoints: 5 },
  { key: "PROJ-3", summary: "Legacy CSV mapper cleanup", status: "To Do", storyPoints: null },
  { key: "PROJ-4", summary: "Write release notes", status: "Done", storyPoints: 1 },
]

describe("normalizeTitle / tokens", () => {
  test("strips key prefixes, punctuation and stopwords", () => {
    expect(normalizeTitle("[PROJ-1] Add: the Export-Endpoint!")).toBe("add the export endpoint")
    expect([...tokens("PROJ-7: Implement invoice exports for finance")].sort()).toEqual(["export", "finance", "invoice"])
  })
})

describe("matchHints", () => {
  test("pairs similar titles one-to-one with strength", () => {
    const hints = matchHints(plan.subtasks, existing)
    const s3 = hints.find((h) => h.plannedId === "S3")
    expect(s3?.key).toBe("PROJ-3")
    expect(s3?.strength).toBe("strong")
    expect(hints.filter((h) => h.key === "PROJ-4")).toHaveLength(0)
  })
})

describe("estimateVerdict", () => {
  test("flags drift above 30% or 2 points, otherwise ok, null is unestimated", () => {
    expect(estimateVerdict(3, 3)).toEqual({ estimate: "ok", delta: 0 })
    expect(estimateVerdict(5, 6)).toEqual({ estimate: "ok", delta: 1 })
    expect(estimateVerdict(5, 7)).toEqual({ estimate: "drift", delta: 2 })
    expect(estimateVerdict(2, 1)).toEqual({ estimate: "drift", delta: -1 })
    expect(estimateVerdict(3, null)).toEqual({ estimate: "unestimated", delta: null })
  })
})

describe("computeGapReport", () => {
  test("splits matched, missing and extra and uses live Jira points", () => {
    const report = computeGapReport(plan, existing, "2026-02-01T00:00:00.000Z")
    expect(report.matched.map((m) => m.key)).toEqual(["PROJ-2"])
    expect(report.matched[0]!.existingPoints).toBe(5)
    expect(report.matched[0]!.estimate).toBe("drift")
    expect(report.missing.map((m) => m.plannedId)).toEqual(["S1", "S3"])
    expect(report.missing.find((m) => m.plannedId === "S3")?.hint?.key).toBe("PROJ-3")
    expect(report.extra.map((e) => e.key).sort()).toEqual(["PROJ-3", "PROJ-4"])
    expect(report.totals).toEqual({ plannedPoints: 6, existingPoints: 6, matchedPlannedPoints: 2, matchedExistingPoints: 5 })
    const md = renderGapReport(report)
    expect(md).toContain("| S1 | Add invoice export endpoint | 3 |")
    expect(md).toContain("**PROJ-2** (S2): Jira has 5 pts, plan says 2 pts (+3)")
    expect(md).toContain("PROJ-3 (strong")
  })
})

describe("decidePush", () => {
  test("skips matched, already-created, marker and same-title subtasks and orders by dependency", () => {
    const withMarker: ExistingSubtask[] = [
      ...existing,
      { key: "PROJ-50", summary: "Something else", status: "To Do", storyPoints: 1, description: `old text ${MARKER("PROJ-1", "S3")}` },
    ]
    const decisions = decidePush(plan, withMarker, [])
    expect(decisions.map((d) => `${d.subtask.id}:${d.action}`)).toEqual(["S1:create", "S2:skip", "S3:skip"])
    expect(decisions[2]!.reason).toContain("PROJ-50")

    const again = decidePush(plan, existing, [{ id: "S1", key: "PROJ-60" }])
    expect(again.find((d) => d.subtask.id === "S1")?.reason).toContain("PROJ-60")

    const sameTitle = decidePush(plan, [...existing, { key: "PROJ-70", summary: "add invoice export endpoint", status: "To Do", storyPoints: 3 }], [])
    expect(sameTitle.find((d) => d.subtask.id === "S1")?.reason).toContain("same title")
  })
})
