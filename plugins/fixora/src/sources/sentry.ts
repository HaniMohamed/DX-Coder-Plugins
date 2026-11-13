// Sentry through its MCP server (official remote server or compatible). Tool outputs vary between
// server versions (structured JSON vs markdown), so the mapper accepts both.

import { fingerprintOf } from "../fingerprint.js"
import { callTool } from "../mcp.js"
import { sanitizeExtra, sanitizeText, stripControl, symbolicationCheck } from "../normalize.js"
import { parseStackTrace, type Hints } from "../stacktrace/index.js"
import type { Crash, CrashSummary, Frame, Language } from "../types.js"
import { SourceError, type CrashSource, type SourceContext } from "./types.js"

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined)
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined)

function languageOf(platform: string | undefined, frames: Frame[]): Language {
  const p = (platform ?? "").toLowerCase()
  if (/dart|flutter/.test(p)) return "dart"
  if (/javascript|node|react|browser/.test(p)) return "js"
  if (/^java$|kotlin|android/.test(p)) return "jvm"
  if (/cocoa|apple|swift|objc|ios/.test(p)) return "apple"
  if (/python/.test(p)) return "python"
  if (/go/.test(p)) return "go"
  if (/csharp|dotnet/.test(p)) return "dotnet"
  const f = frames.find((x) => x.file)?.file ?? ""
  if (/\.dart$/.test(f)) return "dart"
  if (/\.(kt|java)$/.test(f)) return "jvm"
  if (/\.(swift|m|mm)$/.test(f)) return "apple"
  if (/\.(ts|tsx|js|jsx|mjs)$/.test(f)) return "js"
  if (/\.py$/.test(f)) return "python"
  if (/\.go$/.test(f)) return "go"
  if (/\.cs$/.test(f)) return "dotnet"
  return "unknown"
}

/** Frames from a Sentry event: `exception.values[].stacktrace.frames` (outermost first → reversed). */
function framesFromEvent(event: Record<string, unknown>, hints: Hints): Frame[] {
  const values: unknown[] = []
  const exception = event.exception
  if (isRecord(exception) && Array.isArray(exception.values)) values.push(...exception.values)
  if (Array.isArray(event.entries)) for (const e of event.entries) if (isRecord(e) && e.type === "exception" && isRecord(e.data) && Array.isArray(e.data.values)) values.push(...e.data.values)
  const frames: Frame[] = []
  const last = values[values.length - 1]
  const list = isRecord(last) && isRecord(last.stacktrace) && Array.isArray(last.stacktrace.frames) ? last.stacktrace.frames : []
  for (const f of [...list].reverse()) {
    if (!isRecord(f)) continue
    const file = str(f.filename) ?? str(f.absPath) ?? str(f.abs_path)
    const module = str(f.module)
    const inAppRaw = typeof f.inApp === "boolean" ? f.inApp : typeof f.in_app === "boolean" ? f.in_app : undefined
    const inApp = inAppRaw ?? (hints.appPackage && module ? module.startsWith(hints.appPackage) : !/node_modules|site-packages/.test(file ?? ""))
    frames.push({ raw: `${module ?? ""} ${file ?? ""}:${str(f.lineNo) ?? str(f.lineno) ?? ""} ${str(f.function) ?? ""}`.trim(), file, line: num(f.lineNo) ?? num(f.lineno), column: num(f.colNo) ?? num(f.colno), function: str(f.function), module, package: str(f.package), inApp })
  }
  return frames
}

function exceptionOf(event: Record<string, unknown>): { type?: string; value?: string } {
  const exception = event.exception
  const values = isRecord(exception) && Array.isArray(exception.values) ? exception.values : []
  const last = values[values.length - 1]
  if (isRecord(last)) return { type: str(last.type), value: str(last.value) }
  if (isRecord(event.metadata)) return { type: str(event.metadata.type), value: str(event.metadata.value) }
  return {}
}

/** Pulls a fenced or indented stack trace out of a markdown tool response. */
export function stackFromMarkdown(text: string): string | undefined {
  const fence = /```(?:\w+)?\n([\s\S]*?)```/g
  let best: string | undefined
  for (const m of text.matchAll(fence)) {
    const block = m[1]!
    if (/\bat\s|#\d+\s|File "|goroutine|\.(kt|java|swift|dart|ts|js|py|go|cs):\d+/.test(block) && (!best || block.length > best.length)) best = block
  }
  if (best) return best
  const lines = text.split("\n")
  const start = lines.findIndex((l) => /^\s*(at\s|#\d+\s|File ")/.test(l))
  if (start < 0) return undefined
  let end = start
  while (end < lines.length && lines[end]!.trim()) end++
  return lines.slice(Math.max(0, start - 1), end).join("\n")
}

const field = (text: string, names: string[]): string | undefined => {
  for (const n of names) {
    const m = new RegExp(`\\*{0,2}${n}\\*{0,2}\\s*[:：]\\s*(.+)`, "i").exec(text)
    if (m) return m[1]!.trim().replace(/\*+$/, "").trim()
  }
  return undefined
}

export function mapSentryIssue(raw: unknown, o: { id: string; hints: Hints; organization?: string; now?: string }): Crash {
  const now = o.now ?? new Date().toISOString()
  let title = ""
  let exceptionType: string | undefined
  let message: string | undefined
  let frames: Frame[] = []
  let platform: string | undefined
  let appVersion: string | undefined
  let url: string | undefined
  let eventCount: number | undefined
  let userCount: number | undefined
  let firstSeen: string | undefined
  let lastSeen: string | undefined
  let rawTrace = ""
  let extra: Record<string, unknown> | undefined
  let culprit: string | undefined

  const payload = isRecord(raw) && isRecord(raw.issue) ? { ...raw, ...(raw.issue as Record<string, unknown>) } : raw
  if (isRecord(payload)) {
    title = str(payload.title) ?? ""
    culprit = str(payload.culprit)
    platform = str(payload.platform)
    url = str(payload.permalink) ?? str(payload.url) ?? str(payload.link)
    eventCount = num(payload.count) ?? num(payload.eventCount)
    userCount = num(payload.userCount) ?? num(payload.usersAffected)
    firstSeen = str(payload.firstSeen)
    lastSeen = str(payload.lastSeen)
    const event = [payload.latestEvent, payload.event, payload.lastEvent, payload].find(isRecord) as Record<string, unknown>
    const ex = exceptionOf(event)
    exceptionType = ex.type ?? (isRecord(payload.metadata) ? str(payload.metadata.type) : undefined)
    message = ex.value ?? (isRecord(payload.metadata) ? str(payload.metadata.value) : undefined)
    frames = framesFromEvent(event, o.hints)
    appVersion = str(event.release) ?? (isRecord(event.release) ? str((event.release as Record<string, unknown>).version) : undefined) ?? (isRecord(payload.firstRelease) ? str((payload.firstRelease as Record<string, unknown>).version) : undefined)
    const tags = Array.isArray(event.tags) ? Object.fromEntries(event.tags.filter(isRecord).map((t) => [str(t.key) ?? "", str(t.value) ?? ""])) : isRecord(event.tags) ? event.tags : undefined
    extra = sanitizeExtra({ tags, culprit, level: payload.level, environment: event.environment, breadcrumbs: isRecord(event.breadcrumbs) ? (event.breadcrumbs as Record<string, unknown>).values : undefined })
    if (frames.length === 0) {
      const text = typeof payload.stacktrace === "string" ? payload.stacktrace : typeof payload.text === "string" ? payload.text : typeof payload.content === "string" ? payload.content : undefined
      const block = text ? (stackFromMarkdown(text) ?? text) : undefined
      if (block) {
        rawTrace = block
        const parsed = parseStackTrace(block, o.hints)
        frames = parsed.frames
        exceptionType ??= parsed.exceptionType
        message ??= parsed.message
      }
    }
    if (!rawTrace) rawTrace = frames.map((f) => f.raw).join("\n")
  } else if (typeof raw === "string") {
    const text = stripControl(raw)
    title = field(text, ["Title", "Issue"]) ?? text.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") ?? ""
    culprit = field(text, ["Culprit"])
    platform = field(text, ["Platform"])
    url = field(text, ["URL", "Link", "Permalink"]) ?? /https?:\/\/\S*sentry\S*\/issues\/\d+\/?/.exec(text)?.[0]
    eventCount = num(field(text, ["Events", "Count", "Occurrences"])?.replace(/[^\d]/g, ""))
    userCount = num(field(text, ["Users", "Users affected", "User count"])?.replace(/[^\d]/g, ""))
    firstSeen = field(text, ["First seen", "First Seen"])
    lastSeen = field(text, ["Last seen", "Last Seen"])
    appVersion = field(text, ["Release", "First release"])
    const block = stackFromMarkdown(text)
    if (block) {
      rawTrace = block
      const parsed = parseStackTrace(block, o.hints)
      frames = parsed.frames
      exceptionType = parsed.exceptionType
      message = parsed.message
    }
    const t = /^\s*\*{0,2}(?:Error|Exception|Type)\*{0,2}\s*[:：]\s*(.+)$/im.exec(text)?.[1]
    if (t && !exceptionType) exceptionType = t.trim()
  }
  if (!title) title = [exceptionType, message].filter(Boolean).join(": ") || `Sentry issue ${o.id}`
  const language = languageOf(platform, frames)
  const fp = fingerprintOf({ exceptionType, message, frames, platform })
  return {
    id: o.id,
    source: "sentry",
    title: sanitizeText(title, 200),
    exceptionType,
    message: message ? sanitizeText(message) : undefined,
    frames,
    language,
    platform,
    appVersion,
    firstSeen,
    lastSeen,
    eventCount,
    userCount,
    url,
    rawStackTrace: sanitizeText(rawTrace, 64 * 1024),
    fingerprint: fp.hash,
    symbolication: symbolicationCheck(language, frames),
    fetchedAt: now,
    extra: culprit && !extra ? { culprit } : extra,
  }
}

export function mapSentryList(raw: unknown): CrashSummary[] {
  const items: unknown[] = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.issues) ? raw.issues : isRecord(raw) && Array.isArray(raw.data) ? raw.data : isRecord(raw) && Array.isArray(raw.results) ? raw.results : []
  const out: CrashSummary[] = []
  for (const it of items) {
    if (!isRecord(it)) continue
    const id = str(it.id) ?? str(it.shortId) ?? str(it.issueId)
    if (!id) continue
    out.push({ source: "sentry", id, title: str(it.title) ?? str(it.culprit) ?? id, userCount: num(it.userCount), eventCount: num(it.count), lastSeen: str(it.lastSeen), appVersion: isRecord(it.lastRelease) ? str(it.lastRelease.version) : undefined, url: str(it.permalink) })
  }
  if (out.length === 0 && typeof raw === "string") {
    // Markdown table / list fallback: lines with an issue id and a title.
    for (const m of raw.matchAll(/^\s*(?:[-*]|\|)?\s*\**(?:ID|Issue)?\**:?\s*`?([A-Z0-9-]{4,}|\d{5,})`?\s*[|:—-]\s*(.+?)\s*(?:\|.*)?$/gim)) out.push({ source: "sentry", id: m[1]!, title: m[2]!.trim() })
  }
  return out
}

const hintsOf = (sc: SourceContext): Hints => ({ appPackage: sc.options.appPackage, inAppPrefixes: sc.options.inAppPackages })

function withOrg(sc: SourceContext, input: Record<string, unknown>): Record<string, unknown> {
  const org = sc.options.sentry.organization
  const project = sc.options.sentry.project
  return { ...(org ? { organizationSlug: org } : {}), ...(project ? { projectSlugOrId: project } : {}), ...input }
}

export const sentry: CrashSource = {
  id: "sentry",
  available: (services, options) => options.sources.includes("sentry") && !!services.sentry && services.sentry.status === "connected" && !!services.sentry.capabilities.getIssue,
  parseRef: (input) => {
    const m = /^sentry:([A-Za-z0-9_-]+)$/i.exec(input)
    if (m) return { id: m[1]! }
    const url = /^https?:\/\/([^/]+)\/(?:organizations\/([^/]+)\/)?issues\/(\d+)/i.exec(input)
    if (url && /sentry/i.test(input)) return { id: url[3]!, extra: { org: url[2] ?? url[1]!.split(".")[0]! } }
    return undefined
  },
  async list(sc, q) {
    const s = sc.services.sentry!
    const tool = s.capabilities.searchIssues
    if (!tool) return []
    const raw = await callTool(sc.ctx, tool, withOrg(sc, { naturalLanguageQuery: `unresolved errors with the most affected users in the last 14 days, top ${q.top}`, query: "is:unresolved level:error", sortBy: "users", limit: q.top }), { sessionID: sc.sessionID, signal: sc.signal })
    return mapSentryList(raw).filter((c) => (q.minUsers ?? 0) === 0 || (c.userCount ?? 0) >= (q.minUsers ?? 0)).slice(0, q.top)
  },
  async get(sc, id, extra) {
    const s = sc.services.sentry!
    const tool = s.capabilities.getIssue
    if (!tool) throw new SourceError("sentry", "the Sentry MCP server exposes no get_issue_details tool")
    const input = withOrg(sc, { issueId: id })
    if (extra?.org) input.organizationSlug = extra.org
    const raw = await callTool(sc.ctx, tool, input, { sessionID: sc.sessionID, signal: sc.signal })
    const crash = mapSentryIssue(raw, { id, hints: hintsOf(sc), organization: sc.options.sentry.organization })
    if (crash.frames.length === 0 && s.capabilities.searchErrors) {
      // Some server versions return only the issue summary; fetch a sample error event for the trace.
      try {
        const events = await callTool(sc.ctx, s.capabilities.searchErrors, withOrg(sc, { naturalLanguageQuery: `latest error event for issue ${id} with full stack trace`, query: `issue:${id}`, limit: 1 }), { sessionID: sc.sessionID, signal: sc.signal })
        const sample = mapSentryIssue(events, { id, hints: hintsOf(sc) })
        if (sample.frames.length > 0) return { ...crash, frames: sample.frames, rawStackTrace: sample.rawStackTrace, language: sample.language, fingerprint: sample.fingerprint, symbolication: sample.symbolication, exceptionType: crash.exceptionType ?? sample.exceptionType, message: crash.message ?? sample.message }
      } catch {
        // keep the summary-only crash; triage will classify it
      }
    }
    return crash
  },
  async annotate(sc, id, note) {
    const s = sc.services.sentry!
    const tool = s.capabilities.updateIssue
    if (!tool) return
    await callTool(sc.ctx, tool, withOrg(sc, { issueId: id, status: "unresolved", note: note.text }), { sessionID: sc.sessionID, signal: sc.signal })
  },
}
