// Approval decisions (pure) and the approval dialog (permission.assert).

import type { FixoraOptions } from "./options.js"
import { notify, type Runtime } from "./progress.js"
import { saveRun } from "./state.js"
import type { ApprovalKind, RunRecord } from "./types.js"

export type Decision = "auto" | "ask" | "skip"

export function decideApproval(kind: ApprovalKind, run: RunRecord, opts: FixoraOptions, o: { serviceAvailable: boolean }): { decision: Decision; reason: string } {
  if (run.flags.dryRun) return { decision: "skip", reason: "dry run" }
  if (kind === "ticket" && !run.flags.ticket) return { decision: "skip", reason: "--no-ticket" }
  if ((kind === "push" || kind === "publish") && !run.flags.push) return { decision: "skip", reason: "--no-push" }
  if (kind === "mr" && !run.flags.mr) return { decision: "skip", reason: "--no-mr" }
  if (!o.serviceAvailable) return { decision: "skip", reason: kind === "ticket" ? "no Jira connection" : "no remote / forge" }
  if (kind !== "ticket") {
    const confidence = run.triage?.confidence ?? 0
    const review = run.reviews[run.reviews.length - 1]
    const tests = run.tests?.allPassed ?? false
    const risk = run.fix?.risk.level ?? run.triage?.risk.level ?? "high"
    const autoOk = confidence >= opts.confidence.autoApprove && tests && review?.verdict !== "reject" && review !== undefined && risk === "low"
    if ((run.flags.auto || opts.approvals === "auto") && autoOk) return { decision: "auto", reason: `confidence ${Math.round(confidence * 100)}% ≥ ${Math.round(opts.confidence.autoApprove * 100)}%, checks green, review ${review.verdict}, risk low` }
    if (run.flags.auto || opts.approvals === "auto") return { decision: "ask", reason: `auto-approve criteria not met (confidence ${Math.round(confidence * 100)}%, tests ${tests ? "green" : "red"}, review ${review?.verdict ?? "none"}, risk ${risk})` }
  } else if (run.flags.auto || opts.approvals === "auto") return { decision: "auto", reason: "auto mode" }
  return { decision: "ask", reason: `approvals=${opts.approvals}` }
}

/** Which gates exist for this run: one "publish" gate by default, or push + mr separately. */
export function gateKinds(opts: FixoraOptions): { push: ApprovalKind; mr: ApprovalKind | undefined } {
  return opts.approvals === "each" ? { push: "push", mr: "mr" } : { push: "publish", mr: undefined }
}

export class ApprovalRejected extends Error {
  constructor(
    readonly kind: ApprovalKind,
    message: string,
  ) {
    super(message)
    this.name = "ApprovalRejected"
  }
}

/**
 * Asks the user through the host's permission dialog. Resources are human sentences because the
 * generic permission card prints them line by line. Throws ApprovalRejected on rejection.
 */
export async function approve(rt: Runtime, run: RunRecord, kind: ApprovalKind, o: { resources: string[]; summary: string; previewPath?: string }): Promise<void> {
  run.status = "awaiting-approval"
  await saveRun(rt.ctx, run)
  await rt.emit("run.awaiting", { runId: run.runId, sessionID: run.originSessionID, kind, summary: o.summary })
  await notify(rt.ctx, run.originSessionID, `fixora ${run.runId}: ${o.summary} — approve the next dialog to continue`, `[fixora] About to ${kind}. ${o.summary}${o.previewPath ? `\nPreview: ${o.previewPath}` : ""}`)
  try {
    await rt.ctx.permission.assert({
      sessionID: run.originSessionID as never,
      action: `fixora.${kind}`,
      resources: o.resources,
      metadata: { runId: run.runId, kind, preview: o.previewPath, summary: o.summary },
    })
  } catch (error) {
    run.status = "rejected"
    run.approvals[kind] = "rejected"
    await saveRun(rt.ctx, run)
    await rt.emit("run.gate.resolved", { runId: run.runId, sessionID: run.originSessionID, kind, decision: "rejected" })
    const detail = error instanceof Error && error.message ? ` (${error.message.slice(0, 200)})` : ""
    throw new ApprovalRejected(kind, `${kind} was not approved${detail}.`)
  }
  run.status = "running"
  run.approvals[kind] = "approved"
  await saveRun(rt.ctx, run)
  await rt.emit("run.gate.resolved", { runId: run.runId, sessionID: run.originSessionID, kind, decision: "approved" })
}
