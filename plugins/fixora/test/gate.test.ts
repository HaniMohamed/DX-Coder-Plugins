import { describe, expect, test } from "bun:test"
import { decideApproval } from "../src/gate.js"
import { readOptions } from "../src/options.js"
import { sampleRun } from "./state.test.js"

const opts = (raw: unknown = {}) => {
  const r = readOptions(raw)
  if (!r.ok) throw new Error(r.errors.join())
  return r.value
}
const run = (confidence: number, flags: Partial<ReturnType<typeof sampleRun>["flags"]> = {}) => {
  const r = sampleRun()
  r.flags = { ...r.flags, ...flags }
  r.triage = r.triage ? { ...r.triage, confidence } : undefined
  return r
}

describe("approval decisions", () => {
  test("the Jira ticket never asks; only --no-ticket, dry run or a missing Jira skip it", () => {
    expect(decideApproval("ticket", run(0.1), opts(), { serviceAvailable: true }).decision).toBe("auto")
    expect(decideApproval("ticket", run(0.1), opts({ approvals: "publish" }), { serviceAvailable: true }).decision).toBe("auto")
    expect(decideApproval("ticket", run(0.9, { ticket: false }), opts(), { serviceAvailable: true })).toEqual({ decision: "skip", reason: "--no-ticket" })
    expect(decideApproval("ticket", run(0.9, { dryRun: true }), opts(), { serviceAvailable: true }).decision).toBe("skip")
    expect(decideApproval("ticket", run(0.9), opts(), { serviceAvailable: false }).reason).toBe("no Jira connection")
  })
  test("publishing is decided by confidence in the default mode (80%)", () => {
    expect(decideApproval("publish", run(0.8), opts(), { serviceAvailable: true })).toEqual({ decision: "auto", reason: "confidence 80% ≥ 80%" })
    expect(decideApproval("publish", run(0.79), opts(), { serviceAvailable: true })).toEqual({ decision: "ask", reason: "confidence 79% below 80%" })
    expect(decideApproval("publish", run(0.5), opts({ confidence: { autoApprove: 0.5 } }), { serviceAvailable: true }).decision).toBe("auto")
    const r = sampleRun()
    r.triage = undefined
    expect(decideApproval("publish", r, opts(), { serviceAvailable: true }).decision).toBe("ask")
  })
  test("approvals=publish always asks, approvals=auto and --auto never ask", () => {
    expect(decideApproval("publish", run(0.99), opts({ approvals: "publish" }), { serviceAvailable: true })).toEqual({ decision: "ask", reason: "approvals=publish" })
    expect(decideApproval("publish", run(0.1), opts({ approvals: "auto" }), { serviceAvailable: true }).decision).toBe("auto")
    expect(decideApproval("publish", run(0.1, { auto: true }), opts(), { serviceAvailable: true }).decision).toBe("auto")
    expect(decideApproval("stash", run(0.99), opts(), { serviceAvailable: true }).decision).toBe("ask")
    expect(decideApproval("stash", run(0.1, { auto: true }), opts(), { serviceAvailable: true }).decision).toBe("auto")
    expect(decideApproval("delete-branch", run(0.99), opts({ approvals: "auto" }), { serviceAvailable: true }).decision).toBe("ask")
  })
})
