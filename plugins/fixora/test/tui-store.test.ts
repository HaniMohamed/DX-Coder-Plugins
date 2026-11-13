import { describe, expect, test } from "bun:test"
import { activeRuns, applyEvent, applyRecord, applySummary, awaitingGates, fmtClock, fmtShort, initialState, meter, panelRun, truncate } from "../src/tui/store.js"
import { sampleRun } from "./state.test.js"

const T0 = Date.parse("2026-11-14T10:00:00.000Z")

describe("tui store reducers", () => {
  test("a run's life through events", () => {
    const s = initialState()
    applyEvent(s, "run.started", { runId: "sentry-1", sessionID: "ses_1", title: "TypeError in cart" }, T0)
    expect(s.order).toEqual(["sentry-1"])
    expect(s.runs["sentry-1"]!.stages.every((st) => st.status === "pending")).toBe(true)
    applyEvent(s, "run.stage", { runId: "sentry-1", sessionID: "ses_1", step: "detect", status: "running", attempt: 1 }, T0 + 100)
    expect(s.runs["sentry-1"]!.stages[0]).toMatchObject({ step: "detect", status: "running", startedAt: T0 + 100 })
    applyEvent(s, "run.stage", { runId: "sentry-1", sessionID: "ses_1", step: "detect", status: "ok", durationMs: 800, detail: "sentry · gitlab remote" }, T0 + 900)
    expect(s.runs["sentry-1"]!.stages[0]).toMatchObject({ status: "ok", durationMs: 800, detail: "sentry · gitlab remote" })
    applyEvent(s, "run.stage", { runId: "sentry-1", sessionID: "ses_1", step: "analyse", status: "running" }, T0 + 1000)
    applyEvent(s, "run.progress", { runId: "sentry-1", sessionID: "ses_1", step: "analyse", message: "reading git blame" }, T0 + 1500)
    expect(s.runs["sentry-1"]!.progress).toBe("reading git blame")
    applyEvent(s, "run.card", { runId: "sentry-1", sessionID: "ses_1", kind: "triage", data: { rootCause: "nil amount", confidence: 0.82, category: "null-deref", risk: "low", introducedBy: "b7e21c0 faster sheet" } }, T0 + 2000)
    expect(s.runs["sentry-1"]).toMatchObject({ rootCause: "nil amount", confidence: 0.82, introducedBy: "b7e21c0 faster sheet" })
    // A loop back to validate resets later stages to pending.
    applyEvent(s, "run.stage", { runId: "sentry-1", sessionID: "ses_1", step: "review", status: "failed", detail: "rejected" }, T0 + 3000)
    applyEvent(s, "run.stage", { runId: "sentry-1", sessionID: "ses_1", step: "validate", status: "running", attempt: 2 }, T0 + 3100)
    const run = s.runs["sentry-1"]!
    expect(run.stages.find((st) => st.step === "review")!.status).toBe("pending")
    expect(run.stages.find((st) => st.step === "validate")).toMatchObject({ status: "running", attempt: 2 })
    expect(activeRuns(s).map((r) => r.runId)).toEqual(["sentry-1"])

    applyEvent(s, "run.awaiting", { runId: "sentry-1", sessionID: "ses_1", gateId: "g1", kind: "publish", summary: "push and open a draft MR", preview: { branch: "fixora/x", files: ["a.ts"] } }, T0 + 4000)
    expect(run.status).toBe("awaiting-approval")
    expect(awaitingGates(s)).toHaveLength(1)
    expect(awaitingGates(s)[0]!.preview.branch).toBe("fixora/x")
    expect(panelRun(s, "ses_1")?.runId).toBe("sentry-1")
    applyEvent(s, "run.gate.resolved", { runId: "sentry-1", sessionID: "ses_1", gateId: "g1", kind: "publish", decision: "approved", by: "tui" }, T0 + 5000)
    expect(awaitingGates(s)).toHaveLength(0)
    expect(run.status).toBe("running")
    applyEvent(s, "run.done", { runId: "sentry-1", sessionID: "ses_1", mrUrl: "https://gl/mr/1", branch: "fixora/x", totalMs: 400000, report: "## done" }, T0 + 6000)
    expect(run).toMatchObject({ status: "done", step: "done", mrUrl: "https://gl/mr/1", totalMs: 400000 })
    expect(run.stages.every((st) => st.status !== "running")).toBe(true)
  })

  test("failures clear gates and mark the stage", () => {
    const s = initialState()
    applyEvent(s, "run.started", { runId: "r", sessionID: "ses" }, T0)
    applyEvent(s, "run.stage", { runId: "r", sessionID: "ses", step: "push", status: "running" }, T0)
    applyEvent(s, "run.awaiting", { runId: "r", sessionID: "ses", gateId: "g", kind: "publish", summary: "x" }, T0)
    applyEvent(s, "run.failed", { runId: "r", sessionID: "ses", step: "push", status: "rejected", error: "publish was rejected" }, T0)
    expect(awaitingGates(s)).toHaveLength(0)
    expect(s.runs.r!.stages.find((st) => st.step === "push")!.status).toBe("failed")
    expect(s.runs.r!.status).toBe("rejected")
    applyEvent(s, "run.failed", { runId: "r2", sessionID: "ses", step: "map", status: "skipped", error: "no in-app frames" }, T0)
    expect(s.runs.r2!.stages.find((st) => st.step === "map")!.status).toBe("pending")
  })

  test("hydration from summaries and records", () => {
    const s = initialState()
    applySummary(s, { runId: "a", source: "sentry", crashId: "1", title: "A", step: "fix", status: "running", createdAt: "2026-11-14T10:00:00.000Z", updatedAt: "2026-11-14T10:05:00.000Z", originSessionID: "ses_a" }, T0)
    const a = s.runs.a!
    expect(a.sessionID).toBe("ses_a")
    expect(a.stages.find((st) => st.step === "detect")!.status).toBe("ok")
    expect(a.stages.find((st) => st.step === "fix")!.status).toBe("running")
    expect(a.stages.find((st) => st.step === "review")!.status).toBe("pending")
    applySummary(s, { runId: "b", source: "manual", crashId: "2", title: "B", step: "done", status: "done", createdAt: "2026-11-14T09:00:00.000Z", updatedAt: "2026-11-14T09:30:00.000Z", mrUrl: "https://x" }, T0)
    expect(s.runs.b!.stages.every((st) => st.status === "ok")).toBe(true)
    expect(s.order).toEqual(["a", "b"])
    const rec = sampleRun()
    const view = applyRecord(s, rec, T0)
    expect(view).toMatchObject({ runId: rec.runId, confidence: 0.82, category: "null-deref", files: ["src/cart/service.ts", "src/cart/service.test.ts"], review: "approve_with_nits (round 1)", jiraKey: "APP-1831", fixerSessionID: "ses_w" })
    expect(view.checks).toBe("unit ✓ · typecheck ✓")
    expect(view.introducedBy).toContain("3f2a1c9")
    expect(view.stages.find((st) => st.step === "analyse")).toMatchObject({ status: "ok", durationMs: 179000 })
  })

  test("formatting helpers", () => {
    expect(fmtClock(65_000)).toBe("01:05")
    expect(fmtShort(900)).toBe("900ms")
    expect(fmtShort(2500)).toBe("2.5s")
    expect(fmtShort(125_000)).toBe("02:05")
    expect(truncate("a very long title indeed", 10)).toBe("a very lo…")
    expect(meter(0.82)).toEqual({ filled: "████████", empty: "░░" })
  })
})
