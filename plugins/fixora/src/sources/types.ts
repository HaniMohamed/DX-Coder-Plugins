import type { Plugin } from "@opencode/plugin"
import type { FixoraOptions } from "../options.js"
import type { Crash, CrashSummary, Services, Source } from "../types.js"

export interface SourceContext {
  ctx: Plugin.Context
  services: Services
  options: FixoraOptions
  /** Origin session used for permission evaluation of direct MCP calls. */
  sessionID: string
  signal?: AbortSignal
}

export interface ListQuery {
  top: number
  minUsers?: number
}

export interface CrashSource {
  id: Source
  available(services: Services, options: FixoraOptions): boolean
  /** Parses `source:id`, a console URL, or returns undefined. */
  parseRef(input: string, options: FixoraOptions): { id: string; extra?: Record<string, string> } | undefined
  list?(sc: SourceContext, q: ListQuery): Promise<CrashSummary[]>
  get(sc: SourceContext, id: string, extra?: Record<string, string>): Promise<Crash>
  /** Posts a note / link back to the source (optional). */
  annotate?(sc: SourceContext, id: string, note: { text: string; mrUrl?: string; jiraKey?: string }): Promise<void>
}

export class SourceError extends Error {
  constructor(
    readonly source: Source,
    message: string,
  ) {
    super(message)
    this.name = "SourceError"
  }
}
