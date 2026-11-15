// Crash index bookkeeping shared by the pipeline (pasted traces) and the submit_crash tool (fetched
// crashes): duplicate detection by fingerprint and reopen detection after a release was marked fixed.

import type { Plugin } from "@opencode/plugin"
import { detectReopen } from "./fingerprint.js"
import { loadCrashIndex, loadRun, saveCrashIndex } from "./state.js"
import type { Crash, CrashIndexEntry, RunRecord } from "./types.js"

export interface IndexOutcome {
  /** Another run with the same fingerprint is in progress or already has a merge request. */
  duplicateOf?: { runId: string; status: string; mrUrl?: string }
  reopened?: RunRecord["reopened"]
}

export async function indexCrash(ctx: Plugin.Context, run: RunRecord, crash: Crash): Promise<IndexOutcome> {
  const index: CrashIndexEntry = (await loadCrashIndex(ctx, crash.fingerprint)) ?? { fingerprint: crash.fingerprint, runIds: [], reopened: { count: 0 } }
  const out: IndexOutcome = {}
  if (!run.flags.force) {
    for (const id of index.runIds.filter((x) => x !== run.runId)) {
      const other = await loadRun(ctx, id)
      if (other && (other.mrUrl || other.status === "running" || other.status === "awaiting-approval")) {
        out.duplicateOf = { runId: id, status: other.status, mrUrl: other.mrUrl }
        break
      }
    }
  }
  const at = new Date().toISOString()
  const reopen = detectReopen(index, crash, at)
  if (reopen.reopened) {
    index.reopened = { count: index.reopened.count + 1, lastAt: at, reason: reopen.reason }
    run.reopened = { count: index.reopened.count, previousRunId: index.fixedIn?.runId, fixedIn: index.fixedIn?.release, reason: reopen.reason }
    out.reopened = run.reopened
  }
  if (!index.runIds.includes(run.runId)) index.runIds.push(run.runId)
  index.title = crash.title
  index.lastSeen = crash.lastSeen ?? index.lastSeen
  await saveCrashIndex(ctx, index)
  return out
}

export const duplicateMessage = (d: NonNullable<IndexOutcome["duplicateOf"]>) =>
  `This crash has the same fingerprint as run \`${d.runId}\` (${d.status}${d.mrUrl ? `, MR ${d.mrUrl}` : ""}). Use \`/fixora feedback ${d.runId} "…"\` or \`/fixora restart ${d.runId}\`, or re-run with --force to fix it separately.`
