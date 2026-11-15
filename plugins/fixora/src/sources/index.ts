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
  const crashes = out
    .filter((c) => (q.minUsers ?? 0) === 0 || (c.userCount ?? 0) >= (q.minUsers ?? 0))
    .filter((c) => {
      const key = c.ref ?? `${c.source}:${c.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => (b.userCount ?? 0) - (a.userCount ?? 0) || (b.eventCount ?? 0) - (a.eventCount ?? 0))
    .slice(0, q.top)
  return { crashes, errors }
}

export const runIdFor = (source: Source, id: string) => `${source}-${id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64)}`
