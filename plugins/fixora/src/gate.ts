// Approval decisions (pure) and the approval gate. A TUI that acknowledges the gate within a short
// window answers it through RPC (rich dialog); otherwise the host's permission dialog is used.

import type { FixoraOptions } from "./options.js"
import { notify, type Runtime } from "./progress.js"
import type { GatePreview } from "./rpc.js"
import { saveRun } from "./state.js"
import type { ApprovalKind, RunRecord } from "./types.js"

export type Decision = "auto" | "ask" | "skip"

/**
 * Pure. The Jira ticket never asks: it is created whenever Jira is connected and `--no-ticket` is
 * not set (the branch name may need its key before the analysis runs). Publishing (push + MR) is
 * approved by confidence: `approvals: "confidence"` (default) asks only below
 * `confidence.autoApprove`, `"publish"` always asks, `"auto"` (or `--auto`) never asks. Stashing the
 * user's changes asks unless auto mode; deleting a remote branch always asks.
 */
export function decideApproval(kind: ApprovalKind, run: RunRecord, opts: FixoraOptions, o: { serviceAvailable: boolean }): { decision: Decision; reason: string } {
  const autoMode = run.flags.auto || opts.approvals === "auto"
  if (kind === "stash") return autoMode ? { decision: "auto", reason: "auto mode" } : { decision: "ask", reason: "uncommitted changes in the checkout" }
  if (kind === "delete-branch") return { decision: "ask", reason: "remote branch deletion" }
  if (run.flags.dryRun) return { decision: "skip", reason: "dry run" }
  if (kind === "ticket" && !run.flags.ticket) return { decision: "skip", reason: "--no-ticket" }
  if ((kind === "push" || kind === "publish") && !run.flags.push) return { decision: "skip", reason: "--no-push" }
  if (kind === "mr" && !run.flags.mr) return { decision: "skip", reason: "--no-mr" }
  if (!o.serviceAvailable) return { decision: "skip", reason: kind === "ticket" ? "no Jira connection" : "no remote / forge" }
  if (kind === "ticket") return { decision: "auto", reason: "the Jira ticket needs no approval" }
  if (autoMode) return { decision: "auto", reason: "auto mode" }
  if (opts.approvals === "publish") return { decision: "ask", reason: "approvals=publish" }
  const confidence = run.triage?.confidence ?? 0
  const threshold = opts.confidence.autoApprove
  const pct = (x: number) => `${Math.round(x * 100)}%`
  if (confidence >= threshold) return { decision: "auto", reason: `confidence ${pct(confidence)} ≥ ${pct(threshold)}` }
  return { decision: "ask", reason: `confidence ${pct(confidence)} below ${pct(threshold)}` }
}

export class ApprovalRejected extends Error {
  constructor(
    readonly kind: ApprovalKind,
    message: string,
    readonly feedback?: string,
  ) {
    super(message)
    this.name = "ApprovalRejected"
  }
}

// ---------- gate protocol (server side) ----------

type GateOutcome = { via: "tui"; approved: true } | { via: "tui"; approved: false; feedback?: string } | { via: "fallback" }

interface PendingGate {
  runId: string
  kind: ApprovalKind
  acked: boolean
  resolve: (outcome: GateOutcome) => void
}

const pending = new Map<string, PendingGate>()

export const ACK_WINDOW_MS = 1500
export const GATE_EXPIRY_MS = 30 * 60_000

/** A TUI claims the gate; returns false when it is unknown or already answered. */
export function ackGate(gateId: string, runId: string): boolean {
  const g = pending.get(gateId)
  if (!g || g.runId !== runId) return false
  g.acked = true
  return true
}

export function decideGate(gateId: string, runId: string, decision: { approved: boolean; feedback?: string }): boolean {
  const g = pending.get(gateId)
  if (!g || g.runId !== runId) return false
  pending.delete(gateId)
  g.resolve(decision.approved ? { via: "tui", approved: true } : { via: "tui", approved: false, feedback: decision.feedback })
  return true
}

export const pendingGates = () => [...pending.entries()].map(([gateId, g]) => ({ gateId, runId: g.runId, kind: g.kind, acked: g.acked }))

function waitForGate(gateId: string, runId: string, kind: ApprovalKind): Promise<GateOutcome> {
  return new Promise((resolve) => {
    const g: PendingGate = { runId, kind, acked: false, resolve }
    pending.set(gateId, g)
    const done = (outcome: GateOutcome) => {
      if (pending.get(gateId) !== g) return
      pending.delete(gateId)
      resolve(outcome)
    }
    setTimeout(() => {
      if (!g.acked) done({ via: "fallback" })
    }, ACK_WINDOW_MS)
    setTimeout(() => done({ via: "fallback" }), GATE_EXPIRY_MS)
  })
}

export interface ApproveInput {
  resources: string[]
  summary: string
  previewPath?: string
  preview?: GatePreview
}

/**
 * Asks the user. Emits `run.awaiting` with a preview; a TUI that acks within the window answers via
 * `run.approve` / `run.reject`. Otherwise the host's permission dialog is used (resources are human
 * sentences because the generic card prints them line by line). Throws ApprovalRejected on rejection.
 */
export async function approve(rt: Runtime, run: RunRecord, kind: ApprovalKind, o: ApproveInput): Promise<void> {
  const gateId = `${run.runId}:${kind}:${Date.now().toString(36)}`
  run.status = "awaiting-approval"
  await saveRun(rt.ctx, run)
  await rt.emit("run.awaiting", { runId: run.runId, sessionID: run.originSessionID, gateId, kind, summary: o.summary, ackWindowMs: ACK_WINDOW_MS, preview: o.preview ?? {} })
  const outcome = await waitForGate(gateId, run.runId, kind)
  const resolved = async (decision: "approved" | "rejected", by: "tui" | "permission") => {
    run.status = decision === "approved" ? "running" : "rejected"
    run.approvals[kind] = decision
    await saveRun(rt.ctx, run)
    await rt.emit("run.gate.resolved", { runId: run.runId, sessionID: run.originSessionID, gateId, kind, decision, by })
  }
  if (outcome.via === "tui") {
    if (outcome.approved) {
      await resolved("approved", "tui")
      return
    }
    await resolved("rejected", "tui")
    throw new ApprovalRejected(kind, `${kind} was rejected${outcome.feedback ? `: ${outcome.feedback}` : ""}.`, outcome.feedback)
  }
  await notify(rt.ctx, run.originSessionID, `fixora ${run.runId}: ${o.summary} — approve the next dialog to continue`, `[fixora] About to ${kind}. ${o.summary}${o.previewPath ? `\nPreview: ${o.previewPath}` : ""}`)
  try {
    await rt.ctx.permission.assert({
      sessionID: run.originSessionID as never,
      action: `fixora.${kind}`,
      resources: o.resources,
      metadata: { runId: run.runId, kind, preview: o.previewPath, summary: o.summary },
    })
  } catch (error) {
    await resolved("rejected", "permission")
    const detail = error instanceof Error && error.message ? ` (${error.message.slice(0, 200)})` : ""
    throw new ApprovalRejected(kind, `${kind} was not approved${detail}.`)
  }
  await resolved("approved", "permission")
}
