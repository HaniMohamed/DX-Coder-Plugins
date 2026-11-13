// Sanitising untrusted crash data before it is written for the worker: control characters, size
// caps, obvious secrets/PII, and detection of instruction-like text and symbolication problems.

import { isObfuscatedClass } from "./stacktrace/jvm.js"
import { isMinifiedJs } from "./stacktrace/js.js"
import type { Frame, Language, Symbolication } from "./types.js"

export const MAX_STRING = 2 * 1024
export const MAX_RAW_TRACE = 64 * 1024
export const MAX_EXTRA = 20 * 1024

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g

export function stripControl(text: string): string {
  return text.replace(ANSI, "").replace(CONTROL, "")
}

export function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<redacted:email>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<redacted:ip>"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._\-=+/]{12,}/gi, "<redacted:auth>"],
  [/\b(?:api[_-]?key|token|secret|password|passwd|authorization|cookie|set-cookie)\s*[:=]\s*\S+/gi, "<redacted:credential>"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<redacted:jwt>"],
]

export function redact(text: string): string {
  let out = text
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep)
  return out
}

export const sanitizeText = (text: string, max = MAX_STRING) => cap(redact(stripControl(text)), max)

const INSTRUCTION_LIKE = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts)/i,
  /you are now\b/i,
  /\bsystem prompt\b/i,
  /\bas an ai\b/i,
  /\brun the following( command)?\b/i,
  /\b(curl|wget)\s+https?:\/\//i,
  /\brm\s+-rf\b/i,
  /\b(disregard|override) (your|the) (rules|instructions)\b/i,
  /\bassistant:\s/i,
  /<\s*\/?(system|instructions?)\s*>/i,
]

/** Returns the lines of `text` that look like instructions aimed at an AI or a shell. */
export function flagInstructionLikeText(text: string): string[] {
  const flagged: string[] = []
  for (const line of text.split("\n")) {
    if (INSTRUCTION_LIKE.some((re) => re.test(line))) flagged.push(line.trim().slice(0, 300))
  }
  return flagged
}

/** Drops request headers/cookies and caps the rest so `extra` stays small and secret-free. */
export function sanitizeExtra(extra: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!extra) return undefined
  const DROP = new Set(["headers", "cookies", "cookie", "authorization", "env", "environment", "token", "secret", "password"])
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 4) return "[nested]"
    if (typeof v === "string") return sanitizeText(v, 500)
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, depth + 1))
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (DROP.has(k.toLowerCase())) continue
        out[k] = walk(val, depth + 1)
      }
      return out
    }
    return v
  }
  const cleaned = walk(extra, 0) as Record<string, unknown>
  const json = JSON.stringify(cleaned)
  if (json.length <= MAX_EXTRA) return cleaned
  return { truncated: true, note: `extra was ${json.length} bytes; dropped` }
}

export function symbolicationCheck(language: Language, frames: Frame[]): Symbolication {
  const inApp = frames.filter((f) => f.inApp)
  if (frames.length === 0) return "ok"
  switch (language) {
    case "js":
      return isMinifiedJs(frames) ? "minified" : "ok"
    case "jvm": {
      const classes = inApp.map((f) => f.module).filter((m): m is string => !!m)
      if (classes.length === 0) return "ok"
      const obf = classes.filter((c) => isObfuscatedClass(c)).length
      return obf / classes.length >= 0.6 ? "obfuscated" : "ok"
    }
    case "apple": {
      const candidates = inApp.length > 0 ? inApp : frames
      const missing = candidates.filter((f) => !f.file && !f.function).length
      return candidates.length > 0 && missing / candidates.length >= 0.6 ? "unsymbolicated" : "ok"
    }
    default:
      return "ok"
  }
}
