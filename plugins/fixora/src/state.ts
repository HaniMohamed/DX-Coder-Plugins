// Run records, crash index and locks in plugin storage; step bookkeeping; funnel aggregation (pure).

import type { Plugin } from "@opencode/plugin"
import { STEPS, type CrashIndexEntry, type RunRecord, type Step, type StepTiming, type WorkerInfo } from "./types.js"

export const keys = {
  run: (runId: string) => `fixora/run/${runId}`,
  worker: (sessionID: string) => `fixora/worker/${sessionID}`,
  crash: (fingerprint: string) => `fixora/crash/${fingerprint}`,
  lockCrash: (runId: string) => `fixora/lock/crash/${runId}`,
  lockRepo: (projectId: string) => `fixora/lock/repo/${encodeURIComponent(projectId)}`,
  batch: (batchId: string) => `fixora/batch/${batchId}`,
}

type StorageValue = Parameters<Plugin.Context["storage"]["set"]>[1]
export const setJson = (ctx: Plugin.Context, key: string, value: object) => ctx.storage.set(key, value as unknown as StorageValue)
export const getJson = async <T>(ctx: Plugin.Context, key: string) => (await ctx.storage.get(key)) as T | undefined

export const now = () => new Date().toISOString()

export const TERMINAL: ReadonlySet<RunRecord["status"]> = new Set(["done", "skipped", "cancelled", "rejected"])

export function nextStep(step: Step): Step | undefined {
  const i = STEPS.indexOf(step)
  return i >= 0 && i < STEPS.length - 1 ? STEPS[i + 1] : undefined
}

export const stepIndex = (step: Step) => STEPS.indexOf(step)

/** Where a retry re-enters: an explicit `--from`, else the recorded step (the one that did not finish). */
export function resumePoint(run: RunRecord, from?: Step): Step {
  if (from) return from
  if (run.status === "done") return "done"
  const t = run.timings[run.step]
  if (t?.status === "ok") return nextStep(run.step) ?? "done"
  return run.step
}

export function beginStep(run: RunRecord, step: Step, at = now()): RunRecord {
  const prev = run.timings[step]
  const timing: StepTiming = { startedAt: at, attempts: (prev?.attempts ?? 0) + 1, status: "running" }
  run.timings[step] = timing
  run.step = step
  run.status = "running"
  run.error = undefined
  run.updatedAt = at
  return run
}

export function endStep(run: RunRecord, step: Step, status: StepTiming["status"], at = now(), error?: string): RunRecord {
  const t = run.timings[step] ?? { startedAt: at, attempts: 1, status: "running" }
  t.endedAt = at
  t.durationMs = Math.max(0, Date.parse(at) - Date.parse(t.startedAt))
  t.status = status
  run.timings[step] = t
  run.updatedAt = at
  if (error) run.error = error
  if (status === "ok") run.totalMs = Object.values(run.timings).reduce((s, x) => s + (x?.durationMs ?? 0), 0)
  return run
}

export const loadRun = (ctx: Plugin.Context, runId: string) => getJson<RunRecord>(ctx, keys.run(runId))
export const saveRun = async (ctx: Plugin.Context, run: RunRecord) => {
  run.updatedAt = now()
  await setJson(ctx, keys.run(run.runId), run)
}

export async function scanAll<T>(ctx: Plugin.Context, prefix: string): Promise<T[]> {
  const out: T[] = []
  let after: string | undefined
  for (let i = 0; i < 200; i++) {
    const res = await ctx.storage.scan({ prefix, limit: 200, after })
    for (const e of res.entries) if (e.value && typeof e.value === "object") out.push(e.value as unknown as T)
    if (!res.next) break
    after = res.next
  }
  return out
}

export async function listRuns(ctx: Plugin.Context): Promise<RunRecord[]> {
  const out = await scanAll<RunRecord>(ctx, "fixora/run/")
  return out.filter((r) => r && typeof r.runId === "string").sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export const listCrashIndex = (ctx: Plugin.Context) => scanAll<CrashIndexEntry>(ctx, "fixora/crash/")

export const loadCrashIndex = (ctx: Plugin.Context, fingerprint: string) => getJson<CrashIndexEntry>(ctx, keys.crash(fingerprint))
export const saveCrashIndex = (ctx: Plugin.Context, entry: CrashIndexEntry) => setJson(ctx, keys.crash(entry.fingerprint), entry)

export const loadWorker = (ctx: Plugin.Context, sessionID: string) => getJson<WorkerInfo>(ctx, keys.worker(sessionID))
export const saveWorker = (ctx: Plugin.Context, sessionID: string, info: WorkerInfo) => setJson(ctx, keys.worker(sessionID), info)

export interface Lock {
  owner: string
  acquiredAt: string
  expiresAt: string
}

export const LOCK_TTL_MS = 60 * 60 * 1000

export async function acquireLock(ctx: Plugin.Context, key: string, owner: string, ttlMs = LOCK_TTL_MS): Promise<{ ok: true } | { ok: false; lock: Lock; stale: boolean }> {
  const existing = await getJson<Lock>(ctx, key)
  const at = now()
  if (existing && existing.owner !== owner && existing.expiresAt > at) return { ok: false, lock: existing, stale: false }
  const stale = !!existing && existing.owner !== owner
  await setJson(ctx, key, { owner, acquiredAt: at, expiresAt: new Date(Date.now() + ttlMs).toISOString() } satisfies Lock)
  return stale ? { ok: false, lock: existing!, stale: true } : { ok: true }
}

export const releaseLock = (ctx: Plugin.Context, key: string) => ctx.storage.remove(key)

// ---------- funnel (pure) ----------

export interface FunnelStats {
  days: number
  total: number
  byStatus: Record<string, number>
  funnel: Array<{ stage: string; count: number; rate: number }>
  daily: Array<{ date: string; created: number; completed: number; failed: number }>
  timing: { avgMs?: number; p90Ms?: number; minMs?: number; samples: number }
  mrs: { opened: number; merged: number; closed: number; pending: number }
  releases: { fixed: number; reopened: number; reopenRate: number }
  top: { platforms: Array<[string, number]>; versions: Array<[string, number]>; sources: Array<[string, number]> }
  recent: Array<{ runId: string; title: string; status: string; step: string; jiraKey?: string; mrUrl?: string; updatedAt: string }>
}

export function funnel(runs: RunRecord[], crashes: CrashIndexEntry[], o: { days: number; now?: string }): FunnelStats {
  const end = o.now ? Date.parse(o.now) : Date.now()
  const start = end - o.days * 86_400_000
  const inWindow = runs.filter((r) => Date.parse(r.createdAt) >= start)
  const total = inWindow.length
  const count = (pred: (r: RunRecord) => boolean) => inWindow.filter(pred).length
  const stage = (name: string, c: number) => ({ stage: name, count: c, rate: total === 0 ? 0 : Math.round((c / total) * 100) / 100 })
  const byStatus: Record<string, number> = {}
  for (const r of inWindow) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
  const daily: FunnelStats["daily"] = []
  for (let i = o.days - 1; i >= 0; i--) {
    const day = new Date(end - i * 86_400_000).toISOString().slice(0, 10)
    daily.push({
      date: day,
      created: count((r) => r.createdAt.startsWith(day)),
      completed: count((r) => r.status === "done" && r.updatedAt.startsWith(day)),
      failed: count((r) => (r.status === "failed" || r.status === "timeout" || r.status === "review-exhausted" || r.status === "blocked") && r.updatedAt.startsWith(day)),
    })
  }
  const durations = inWindow.filter((r) => r.status === "done" && r.totalMs).map((r) => r.totalMs!).sort((a, b) => a - b)
  const timing = {
    samples: durations.length,
    avgMs: durations.length ? Math.round(durations.reduce((s, x) => s + x, 0) / durations.length) : undefined,
    p90Ms: durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.9))] : undefined,
    minMs: durations[0],
  }
  const mrs = { opened: count((r) => !!r.mrUrl), merged: count((r) => r.mrStatus === "merged"), closed: count((r) => r.mrStatus === "closed"), pending: count((r) => !!r.mrUrl && (r.mrStatus === "draft" || r.mrStatus === "open" || !r.mrStatus)) }
  const fixed = crashes.filter((c) => c.fixedIn).length
  const reopened = crashes.filter((c) => c.reopened.count > 0).length
  const tally = (pick: (r: RunRecord) => string | undefined) => {
    const m = new Map<string, number>()
    for (const r of inWindow) {
      const k = pick(r)
      if (k) m.set(k, (m.get(k) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  }
  return {
    days: o.days,
    total,
    byStatus,
    funnel: [
      stage("detected", total),
      stage("analysed", count((r) => r.pipeline.analysed)),
      stage("ticketed", count((r) => r.pipeline.ticketed)),
      stage("fix generated", count((r) => r.pipeline.fixed)),
      stage("validated", count((r) => r.pipeline.validated)),
      stage("review passed", count((r) => r.pipeline.reviewed)),
      stage("committed", count((r) => r.pipeline.committed)),
      stage("pushed", count((r) => r.pipeline.pushed)),
      stage("MR opened", count((r) => r.pipeline.mrOpened)),
      stage("MR merged", count((r) => r.mrStatus === "merged")),
    ],
    daily,
    timing,
    mrs,
    releases: { fixed, reopened, reopenRate: fixed === 0 ? 0 : Math.round((reopened / fixed) * 100) / 100 },
    top: { platforms: tally((r) => (typeof r.meta?.platform === "string" ? r.meta.platform : undefined)), versions: tally((r) => (typeof r.meta?.appVersion === "string" ? r.meta.appVersion : undefined)), sources: tally((r) => r.source) },
    recent: [...inWindow]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, 10)
      .map((r) => ({ runId: r.runId, title: r.title, status: r.status, step: r.step, jiraKey: r.jiraKey, mrUrl: r.mrUrl, updatedAt: r.updatedAt })),
  }
}
