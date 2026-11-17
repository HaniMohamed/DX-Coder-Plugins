import type { FixoraOptions } from "../options.js"
import type { CrashSummary, Services, Source } from "../types.js"
import { crashlytics } from "./crashlytics.js"
import { manual } from "./manual.js"
import { sentry } from "./sentry.js"
import type { CrashSource, ListQuery, ListResult, SourceContext, ToolCall } from "./types.js"
import { describeError } from "../errors.js"

export const SOURCES: CrashSource[] = [sentry, crashlytics, manual]

export const sourceById = (id: Source): CrashSource => SOURCES.find((s) => s.id === id)!

export interface ResolvedRef {
  source: Source
  id: string
  extra?: Record<string, string>
}

/** `sentry:123`, `crashlytics:abc`, `manual:<file>` or a Sentry / Firebase console URL. */
export function resolveRef(input: string, options: FixoraOptions): ResolvedRef | undefined {
  const text = input.trim()
  for (const s of SOURCES) {
    const r = s.parseRef(text, options)
    if (r) return { source: s.id, id: r.id, extra: r.extra }
  }
  return undefined
}

export function availableSources(services: Services, options: FixoraOptions): CrashSource[] {
  return SOURCES.filter((s) => s.id !== "manual" && s.available(services, options))
}

export interface ListPlan {
  source: Source
  calls: ToolCall[]
}

/** The calls a lister session must make, per available source. Sources whose plan fails (missing app id…) report the error. */
export function listPlans(sc: SourceContext, q: ListQuery & { source?: Source }): { plans: ListPlan[]; errors: string[] } {
  const plans: ListPlan[] = []
  const errors: string[] = []
  for (const s of availableSources(sc.services, sc.options)) {
    if (q.source && s.id !== q.source) continue
    if (!s.listPlan) continue
    // A platform filter selects Firebase apps; sources without a per-platform split have nothing to answer.
    if (q.platform && s.id !== "crashlytics") continue
    try {
      const calls = s.listPlan(sc, q)
      if (calls.length) plans.push({ source: s.id, calls })
    } catch (error) {
      errors.push(`${s.id}: ${describeError(error)}`)
    }
  }
  return { plans, errors }
}

/** Reads what the lister submitted: one raw reply (or error) per planned call. */
export function interpretCrashList(results: Array<ListResult & { source: Source }>, sc: SourceContext, q: ListQuery): { crashes: CrashSummary[]; errors: string[] } {
  const out: CrashSummary[] = []
  const errors: string[] = []
  const multiApp = sc.options.crashlytics.appIds.length > 1
  for (const r of results) {
    const source = SOURCES.find((s) => s.id === r.source)
    if (!source?.mapList) {
      errors.push(`${r.source}: unknown source`)
      continue
    }
    if (r.error) {
      errors.push(`${r.source}${r.appId ? ` (${r.appId})` : ""}: ${r.error}`)
      continue
    }
    try {
      out.push(...source.mapList(r, sc, { multiApp }))
    } catch (error) {
      errors.push(`${r.source}: ${describeError(error)}`)
    }
  }
  const seen = new Set<string>()
  const ranked = out
    .filter((c) => (q.minUsers ?? 0) === 0 || (c.userCount ?? 0) >= (q.minUsers ?? 0))
    .filter((c) => {
      const key = c.ref ?? `${c.source}:${c.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort(byImpact)
  return { crashes: fairShare(ranked, q.top).sort(byImpact), errors }
}

const byImpact = (a: CrashSummary, b: CrashSummary) => (b.userCount ?? 0) - (a.userCount ?? 0) || (b.eventCount ?? 0) - (a.eventCount ?? 0)

/**
 * The `top` rows to keep, taken round-robin from every source / Firebase app (best of each first)
 * so that a platform with fewer users still shows up next to a busier one. One group: plain cut.
 */
export function fairShare(ranked: CrashSummary[], top: number): CrashSummary[] {
  const groups = new Map<string, CrashSummary[]>()
  for (const c of ranked) {
    const key = `${c.source}:${c.appId ?? ""}`
    groups.set(key, [...(groups.get(key) ?? []), c])
  }
  if (groups.size <= 1) return ranked.slice(0, top)
  const queues = [...groups.values()]
  const picked: CrashSummary[] = []
  for (let i = 0; picked.length < top && queues.some((g) => i < g.length); i++) {
    for (const g of queues) if (picked.length < top && i < g.length) picked.push(g[i]!)
  }
  return picked
}

export const runIdFor = (source: Source, id: string) => `${source}-${id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64)}`
