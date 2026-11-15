// Firebase Crashlytics through the Firebase MCP server (`npx firebase-tools mcp --only crashlytics`).
// Tools: crashlytics_get_issue, crashlytics_batch_get_events / crashlytics_list_events (sample events
// with stack frames), crashlytics_get_report (topIssues), crashlytics_create_note.
//
// firebase-tools ≥ 15 takes camelCase inputs (`appId`, `issueId`, `filter`, `pageSize`, `names`) and
// answers with YAML text whose nested documents are YAML strings again; `exceptions` / `threads` /
// `errors` of an event are pre-formatted text ("Type: message" + "at symbol (file:line)" lines).
// Older releases took snake_case inputs and answered with JSON. Both are handled: the input spelling
// is read from the tool's schema and the output goes through `parseToolText`.

import { fingerprintOf } from "../fingerprint.js"
import { callTool, paramStyle, parseToolText } from "../mcp.js"
import { sanitizeExtra, sanitizeText, stripControl, symbolicationCheck } from "../normalize.js"
import { parseStackTrace, type Hints } from "../stacktrace/index.js"
import type { Crash, CrashSummary, Frame, Language } from "../types.js"
import { stackFromMarkdown } from "./sentry.js"
import { SourceError, type CrashSource, type SourceContext } from "./types.js"
import { describeError } from "../errors.js"

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined)
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined)
/** "3.1.9", or a Crashlytics version object { displayVersion, buildVersion }. */
const version = (v: unknown) => str(v) ?? (isRecord(v) ? str(v.displayVersion) : undefined)
const build = (v: unknown) => (isRecord(v) ? str(v.buildVersion) : undefined)

export function platformOfAppId(appId: string | undefined): string | undefined {
  const m = /^\d+:\d+:(android|ios|web|macos|windows|linux):/.exec(appId ?? "")
  return m?.[1]
}

function languageOf(platform: string | undefined, frames: Frame[], subtitle?: string): Language {
  // Frames first (the in-app one if any), then the issue subtitle ("checkout_page.dart - build").
  const f = (frames.find((x) => x.inApp && x.file) ?? frames.find((x) => x.file))?.file ?? subtitle ?? ""
  if (/\.dart(\b|$)/.test(f)) return "dart"
  if (/\.(kt|java)(\b|$)/.test(f)) return "jvm"
  if (/\.(swift|m|mm)(\b|$)/.test(f)) return "apple"
  if (/\.(ts|tsx|js|jsx)(\b|$)/.test(f)) return "js"
  if (platform === "android") return "jvm"
  if (platform === "ios" || platform === "macos") return "apple"
  if (platform === "web") return "js"
  return "unknown"
}

const FRAMEWORK = /^(java\.|javax\.|kotlin\.|kotlinx\.|android\.|androidx\.|com\.google\.|dalvik\.|io\.flutter\.|UIKit|Foundation|CoreFoundation|libdispatch|libsystem|libswift|libobjc|SwiftUI|dart:|package:flutter\/)/

function frameFrom(raw: Record<string, unknown>, hints: Hints, platform?: string): Frame {
  const file = str(raw.file) ?? str(raw.fileName) ?? str(raw.filename)
  const symbol = str(raw.symbol) ?? str(raw.function) ?? str(raw.method)
  const library = str(raw.library) ?? str(raw.module) ?? str(raw.package)
  const line = num(raw.line) ?? num(raw.lineNumber)
  const owner = library ?? symbol?.split("(")[0]
  let inApp: boolean
  if (typeof raw.inApp === "boolean") inApp = raw.inApp
  else if ((hints.appPackage || hints.inAppPrefixes?.length) && owner) {
    const prefixes = [hints.appPackage, ...(hints.inAppPrefixes ?? [])].filter((p): p is string => !!p)
    inApp = prefixes.some((p) => owner.startsWith(p) || (file?.startsWith(`package:${p}/`) ?? false))
  }
  else inApp = !FRAMEWORK.test(owner ?? "") && !FRAMEWORK.test(file ?? "") && !!(file || symbol)
  const isDartPkg = file?.startsWith("package:")
  const pkg = isDartPkg ? /^package:([^/]+)\//.exec(file!)?.[1] : undefined
  const cleanFile = isDartPkg ? file!.replace(/^package:[^/]+\//, "") : file
  void platform
  return { raw: `${symbol ?? ""} (${file ?? library ?? "?"}:${line ?? "?"})`.trim(), file: cleanFile, package: pkg, line, function: symbol, module: library, inApp }
}

const FRAME_LINE = /^at(?:\s+(.*?))?\s*(?:\(([^\s()]+?)(?::(\d+))?\))?\s*$/

/**
 * Parses the text firebase-tools 15 produces for an event's `exceptions` / `errors` / `threads`:
 * blocks separated by blank lines, each a header line ("Type: message", "Caused by: Type: message",
 * "Error: title", "Thread: name (crashed)") followed by "at symbol (file:line)" lines.
 */
export function parseFormattedFrames(text: string): { blocks: Array<{ header: string; type?: string; message?: string; crashed: boolean; frames: Array<{ symbol?: string; file?: string; line?: number }> }> } {
  const blocks: ReturnType<typeof parseFormattedFrames>["blocks"] = []
  for (const chunk of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) continue
    const header = lines[0]!.startsWith("at ") ? "" : lines[0]!
    const frames: Array<{ symbol?: string; file?: string; line?: number }> = []
    for (const line of header ? lines.slice(1) : lines) {
      if (/^\.\.\. frames omitted/.test(line)) continue
      const m = FRAME_LINE.exec(line)
      if (!m) continue
      // "(int)" after a symbol is a parameter list, not a file: files carry a dot, slash or colon or a line number.
      const isFile = !!m[2] && (!!m[3] || /[./:]/.test(m[2]))
      frames.push(isFile ? { symbol: m[1]?.trim() || undefined, file: m[2], line: m[3] ? Number(m[3]) : undefined } : { symbol: line.replace(/^at\s*/, "").trim() || undefined })
    }
    const h = header.replace(/^Caused by:\s*/, "")
    const thread = /^Thread:/.test(h)
    const err = /^Error:\s*/.test(h)
    const colon = thread || err ? -1 : h.indexOf(": ")
    blocks.push({
      header,
      type: thread ? undefined : err ? h.replace(/^Error:\s*/, "") : colon > 0 ? h.slice(0, colon).trim() : h || undefined,
      message: thread || err ? undefined : colon > 0 ? h.slice(colon + 2).trim() : undefined,
      crashed: /\(crashed\)/.test(header),
      frames,
    })
  }
  return { blocks }
}

function framesFromText(text: string, hints: Hints, platform?: string): { frames: Frame[]; exceptionType?: string; message?: string; raw: string } {
  const { blocks } = parseFormattedFrames(text)
  const withFrames = blocks.filter((b) => b.frames.length > 0)
  const chosen = withFrames.find((b) => b.crashed) ?? withFrames[0] ?? blocks[0]
  if (!chosen) return { frames: [], raw: "" }
  return {
    frames: chosen.frames.map((f) => frameFrom({ symbol: f.symbol, file: f.file, line: f.line }, hints, platform)),
    exceptionType: chosen.type,
    message: chosen.message,
    raw: text,
  }
}

/** Builds a Crash from a Crashlytics issue plus (optionally) a sample event. */
export function mapCrashlyticsIssue(issue: unknown, events: unknown, o: { id: string; appId?: string; hints: Hints; now?: string }): Crash {
  const now = o.now ?? new Date().toISOString()
  const platform = platformOfAppId(o.appId)
  const iss = (isRecord(issue) && isRecord(issue.issue) ? issue.issue : issue) as Record<string, unknown> | undefined
  const eventList: unknown[] = Array.isArray(events) ? events : isRecord(events) && Array.isArray(events.events) ? events.events : isRecord(events) ? [events] : []
  const event = eventList.find(isRecord) as Record<string, unknown> | undefined

  let frames: Frame[] = []
  let exceptionType: string | undefined
  let message: string | undefined
  let rawTrace = ""
  if (event) {
    // firebase-tools 15: pre-formatted text blocks.
    for (const key of ["exceptions", "errors", "threads"] as const) {
      if (frames.length > 0) break
      const text = event[key]
      if (typeof text !== "string" || !text.trim()) continue
      const parsed = framesFromText(stripControl(text), o.hints, platform)
      if (parsed.frames.length === 0) continue
      frames = parsed.frames
      exceptionType ??= parsed.exceptionType
      message ??= parsed.message
      rawTrace = parsed.raw
    }
    const exceptions = Array.isArray(event.exceptions) ? event.exceptions.filter(isRecord) : isRecord(event.exception) ? [event.exception] : []
    const errors = Array.isArray(event.errors) ? event.errors.filter(isRecord) : []
    const ex = exceptions[0] ?? errors[0]
    if (ex && frames.length === 0) {
      exceptionType = str(ex.type) ?? str(ex.exceptionType) ?? str(ex.title)
      message = str(ex.exceptionMessage) ?? str(ex.subtitle) ?? str(ex.message) ?? str(ex.reason)
      const list = Array.isArray(ex.frames) ? ex.frames : isRecord(ex.stackTrace) && Array.isArray(ex.stackTrace.frames) ? ex.stackTrace.frames : []
      frames = list.filter(isRecord).map((f) => frameFrom(f, o.hints, platform))
    }
    if (frames.length === 0 && Array.isArray(event.threads)) {
      const crashed = event.threads.filter(isRecord).find((t) => t.crashed === true || t.blamed === true) ?? event.threads.filter(isRecord)[0]
      const list = crashed && Array.isArray(crashed.frames) ? crashed.frames : []
      frames = list.filter(isRecord).map((f) => frameFrom(f, o.hints, platform))
    }
    if (frames.length === 0) {
      const text = [event.stackTrace, event.stacktrace, event.text, event.content].find((v) => typeof v === "string") as string | undefined
      const block = text ? (stackFromMarkdown(text) ?? text) : undefined
      if (block) {
        rawTrace = block
        const parsed = parseStackTrace(block, o.hints)
        frames = parsed.frames
        exceptionType ??= parsed.exceptionType
        message ??= parsed.message
      }
    }
  }
  if (typeof issue === "string" && frames.length === 0) {
    const block = stackFromMarkdown(stripControl(issue))
    if (block) {
      rawTrace = block
      const parsed = parseStackTrace(block, o.hints)
      frames = parsed.frames
      exceptionType ??= parsed.exceptionType
      message ??= parsed.message
    }
  }
  if (!rawTrace) rawTrace = frames.map((f) => f.raw).join("\n")

  const eventIssue = event && isRecord(event.issue) ? event.issue : undefined
  const title = str(iss?.title) ?? str(iss?.displayName) ?? str(eventIssue?.title) ?? ([exceptionType, message].filter(Boolean).join(": ") || `Crashlytics issue ${o.id}`)
  const subtitle = str(iss?.subtitle) ?? str(eventIssue?.subtitle)
  exceptionType ??= str(iss?.exceptionType) ?? (title.includes(":") ? title.split(":")[0]!.trim() : undefined)
  message ??= subtitle
  const device = event && isRecord(event.device) ? event.device : undefined
  const os = event && isRecord(event.operatingSystem) ? event.operatingSystem : undefined
  const app = event && isRecord(event.application) ? event.application : undefined
  const appVersion = version(iss?.displayVersion) ?? version(app?.displayVersion) ?? version(event?.displayVersion) ?? version(iss?.lastSeenVersion) ?? version(event?.version)
  const language = languageOf(platform, frames, subtitle)
  const fp = fingerprintOf({ exceptionType, message, frames, platform })
  const stats = isRecord(iss?.issueStats) ? iss!.issueStats : iss
  return {
    id: o.id,
    source: "crashlytics",
    title: sanitizeText(title, 200),
    exceptionType,
    message: message ? sanitizeText(message) : undefined,
    frames,
    language,
    platform,
    appVersion,
    buildNumber: str(app?.buildVersion) ?? str(event?.buildVersion) ?? build(iss?.lastSeenVersion) ?? build(event?.version),
    device: device || os ? { model: str(device?.model) ?? str(device?.name), os: str(os?.displayName) ?? str(os?.name), osVersion: str(os?.displayVersion) ?? str(os?.version) } : undefined,
    firstSeen: str(iss?.firstSeenTime) ?? str(iss?.firstSeen),
    lastSeen: str(iss?.lastSeenTime) ?? str(iss?.lastSeen),
    eventCount: num(stats?.eventCount) ?? num(stats?.crashCount) ?? num(iss?.eventCount),
    userCount: num(stats?.userCount) ?? num(stats?.impactedUsers) ?? num(iss?.userCount),
    url: str(iss?.consoleUrl) ?? str(iss?.url) ?? str(iss?.uri) ?? (o.appId ? consoleUrl(o.appId, o.id) : undefined),
    appId: o.appId,
    rawStackTrace: sanitizeText(rawTrace, 64 * 1024),
    fingerprint: fp.hash,
    symbolication: symbolicationCheck(language, frames),
    fetchedAt: now,
    extra: sanitizeExtra({ state: iss?.state, signal: str(iss?.errorType) ?? str(eventIssue?.errorType), customKeys: event?.customKeys, logs: event?.logs, breadcrumbs: event?.breadcrumbs }),
  }
}

export function mapCrashlyticsList(input: unknown): CrashSummary[] {
  const raw = parseToolText(input)
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.groups)
      ? raw.groups
      : isRecord(raw) && Array.isArray(raw.issues)
        ? raw.issues
        : isRecord(raw) && Array.isArray(raw.topIssues)
          ? raw.topIssues
          : isRecord(raw) && isRecord(raw.report) && Array.isArray(raw.report.issues)
            ? raw.report.issues
            : isRecord(raw) && Array.isArray(raw.rows)
              ? raw.rows
              : []
  const out: CrashSummary[] = []
  for (const it of list) {
    if (!isRecord(it)) continue
    const iss = isRecord(it.issue) ? it.issue : it
    const id = str(iss.id) ?? str(iss.issueId) ?? str(iss.name)?.split("/").pop()
    if (!id) continue
    // firebase-tools 15 reports: `metrics` is a list of interval rows (counts as strings); older shapes: one object.
    const metricRows = Array.isArray(it.metrics) ? it.metrics.filter(isRecord) : isRecord(it.metrics) ? [it.metrics] : []
    const stats: Record<string, unknown> = metricRows.length > 0 ? sumMetrics(metricRows) : isRecord(it.issueStats) ? it.issueStats : isRecord(iss.issueStats) ? iss.issueStats : it
    out.push({
      source: "crashlytics",
      id,
      title: str(iss.title) ?? str(iss.displayName) ?? id,
      userCount: num(stats.impactedUsers) ?? num(stats.impactedUsersCount) ?? num(stats.userCount) ?? num(it.userCount),
      eventCount: num(stats.eventsCount) ?? num(stats.eventCount) ?? num(it.eventCount),
      lastSeen: str(iss.lastSeenTime) ?? str(iss.lastSeen),
      appVersion: version(iss.lastSeenVersion) ?? version(iss.displayVersion),
      url: str(iss.uri),
    })
  }
  return out
}

function sumMetrics(rows: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...rows[0] }
  for (const key of ["eventsCount", "eventCount", "impactedUsersCount", "impactedUsers", "userCount"]) {
    const values = rows.map((r) => num(r[key])).filter((v): v is number => v !== undefined)
    if (values.length) out[key] = values.reduce((a, b) => a + b, 0)
  }
  return out
}

/** The sample event resource name a report group / issue carries (`.../events/<id>`). */
export const sampleEventOf = (issue: unknown): string | undefined => (isRecord(issue) ? (str(issue.sampleEvent) ?? (isRecord(issue.issue) ? str(issue.issue.sampleEvent) : undefined)) : undefined)

const hintsOf = (sc: SourceContext): Hints => ({ appPackage: sc.options.appPackage, inAppPrefixes: sc.options.inAppPackages })

export const NO_APP_ID = 'Crashlytics needs the Firebase app id. Set "crashlytics": { "appId": "1:1234567890:android:abcdef" } (or "appIds": [..] for several platforms) in the plugin options, or pass the Firebase console URL of the issue.'

/** App ids to query: the one carried by the reference (console URL or `crashlytics:<id>@<appId>`), else every configured one. */
function appIdsOf(sc: SourceContext, extra?: Record<string, string>): string[] {
  const ids = extra?.appId ? [extra.appId] : sc.options.crashlytics.appIds
  if (ids.length === 0) throw new SourceError("crashlytics", NO_APP_ID)
  return ids
}

/** `crashlytics:<id>` or `crashlytics:<id>@<appId>` for multi-app setups. */
export const crashlyticsRef = (id: string, appId?: string) => (appId ? `crashlytics:${id}@${appId}` : `crashlytics:${id}`)

const REF = /^crashlytics:([A-Za-z0-9_-]+)(?:@(\d+:\d+:[a-z]+:[a-f0-9]+))?$/i

/** Input for a Crashlytics tool in the spelling its schema declares. */
function args(style: "camel" | "snake", fields: { appId: string; issueId?: string; pageSize?: number; names?: string[]; note?: string; filter?: Record<string, unknown>; report?: string }): Record<string, unknown> {
  const k = (camel: string, snake: string) => (style === "camel" ? camel : snake)
  const out: Record<string, unknown> = { [k("appId", "app_id")]: fields.appId }
  if (fields.issueId !== undefined) out[k("issueId", "issue_id")] = fields.issueId
  if (fields.pageSize !== undefined) out[k("pageSize", "page_size")] = fields.pageSize
  if (fields.names) out.names = fields.names
  if (fields.note !== undefined) out.note = fields.note
  if (fields.report) out.report = fields.report
  if (fields.filter) {
    if (style === "camel") out.filter = fields.filter
    else {
      // Pre-15 schema: flat snake_case filter fields.
      if (fields.filter.issueErrorTypes) out.issue_error_types = fields.filter.issueErrorTypes
      if (fields.filter.issueId) out.issue_id = fields.filter.issueId
      if (fields.filter.intervalStartTime) out.interval = { start_time: fields.filter.intervalStartTime, end_time: fields.filter.intervalEndTime }
    }
  }
  return out
}

const TOP_ISSUES_WINDOW_DAYS = 14

export const crashlytics: CrashSource = {
  id: "crashlytics",
  available: (services, options) => options.sources.includes("crashlytics") && !!services.crashlytics && services.crashlytics.status === "connected" && !!(services.crashlytics.capabilities.getIssue || services.crashlytics.capabilities.batchGetEvents),
  parseRef: (input): { id: string; extra?: Record<string, string> } | undefined => {
    const m = REF.exec(input)
    if (m) return { id: m[1]!, extra: m[2] ? { appId: m[2] } : undefined }
    // Console URLs: …/project/<p>/crashlytics/app/<appId>/issues/<id>, with optional /u/0/ or /v1/appid/ prefixes and a query string.
    const url = /console\.firebase\.google\.com\/(?:[^?#\s]*?\/)?project\/([^/?#]+)\/crashlytics\/app\/([^/?#]+)\/issues\/([A-Za-z0-9_-]+)/i.exec(input)
    if (url) return { id: url[3]!, extra: { appId: url[2]!, project: url[1]! } }
    return undefined
  },
  async list(sc, q) {
    const s = sc.services.crashlytics!
    const appIds = appIdsOf(sc)
    const multi = appIds.length > 1
    const out: CrashSummary[] = []
    const errors: string[] = []
    const toolId = s.capabilities.getReport ?? s.capabilities.listTopIssues
    if (!toolId) return []
    const style = await paramStyle(sc.ctx, toolId)
    const now = Date.now()
    // Each report call takes several seconds; query the apps in parallel so the picker stays within RPC limits.
    const results = await Promise.all(
      appIds.map(async (appId) => {
        try {
          const raw = s.capabilities.getReport
            ? await callTool(
                sc.ctx,
                s.capabilities.getReport,
                args(style, { appId, report: "topIssues", pageSize: q.top, filter: { issueErrorTypes: ["FATAL"], intervalStartTime: new Date(now - TOP_ISSUES_WINDOW_DAYS * 86_400_000).toISOString(), intervalEndTime: new Date(now).toISOString() } }),
                { sessionID: sc.sessionID, signal: sc.signal },
              )
            : await callTool(sc.ctx, toolId, { ...args(style, { appId }), issue_count: q.top, issue_type: "FATAL" }, { sessionID: sc.sessionID, signal: sc.signal })
          return { appId, raw }
        } catch (error) {
          return { appId, error: `${platformOfAppId(appId) ?? appId}: ${describeError(error)}` }
        }
      }),
    )
    for (const r of results) {
      if ("error" in r && r.error) {
        errors.push(r.error)
        continue
      }
      const platform = platformOfAppId(r.appId)
      for (const c of mapCrashlyticsList((r as { raw: unknown }).raw)) out.push({ ...c, platform, appId: r.appId, ref: crashlyticsRef(c.id, multi ? r.appId : undefined), url: c.url ?? consoleUrl(r.appId, c.id) })
    }
    if (out.length === 0 && errors.length > 0) throw new SourceError("crashlytics", errors.join("; "))
    return out
      .filter((c) => (q.minUsers ?? 0) === 0 || (c.userCount ?? 0) >= (q.minUsers ?? 0))
      .sort((a, b) => (b.userCount ?? 0) - (a.userCount ?? 0) || (b.eventCount ?? 0) - (a.eventCount ?? 0))
      .slice(0, q.top)
  },
  async get(sc, id, extra) {
    const s = sc.services.crashlytics!
    const candidates = appIdsOf(sc, extra)
    const style = await paramStyle(sc.ctx, s.capabilities.getIssue ?? s.capabilities.batchGetEvents ?? s.capabilities.listEvents ?? "")
    // Without an app in the reference, probe the configured apps in order and keep the first that knows the issue.
    let appId = candidates[0]!
    let issue: unknown
    const failures: string[] = []
    for (const candidate of candidates) {
      if (!s.capabilities.getIssue) break
      try {
        issue = parseToolText(await callTool(sc.ctx, s.capabilities.getIssue, args(style, { appId: candidate, issueId: id }), { sessionID: sc.sessionID, signal: sc.signal }))
        if (candidates.length === 1 || hasIssue(issue)) {
          appId = candidate
          break
        }
        failures.push(`${platformOfAppId(candidate) ?? candidate}: not found`)
        issue = undefined
      } catch (error) {
        if (candidates.length === 1) throw error
        failures.push(`${platformOfAppId(candidate) ?? candidate}: ${describeError(error)}`)
      }
    }
    if (candidates.length > 1 && issue === undefined && s.capabilities.getIssue) throw new SourceError("crashlytics", `issue ${id} was not found in any configured app (${failures.join("; ")})`)
    let events: unknown
    const call = (toolId: string, input: Record<string, unknown>) => callTool(sc.ctx, toolId, input, { sessionID: sc.sessionID, signal: sc.signal }).then(parseToolText)
    const sample = sampleEventOf(issue) ?? (isRecord(issue) && typeof issue.name === "string" && style === "snake" ? `${issue.name}/events/latest` : undefined)
    if (s.capabilities.batchGetEvents && sample) events = await call(s.capabilities.batchGetEvents, args(style, { appId, names: [sample], issueId: style === "snake" ? id : undefined, pageSize: style === "snake" ? 1 : undefined })).catch(() => undefined)
    if (events === undefined && s.capabilities.listEvents) events = await call(s.capabilities.listEvents, args(style, { appId, pageSize: 1, filter: { issueId: id } })).catch(() => undefined)
    if (events === undefined && s.capabilities.getSampleCrash) events = await call(s.capabilities.getSampleCrash, { ...args(style, { appId, issueId: id }), variant_count: 1 }).catch(() => undefined)
    return mapCrashlyticsIssue(issue, events, { id, appId, hints: hintsOf(sc) })
  },
  async probe(sc) {
    const s = sc.services.crashlytics!
    const toolId = s.capabilities.getReport ?? s.capabilities.listTopIssues
    const out: Array<{ label?: string; toolId: string; input: Record<string, unknown>; raw?: unknown; parsedCount?: number; error?: string }> = []
    if (!toolId) return [{ toolId: "(none)", input: {}, error: "no crashlytics_get_report / list_top_issues tool" }]
    let appIds: string[]
    try {
      appIds = appIdsOf(sc)
    } catch (error) {
      return [{ toolId, input: {}, error: describeError(error) }]
    }
    const style = await paramStyle(sc.ctx, toolId)
    const now = Date.now()
    for (const appId of appIds) {
      const input = s.capabilities.getReport
        ? args(style, { appId, report: "topIssues", pageSize: 3, filter: { issueErrorTypes: ["FATAL"], intervalStartTime: new Date(now - TOP_ISSUES_WINDOW_DAYS * 86_400_000).toISOString(), intervalEndTime: new Date(now).toISOString() } })
        : { ...args(style, { appId }), issue_count: 3, issue_type: "FATAL" }
      try {
        const raw = await callTool(sc.ctx, toolId, input, { sessionID: sc.sessionID, signal: sc.signal })
        out.push({ label: platformOfAppId(appId) ?? appId, toolId, input, raw, parsedCount: mapCrashlyticsList(raw).length })
      } catch (error) {
        out.push({ label: platformOfAppId(appId) ?? appId, toolId, input, error: describeError(error) })
      }
    }
    return out
  },
  async annotate(sc, id, note, extra) {
    const s = sc.services.crashlytics!
    if (!s.capabilities.createNote) return
    const style = await paramStyle(sc.ctx, s.capabilities.createNote)
    await callTool(sc.ctx, s.capabilities.createNote, args(style, { appId: appIdsOf(sc, extra)[0]!, issueId: id, note: note.text }), { sessionID: sc.sessionID, signal: sc.signal })
  },
}

const consoleUrl = (appId: string, id: string) => `https://console.firebase.google.com/project/_/crashlytics/app/${appId}/issues/${id}`

/** A `crashlytics_get_issue` result that actually describes an issue (not an empty / error payload). */
export function hasIssue(raw: unknown): boolean {
  if (typeof raw === "string") return raw.trim().length > 0 && !/not found|does not exist|NOT_FOUND|permission denied|error/i.test(raw)
  const iss = isRecord(raw) && isRecord(raw.issue) ? raw.issue : raw
  if (!isRecord(iss)) return false
  if (typeof iss.error === "string" || isRecord(iss.error)) return false
  return ["id", "issueId", "name", "title", "displayName"].some((k) => typeof iss[k] === "string" && (iss[k] as string).length > 0)
}
