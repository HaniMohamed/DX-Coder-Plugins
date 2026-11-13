// Stack-trace parsing: each language parser scores a text and parses it into innermost-first frames.
// The highest score wins; a generic `path:line` scanner is the fallback.

import type { Frame, Language } from "../types.js"
import { apple } from "./apple.js"
import { dart } from "./dart.js"
import { dotnet } from "./dotnet.js"
import { go } from "./go.js"
import { js } from "./js.js"
import { jvm } from "./jvm.js"
import { python } from "./python.js"

export interface Hints {
  language?: Language
  /** Application package / bundle id prefix, e.g. "com.example.app", "my_app" (Dart), "@acme/shop". */
  appPackage?: string
  /** Additional in-app path/module prefixes. */
  inAppPrefixes?: string[]
}

export interface ParsedTrace {
  language: Language
  exceptionType?: string
  message?: string
  frames: Frame[]
}

export interface TraceParser {
  language: Language
  score(text: string): number
  parse(text: string, hints: Hints): ParsedTrace
}

export const PARSERS: TraceParser[] = [dart, jvm, apple, js, python, go, dotnet]

export function parseStackTrace(text: string, hints: Hints = {}): ParsedTrace {
  const input = text.replace(/\r\n?/g, "\n")
  if (hints.language && hints.language !== "unknown") {
    const parser = PARSERS.find((p) => p.language === hints.language)
    if (parser) return parser.parse(input, hints)
  }
  let best: { parser: TraceParser; score: number } | undefined
  for (const parser of PARSERS) {
    const score = parser.score(input)
    if (score > 0 && (!best || score > best.score)) best = { parser, score }
  }
  if (best && best.score >= 1) return best.parser.parse(input, hints)
  return generic(input, hints)
}

const SOURCE_EXT = "(?:dart|kt|kts|java|swift|m|mm|js|jsx|ts|tsx|mjs|cjs|py|go|cs|rs|rb|php|c|cc|cpp|h|hpp)"
const GENERIC = new RegExp(`((?:[A-Za-z]:)?[\\w@./\\\\-]+\\.${SOURCE_EXT})(?::|, line |:line | line )(\\d+)`, "g")

/** Fallback: any `path.ext:line` token on a line becomes a frame (outermost-first is not assumed). */
export function generic(text: string, hints: Hints): ParsedTrace {
  const frames: Frame[] = []
  const lines = text.split("\n")
  const header = lines.find((l) => l.trim().length > 0)?.trim()
  for (const raw of lines) {
    GENERIC.lastIndex = 0
    const m = GENERIC.exec(raw)
    if (!m) continue
    const file = m[1]!.replace(/\\/g, "/")
    const fn = /(?:at |in |\bfn )?([A-Za-z_$][\w$.:<>-]*)\s*\(/.exec(raw)?.[1]
    frames.push({ raw: raw.trim(), file, line: Number(m[2]), function: fn, inApp: isInAppPath(file, hints) })
  }
  const exception = header && !GENERIC.test(header) ? splitException(header) : {}
  return { language: "unknown", frames, ...exception }
}

export function splitException(line: string): { exceptionType?: string; message?: string } {
  const m = /^([A-Za-z_][\w.$]*(?:Exception|Error|Panic|Failure|Fault|Abort|Throwable)?)\s*:\s*(.*)$/.exec(line.trim())
  if (m && /[A-Za-z]/.test(m[1]!) && !/\s/.test(m[1]!)) return { exceptionType: m[1], message: m[2] || undefined }
  return { message: line.trim() || undefined }
}

const EXTERNAL_PATH = /(^|\/)(node_modules|site-packages|dist-packages|vendor|Pods|\.pub-cache|\.gradle|\.cargo|go\/pkg\/mod|\.dart_tool)\//

export function isInAppPath(file: string, hints: Hints): boolean {
  if (EXTERNAL_PATH.test(file)) return false
  if (/^(dart:|node:|internal\/|<anonymous>|native)/.test(file)) return false
  if (hints.inAppPrefixes?.some((p) => file.startsWith(p) || file.includes(`/${p}`))) return true
  return true
}

export const takeTail = (text: string, lines: number) => text.split("\n").slice(-lines).join("\n")
