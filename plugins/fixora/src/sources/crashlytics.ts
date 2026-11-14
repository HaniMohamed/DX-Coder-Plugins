// Firebase Crashlytics through the Firebase MCP server (`npx firebase-tools mcp`).
// Tools: crashlytics_get_issue, crashlytics_batch_get_events (sample events with stack frames),
// crashlytics_get_report (topIssues), crashlytics_create_note.

import { fingerprintOf } from "../fingerprint.js"
import { callTool } from "../mcp.js"
import { sanitizeExtra, sanitizeText, stripControl, symbolicationCheck } from "../normalize.js"
import { parseStackTrace, type Hints } from "../stacktrace/index.js"
import type { Crash, CrashSummary, Frame, Language } from "../types.js"
import { stackFromMarkdown } from "./sentry.js"
import { SourceError, type CrashSource, type SourceContext } from "./types.js"

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined)
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined)

export function platformOfAppId(appId: string | undefined): string | undefined {
  const m = /^\d+:\d+:(android|ios|web|macos|windows|linux):/.exec(appId ?? "")
  return m?.[1]
}

function languageOf(platform: string | undefined, frames: Frame[], file?: string): Language {
  const f = file ?? frames.find((x) => x.file)?.file ?? ""
  if (/\.dart$/.test(f)) return "dart"
  if (/\.(kt|java)$/.test(f)) return "jvm"
  if (/\.(swift|m|mm)$/.test(f)) return "apple"
  if (/\.(ts|tsx|js|jsx)$/.test(f)) return "js"
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
  else if (hints.appPackage && owner) inApp = owner.startsWith(hints.appPackage) || (file?.startsWith(`package:${hints.appPackage}/`) ?? false)
  else inApp = !FRAMEWORK.test(owner ?? "") && !FRAMEWORK.test(file ?? "") && !!(file || symbol)
  const isDartPkg = file?.startsWith("package:")
  const pkg = isDartPkg ? /^package:([^/]+)\//.exec(file!)?.[1] : undefined
  const cleanFile = isDartPkg ? file!.replace(/^package:[^/]+\//, "") : file
  void platform
  return { raw: `${symbol ?? ""} (${file ?? library ?? "?"}:${line ?? "?"})`.trim(), file: cleanFile, package: pkg, line, function: symbol, module: library, inApp }
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
    const exceptions = Array.isArray(event.exceptions) ? event.exceptions.filter(isRecord) : isRecord(event.exception) ? [event.exception] : []
    const errors = Array.isArray(event.errors) ? event.errors.filter(isRecord) : []
    const ex = exceptions[0] ?? errors[0]
    if (ex) {
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

  const title = str(iss?.title) ?? str(iss?.displayName) ?? ([exceptionType, message].filter(Boolean).join(": ") || `Crashlytics issue ${o.id}`)
  const subtitle = str(iss?.subtitle)
  exceptionType ??= str(iss?.exceptionType) ?? (title.includes(":") ? title.split(":")[0]!.trim() : undefined)
  message ??= subtitle
  const device = event && isRecord(event.device) ? event.device : undefined
  const os = event && isRecord(event.operatingSystem) ? event.operatingSystem : undefined
  const app = event && isRecord(event.application) ? event.application : undefined
  const appVersion = str(iss?.displayVersion) ?? str(app?.displayVersion) ?? str(event?.displayVersion) ?? str(iss?.lastSeenVersion)
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
    buildNumber: str(app?.buildVersion) ?? str(event?.buildVersion),
    device: device || os ? { model: str(device?.model) ?? str(device?.name), os: str(os?.displayName) ?? str(os?.name), osVersion: str(os?.displayVersion) ?? str(os?.version) } : undefined,
    firstSeen: str(iss?.firstSeenTime) ?? str(iss?.firstSeen),
    lastSeen: str(iss?.lastSeenTime) ?? str(iss?.lastSeen),
    eventCount: num(stats?.eventCount) ?? num(stats?.crashCount) ?? num(iss?.eventCount),
    userCount: num(stats?.userCount) ?? num(stats?.impactedUsers) ?? num(iss?.userCount),
    url: str(iss?.consoleUrl) ?? str(iss?.url) ?? (o.appId ? consoleUrl(o.appId, o.id) : undefined),
    appId: o.appId,
    rawStackTrace: sanitizeText(rawTrace, 64 * 1024),
    fingerprint: fp.hash,
    symbolication: symbolicationCheck(language, frames),
    fetchedAt: now,
    extra: sanitizeExtra({ state: iss?.state, signal: str(iss?.errorType), customKeys: event?.customKeys, logs: event?.logs }),
  }
}

export function mapCrashlyticsList(raw: unknown): CrashSummary[] {
  const list: unknown[] = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.issues) ? raw.issues : isRecord(raw) && Array.isArray(raw.topIssues) ? raw.topIssues : isRecord(raw) && isRecord(raw.report) && Array.isArray(raw.report.issues) ? raw.report.issues : isRecord(raw) && Array.isArray(raw.rows) ? raw.rows : []
  const out: CrashSummary[] = []
  for (const it of list) {
    if (!isRecord(it)) continue
    const iss = isRecord(it.issue) ? it.issue : it
    const id = str(iss.id) ?? str(iss.issueId) ?? str(iss.name)?.split("/").pop()
    if (!id) continue
    const stats = isRecord(it.issueStats) ? it.issueStats : isRecord(iss.issueStats) ? iss.issueStats : it
    out.push({ source: "crashlytics", id, title: str(iss.title) ?? str(iss.displayName) ?? id, userCount: num(stats.userCount) ?? num(stats.impactedUsers) ?? num(it.userCount), eventCount: num(stats.eventCount) ?? num(it.eventCount), lastSeen: str(iss.lastSeenTime), appVersion: str(iss.lastSeenVersion) ?? str(iss.displayVersion) })
  }
  return out
}

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

export const crashlytics: CrashSource = {
  id: "crashlytics",
  available: (services, options) => options.sources.includes("crashlytics") && !!services.crashlytics && services.crashlytics.status === "connected" && !!(services.crashlytics.capabilities.getIssue || services.crashlytics.capabilities.batchGetEvents),
  parseRef: (input): { id: string; extra?: Record<string, string> } | undefined => {
    const m = REF.exec(input)
    if (m) return { id: m[1]!, extra: m[2] ? { appId: m[2] } : undefined }
    const url = /console\.firebase\.google\.com\/(?:u\/\d+\/)?project\/([^/]+)\/crashlytics\/app\/([^/]+)\/issues\/([A-Za-z0-9_-]+)/i.exec(input)
    if (url) return { id: url[3]!, extra: { appId: url[2]!, project: url[1]! } }
    return undefined
  },
  async list(sc, q) {
    const s = sc.services.crashlytics!
    const appIds = appIdsOf(sc)
    const multi = appIds.length > 1
    const out: CrashSummary[] = []
    const errors: string[] = []
    for (const appId of appIds) {
      let raw: unknown
      try {
        if (s.capabilities.getReport) raw = await callTool(sc.ctx, s.capabilities.getReport, { app_id: appId, report: "topIssues", page_size: q.top, issue_error_types: ["FATAL"], interval: { start_time: new Date(Date.now() - 14 * 86_400_000).toISOString() } }, { sessionID: sc.sessionID, signal: sc.signal })
        else if (s.capabilities.listTopIssues) raw = await callTool(sc.ctx, s.capabilities.listTopIssues, { app_id: appId, issue_count: q.top, issue_type: "FATAL" }, { sessionID: sc.sessionID, signal: sc.signal })
        else return []
      } catch (error) {
        errors.push(`${platformOfAppId(appId) ?? appId}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const platform = platformOfAppId(appId)
      for (const c of mapCrashlyticsList(raw)) out.push({ ...c, platform, appId, ref: crashlyticsRef(c.id, multi ? appId : undefined), url: c.url ?? consoleUrl(appId, c.id) })
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
    // Without an app in the reference, probe the configured apps in order and keep the first that knows the issue.
    let appId = candidates[0]!
    let issue: unknown
    const failures: string[] = []
    for (const candidate of candidates) {
      if (!s.capabilities.getIssue) break
      try {
        issue = await callTool(sc.ctx, s.capabilities.getIssue, { app_id: candidate, issue_id: id }, { sessionID: sc.sessionID, signal: sc.signal })
        if (candidates.length === 1 || hasIssue(issue)) {
          appId = candidate
          break
        }
        failures.push(`${platformOfAppId(candidate) ?? candidate}: not found`)
        issue = undefined
      } catch (error) {
        if (candidates.length === 1) throw error
        failures.push(`${platformOfAppId(candidate) ?? candidate}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (candidates.length > 1 && issue === undefined && s.capabilities.getIssue) throw new SourceError("crashlytics", `issue ${id} was not found in any configured app (${failures.join("; ")})`)
    let events: unknown
    if (s.capabilities.batchGetEvents) {
      const sampleName = isRecord(issue) && typeof issue.sampleEvent === "string" ? issue.sampleEvent : undefined
      const resource = sampleName ?? (isRecord(issue) && typeof issue.name === "string" ? `${issue.name}/events/latest` : undefined)
      events = await callTool(sc.ctx, s.capabilities.batchGetEvents, { app_id: appId, issue_id: id, ...(resource ? { names: [resource] } : {}), page_size: 1 }, { sessionID: sc.sessionID, signal: sc.signal }).catch(() => undefined)
    } else if (s.capabilities.getSampleCrash) events = await callTool(sc.ctx, s.capabilities.getSampleCrash, { app_id: appId, issue_id: id, variant_count: 1 }, { sessionID: sc.sessionID, signal: sc.signal }).catch(() => undefined)
    return mapCrashlyticsIssue(issue, events, { id, appId, hints: hintsOf(sc) })
  },
  async annotate(sc, id, note, extra) {
    const s = sc.services.crashlytics!
    if (!s.capabilities.createNote) return
    await callTool(sc.ctx, s.capabilities.createNote, { app_id: appIdsOf(sc, extra)[0], issue_id: id, note: note.text }, { sessionID: sc.sessionID, signal: sc.signal })
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
