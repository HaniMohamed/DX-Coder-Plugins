// A pasted stack trace saved to a file: no MCP needed.

import { readFile } from "node:fs/promises"
import { fingerprintOf } from "../fingerprint.js"
import { sanitizeText, stripControl, symbolicationCheck } from "../normalize.js"
import { parseStackTrace } from "../stacktrace/index.js"
import type { Crash, Language } from "../types.js"
import type { CrashSource } from "./types.js"

export interface ManualInput {
  text: string
  title?: string
  platform?: string
  language?: Language
  appPackage?: string
  inAppPrefixes?: string[]
}

export function crashFromText(input: ManualInput, now = new Date().toISOString()): Crash {
  const raw = stripControl(input.text).trim()
  const parsed = parseStackTrace(raw, { language: input.language, appPackage: input.appPackage, inAppPrefixes: input.inAppPrefixes })
  const fp = fingerprintOf({ exceptionType: parsed.exceptionType, message: parsed.message, frames: parsed.frames, platform: input.platform })
  const title = input.title?.trim() || [parsed.exceptionType, parsed.message].filter(Boolean).join(": ").slice(0, 120) || raw.split("\n")[0]!.slice(0, 120)
  return {
    id: fp.hash.slice(0, 10),
    source: "manual",
    title: sanitizeText(title, 200),
    exceptionType: parsed.exceptionType,
    message: parsed.message ? sanitizeText(parsed.message) : undefined,
    frames: parsed.frames,
    language: parsed.language,
    platform: input.platform,
    rawStackTrace: raw.slice(0, 64 * 1024),
    fingerprint: fp.hash,
    symbolication: symbolicationCheck(parsed.language, parsed.frames),
    fetchedAt: now,
  }
}

export const manual: CrashSource = {
  id: "manual",
  available: () => true,
  parseRef: (input) => {
    const m = /^manual:(.+)$/.exec(input)
    return m ? { id: m[1]! } : undefined
  },
}

/** Reads the plugin's own copy of a pasted trace (`<run folder>/trace.txt`); no MCP, no agent. */
export async function crashFromFile(o: { file: string; title?: string; platform?: string; language?: string; appPackage?: string; inAppPrefixes?: string[] }): Promise<Crash> {
  let text: string
  try {
    text = await readFile(o.file, "utf8")
  } catch (error) {
    throw new Error(`cannot read stack trace file ${o.file}: ${(error as Error).message}`)
  }
  if (!text.trim()) throw new Error(`${o.file} is empty`)
  const crash = crashFromText({ text, title: o.title, platform: o.platform, language: o.language as Language | undefined, appPackage: o.appPackage, inAppPrefixes: o.inAppPrefixes })
  if (crash.frames.length === 0) throw new Error(`could not parse any stack frame from ${o.file}. Supported formats: Dart/Flutter, Kotlin/Java, Swift/Objective-C, JavaScript/TypeScript, Python, Go, .NET, and any "path:line" lines.`)
  return crash
}
