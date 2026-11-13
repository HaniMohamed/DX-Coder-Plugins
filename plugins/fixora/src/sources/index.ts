import type { FixoraOptions } from "../options.js"
import type { CrashSummary, Services, Source } from "../types.js"
import { crashlytics } from "./crashlytics.js"
import { manual } from "./manual.js"
import { sentry } from "./sentry.js"
import type { CrashSource, ListQuery, SourceContext } from "./types.js"

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

export async function listTopCrashes(sc: SourceContext, q: ListQuery & { source?: Source }): Promise<{ crashes: CrashSummary[]; errors: string[] }> {
  const out: CrashSummary[] = []
  const errors: string[] = []
  for (const s of availableSources(sc.services, sc.options)) {
    if (q.source && s.id !== q.source) continue
    if (!s.list) continue
    try {
      out.push(...(await s.list(sc, q)))
    } catch (error) {
      errors.push(`${s.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  out.sort((a, b) => (b.userCount ?? 0) - (a.userCount ?? 0) || (b.eventCount ?? 0) - (a.eventCount ?? 0))
  return { crashes: out, errors }
}

export const runIdFor = (source: Source, id: string) => `${source}-${id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64)}`
