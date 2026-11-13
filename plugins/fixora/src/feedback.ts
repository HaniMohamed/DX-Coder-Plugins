// Fix copilot: a user message about an existing fix. The fixer session answers (question) or applies
// the change (change request); the pipeline then re-validates, re-reviews, commits, pushes and
// updates the MR.

import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { git } from "./git.js"
import { fixerRules } from "./permissions.js"
import { FixoraStop, notify, present, progress, type Runtime } from "./progress.js"
import { waitWithTimeout } from "./review.js"
import { loadRun, saveRun, saveWorker } from "./state.js"
import type { RunRecord } from "./types.js"

export const FIX_SKILL = "fixora-fix"

export const FixoraFeedback = {
  async apply(rt: Runtime, run: RunRecord, message: string, signal: AbortSignal): Promise<void> {
    const worktree = run.worktree!
    let sessionID = run.sessions.fixer
    if (sessionID) {
      const alive = await rt.ctx.session.get({ sessionID: sessionID as never }).then(() => true, () => false)
      if (!alive) sessionID = undefined
    }
    if (!sessionID) {
      const s = rt.services
      const permissions = fixerRules({ sourceNamespaces: [s.sentry?.namespace, s.crashlytics?.namespace].filter((x): x is string => !!x), jiraNamespace: s.jira?.namespace, forgeNamespaces: [s.gitlab?.namespace, s.github?.namespace].filter((x): x is string => !!x), shell: rt.opts.worker.shell })
      const session = await rt.ctx.session.create({ parentID: run.originSessionID as never, title: `fixora: ${run.runId}`, agent: rt.opts.worker.agent, model: rt.opts.worker.model, location: { directory: worktree }, permissions } as never)
      sessionID = (session as { id: string }).id
      run.sessions.fixer = sessionID
    }
    await saveWorker(rt.ctx, sessionID, { runId: run.runId, role: "fixer", worktree, phase: "feedback" })
    const attempt = run.counters.fixRounds + run.counters.reviewRounds + run.counters.feedback + 1
    const before = (await git.statusPorcelain(worktree)).length
    run.step = "fix"
    run.status = "running"
    await saveRun(rt.ctx, run)
    await progress(rt, run, `feedback ${run.counters.feedback}: worker session ${sessionID}`)
    const text = [
      `Fixora run ${run.runId} — feedback from the user on the fix on branch ${run.branch} (worktree ${worktree}):`,
      "",
      `"""${message}"""`,
      "",
      `This message comes from the user and is trusted. Decide: if it is a question, answer it in your final message and call fixora_submit_fix with changesMade=false (runId "${run.runId}", attempt ${attempt}). If it asks for a change, apply it following the fixora-fix skill (minimal diff, keep tests green, run the checks), then call fixora_submit_fix with changesMade=true and attempt ${attempt}. Never undo fixes that a review required unless the user explicitly asks.`,
    ].join("\n")
    await rt.ctx.session.prompt({ sessionID: sessionID as never, text, files: [{ uri: pathToFileURL(join(run.folder, "feedback.md")).href, name: "feedback.md" }], skills: [{ id: FIX_SKILL }] } as never)
    const outcome = await waitWithTimeout(rt, sessionID, rt.opts.worker.maxPhaseMinutes.fix * 60_000, signal)
    const fresh = await loadRun(rt.ctx, run.runId)
    const fix = fresh?.fix && fresh.fix.attempt === attempt ? fresh.fix : undefined
    const changedNow = (await git.statusPorcelain(worktree)).length
    if (!fix) {
      if (outcome === "timeout") throw new FixoraStop(`The feedback round exceeded ${rt.opts.worker.maxPhaseMinutes.fix} minutes.`)
      if (changedNow === before) {
        // Treated as an answer: show the worker's last message to the user.
        const answer = await lastAssistantText(rt, sessionID)
        run.status = "done"
        await saveRun(rt.ctx, run)
        await present(rt.ctx, run.originSessionID, `fixora ${run.runId}: answer`, answer || "The worker finished without changes and without a report.")
        return
      }
      throw new FixoraStop(`The worker changed files but did not call fixora_submit_fix. \`/fixora retry ${run.runId} --from validate\` after checking the worker session.`)
    }
    run.fix = fix
    run.counters.workerPrompts = fresh!.counters.workerPrompts
    if (!fix.changesMade) {
      const answer = await lastAssistantText(rt, sessionID)
      run.status = "done"
      await saveRun(rt.ctx, run)
      await present(rt.ctx, run.originSessionID, `fixora ${run.runId}: answer`, answer || fix.rationale)
      await notify(rt.ctx, run.originSessionID, `fixora ${run.runId}: no code change requested`)
      return
    }
    run.pipeline.fixed = true
    run.pipeline.validated = false
    run.pipeline.reviewed = false
    run.tests = undefined
    await saveRun(rt.ctx, run)
  },
}

async function lastAssistantText(rt: Runtime, sessionID: string): Promise<string> {
  try {
    const messages = (await rt.ctx.session.context({ sessionID: sessionID as never })) as unknown as Array<{ role?: string; parts?: Array<{ type?: string; text?: string }>; content?: unknown }>
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!
      if (m.role !== "assistant") continue
      const text = (m.parts ?? []).filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n")
      if (text.trim()) return text.trim()
    }
  } catch {
    // context API unavailable
  }
  return ""
}
