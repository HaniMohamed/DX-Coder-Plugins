// JVM (Kotlin / Java / Android) stack traces.
//   java.lang.NullPointerException: Attempt to invoke virtual method ... on a null object reference
//       at com.example.app.cart.CartRepository.load(CartRepository.kt:88)
//       at com.example.app.cart.CartRepository$load$1.invokeSuspend(CartRepository.kt:120)
//   Caused by: java.lang.IllegalStateException: ...

import type { Frame } from "../types.js"
import type { Hints, ParsedTrace, TraceParser } from "./index.js"

const AT = /^\s*at\s+(?:([\w.$<>-]+)\/)?([\w.$<>-]+)\.([\w$<>-]+)\((?:([^:)]+?)(?::(\d+))?|Native Method|Unknown Source(?::\d+)?)\)\s*$/
const HEADER = /^(?:Exception in thread "[^"]*"\s+|Caused by:\s+|FATAL EXCEPTION:.*?\n)?([a-zA-Z_][\w.$]*(?:Exception|Error|Throwable|Fault))(?::\s*(.*))?$/

const FRAMEWORK = /^(java\.|javax\.|kotlin\.|kotlinx\.|android\.|androidx\.|com\.android\.|com\.google\.|dalvik\.|sun\.|jdk\.|org\.jetbrains\.|io\.reactivex\.|okhttp3\.|retrofit2\.|okio\.|dagger\.|io\.flutter\.|org\.chromium\.|com\.squareup\.)/

export function isObfuscatedClass(cls: string): boolean {
  const parts = cls.split(".")
  const short = parts.filter((p) => /^[a-z]{1,2}\d*$/.test(p)).length
  return parts.length >= 2 && short / parts.length >= 0.6
}

function inApp(cls: string, hints: Hints): boolean {
  if (hints.appPackage && cls.startsWith(hints.appPackage)) return true
  if (hints.inAppPrefixes?.some((p) => cls.startsWith(p))) return true
  if (hints.appPackage || hints.inAppPrefixes?.length) return false
  return !FRAMEWORK.test(cls)
}

export const jvm: TraceParser = {
  language: "jvm",
  score(text) {
    let s = 0
    for (const line of text.split("\n")) if (AT.test(line)) s += 1
    if (/\.(kt|java):\d+\)/.test(text)) s += 1
    if (/^\s*Caused by:/m.test(text)) s += 0.5
    return s
  },
  parse(text, hints) {
    // One frame list per exception in the chain; the last "Caused by" is the real cause and goes first.
    const sections: Frame[][] = [[]]
    const header: string[] = []
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\s+$/, "")
      if (!line.trim()) continue
      const m = AT.exec(line)
      if (m) {
        const cls = m[2]!
        sections[sections.length - 1]!.push({ raw: line.trim(), file: m[4], line: m[5] ? Number(m[5]) : undefined, function: m[3], module: cls, package: cls.split(".").slice(0, -1).join("."), inApp: inApp(cls, hints) })
        continue
      }
      if (/^\s*\.\.\.\s*\d+ more/.test(line)) continue
      if (/^\s*Caused by:/.test(line)) sections.push([])
      if (sections.length === 1 || /^\s*Caused by:/.test(line)) header.push(line.trim())
    }
    const frames = sections.reverse().flat()
    // The innermost cause is the most specific exception; prefer it for type/message.
    const causes = header.filter((h) => h.startsWith("Caused by:"))
    const primary = causes.length > 0 ? causes[causes.length - 1]! : (header.find((h) => HEADER.test(h)) ?? header[0] ?? "")
    const hm = HEADER.exec(primary.replace(/^Caused by:\s*/, ""))
    const exceptionType = hm?.[1]
    const message = hm?.[2]?.trim() || undefined
    return { language: "jvm", exceptionType, message, frames }
  },
}
