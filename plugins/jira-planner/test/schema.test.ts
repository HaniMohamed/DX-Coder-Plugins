import { describe, expect, test } from "bun:test"
import { parseSubtasksJson, topologicalOrder, validateSubtasksFile } from "../src/schema.js"

const ctx = { issue: "PROJ-1", existingKeys: ["PROJ-2", "PROJ-3"] }

const valid = () => ({
  version: 1,
  issue: "PROJ-1",
  generatedAt: "2026-01-31T10:00:00.000Z",
  summary: "Export invoices via a new endpoint and a nightly job.",
  subtasks: [
    { id: "S1", title: "Add export endpoint", description: "Build it", storyPoints: 3, dependsOn: [], parallel: true, assumptions: [], confidence: "high", matchedExisting: null },
    {
      id: "S2",
      title: "Schedule nightly export",
      description: "Cron",
      storyPoints: 2,
      dependsOn: ["S1"],
      parallel: false,
      assumptions: ["uses existing scheduler"],
      confidence: "medium",
      matchedExisting: { key: "PROJ-2", summary: "Nightly export cron job", existingPoints: 1, verdict: "partial" },
    },
  ],
  notes: ["PROJ-3 is obsolete"],
})

describe("validateSubtasksFile", () => {
  test("accepts a valid file", () => {
    const r = validateSubtasksFile(valid(), ctx)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.subtasks).toHaveLength(2)
  })

  test("rejects non-integer or zero story points", () => {
    const f = valid()
    f.subtasks[0]!.storyPoints = 2.5
    f.subtasks[1]!.storyPoints = 0
    const r = validateSubtasksFile(f, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("subtasks[0].storyPoints"))).toBe(true)
      expect(r.errors.some((e) => e.includes("subtasks[1].storyPoints"))).toBe(true)
    }
  })

  test("rejects unknown dependsOn ids and cycles", () => {
    const f = valid()
    f.subtasks[0]!.dependsOn = ["S2"]
    const cycle = validateSubtasksFile(f, ctx)
    expect(cycle.ok).toBe(false)
    if (!cycle.ok) expect(cycle.errors.join("\n")).toContain("cycle")

    const g = valid()
    g.subtasks[1]!.dependsOn = ["S9"]
    const unknown = validateSubtasksFile(g, ctx)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.errors.join("\n")).toContain('unknown id "S9"')
  })

  test("rejects matchedExisting keys that are not in Jira or used twice", () => {
    const f = valid()
    f.subtasks[0]!.matchedExisting = { key: "PROJ-99", summary: "x", existingPoints: null, verdict: "same" } as never
    const r = validateSubtasksFile(f, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("PROJ-99")

    const g = valid()
    g.subtasks[0]!.matchedExisting = { key: "PROJ-2", summary: "x", existingPoints: 1, verdict: "same" } as never
    const dup = validateSubtasksFile(g, ctx)
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.errors.join("\n")).toContain("already matched")
  })

  test("rejects wrong issue key, missing matchedExisting and duplicate ids", () => {
    const f = valid()
    f.issue = "OTHER-1"
    f.subtasks[1]!.id = "S1"
    delete (f.subtasks[0] as { matchedExisting?: unknown }).matchedExisting
    const r = validateSubtasksFile(f, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const text = r.errors.join("\n")
      expect(text).toContain('issue must be "PROJ-1"')
      expect(text).toContain("duplicated")
      expect(text).toContain("matchedExisting is required")
    }
  })

  test("reports JSON syntax errors", () => {
    const r = parseSubtasksJson("{ not json", ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain("not valid JSON")
  })
})

describe("topologicalOrder", () => {
  test("puts dependencies first and keeps stable order", () => {
    const r = validateSubtasksFile(valid(), ctx)
    if (!r.ok) throw new Error("fixture invalid")
    const reversed = [...r.value.subtasks].reverse()
    expect(topologicalOrder(reversed).map((s) => s.id)).toEqual(["S1", "S2"])
  })
})
