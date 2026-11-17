// Crash sources describe WHICH MCP tool calls fetch a crash (plans) and HOW to read the raw replies
// (mappers). The calls themselves are made by the worker session, never by plugin code.

import type { FixoraOptions } from "../options.js"
import type { Crash, CrashSummary, Services, Source } from "../types.js"

/** One MCP tool call the worker must make verbatim. Placeholders like `<issue.sampleEvent>` are explained in `note`. */
export interface ToolCall {
  toolId: string
  /** MCP server namespace (prefix of the tool id); the CodeMode path is `tools.<namespace>.<rest>`. */
  namespace?: string
  input: Record<string, unknown>
  /** Short label for prompts and progress ("android", "ios"). */
  label?: string
  /** Firebase app the call targets (Crashlytics). */
  appId?: string
  /** How to fill placeholders / when to make the call. */
  note?: string
}

export interface SourceContext {
  options: FixoraOptions
  services: Services
  /** Declared input properties of a tool (from the host's tool list), empty when unknown. */
  toolProps: (toolId: string) => Record<string, unknown>
}

export interface ListQuery {
  top: number
  minUsers?: number
  /** Only the Firebase app(s) of this platform ("android", "ios", "web"); sources without a per-platform split are skipped. */
  platform?: string
}

/** What the lister session submits for one planned call. */
export interface ListResult {
  toolId: string
  appId?: string
  raw?: unknown
  error?: string
}

/** What the fixer session submits after fetching one crash. */
export interface CrashSubmission {
  appId?: string
  issue?: unknown
  events?: unknown
  extraCalls?: Array<{ toolId: string; raw: unknown }>
}

export interface FetchPlan {
  /** Calls to make first, in order; for several Firebase apps the first one that knows the issue wins. */
  primary: ToolCall[]
  /** Calls to make after the primary reply, only when it carries no stack frames. */
  followUps: ToolCall[]
  /** Free text the prompt relays to the agent (placeholders, stop conditions). */
  note?: string
}

export interface CrashSource {
  id: Source
  available(services: Services, options: FixoraOptions): boolean
  /** Parses `source:id`, a console URL, or returns undefined. */
  parseRef(input: string, options: FixoraOptions): { id: string; extra?: Record<string, string> } | undefined
  /** The calls a lister session makes to list the top crashes. */
  listPlan?(sc: SourceContext, q: ListQuery): ToolCall[]
  /** Reads one list reply. */
  mapList?(result: ListResult, sc: SourceContext, o: { multiApp: boolean }): CrashSummary[]
  /** The calls a fixer session makes to fetch one crash. */
  fetchPlan?(sc: SourceContext, id: string, extra?: Record<string, string>): FetchPlan
  /** Reads what the fixer submitted. Throws SourceError when nothing usable came back. */
  mapCrash?(submission: CrashSubmission, sc: SourceContext, id: string, extra?: Record<string, string>): Crash
  /** The call that posts a note / link back to the source (optional). */
  annotatePlan?(sc: SourceContext, id: string, note: { text: string; mrUrl?: string; jiraKey?: string }, extra?: Record<string, string>): ToolCall | undefined
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
