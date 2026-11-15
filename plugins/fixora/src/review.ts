// Independent review: a fresh reviewer session (read-only) in the same checkout.

import { reviewPrompt, nudgePrompt, SKILLS } from "./prompts.js"
import { progress, type Runtime } from "./progress.js"
import { saveRun } from "./state.js"
import type { ReviewVerdict, RunRecord } from "./types.js"
import { awaitSubmission, ensureWorker } from "./worker.js"

export const latestFixAttempt = (run: RunRecord) => run.counters.fixRounds + run.counters.reviewRounds + run.counters.feedback + 1

export async function runReview(rt: Runtime, run: RunRecord, o: { signal?: AbortSignal }): Promise<ReviewVerdict | undefined> {
  const attempt = run.reviews.length + 1
  await progress(rt, run, `review session round ${attempt}`)
  const sessionID = await ensureWorker(rt, run, "reviewer", { phase: "review" })
  const prompt = reviewPrompt(run, { attempt, fixAttempt: latestFixAttempt(run), checks: run.toolchain?.checks ?? [] })
  const r = await awaitSubmission(rt, run, sessionID, prompt, {
    minutes: rt.opts.worker.maxPhaseMinutes.review,
    signal: o.signal,
    pick: (fresh) => fresh.reviews[attempt - 1],
    nudge: nudgePrompt("fixora_submit_review", run.runId, SKILLS.review, `runId "${run.runId}", attempt ${attempt}`),
  })
  if (r.value) {
    run.reviews = r.fresh.reviews
    await saveRun(rt.ctx, run)
  }
  return r.value
}
