// JavaScript / TypeScript (V8 and Firefox/Safari formats).
//   TypeError: Cannot read properties of undefined (reading 'id')
//       at applyCoupon (src/cart/service.ts:88:21)
//       at async Checkout.pay (/app/src/checkout.ts:40:5)
//       at Object.<anonymous> (node_modules/express/lib/router.js:12:3)
//   applyCoupon@webpack:///./src/cart/service.ts:88:21          (Firefox)

import type { Frame } from "../types.js"
import type { Hints, ParsedTrace, TraceParser } from "./index.js"

const V8 = /^\s*at\s+(?:(?:async\s+)?(.+?)\s+\()?((?:[A-Za-z]+:\/\/|[A-Za-z]:[\\/]|\/|\.\.?\/|[\w@.-]+[\\/])?[^()\s]+?):(\d+):(\d+)\)?\s*$/
const V8_ANON = /^\s*at\s+(?:async\s+)?(.+?)\s+\((native|<anonymous>|unknown location)\)\s*$/
const FIREFOX = /^\s*([^@\s]*)@((?:[A-Za-z]+:\/\/)?[^:\s]+?):(\d+):(\d+)\s*$/
const HEADER = /^([A-Z][\w$]*(?:Error|Exception)?)(?::\s*(.*))?$/

export function cleanJsPath(file: string): string {
  return file
    .replace(/^webpack(?:-internal)?:\/\/\/?(?:\.\/)?/, "")
    .replace(/^file:\/\//, "")
    .replace(/^(?:https?:\/\/[^/]+\/)/, "")
    .replace(/\?[^#]*$/, "")
    .replace(/\\/g, "/")
}

function inApp(file: string, fn: string | undefined, hints: Hints): boolean {
  if (/(^|\/)node_modules\//.test(file)) return false
  if (/^(node:|internal\/|native|<anonymous>|unknown location)/.test(file)) return false
  if (/^[\w-]+:\/\//.test(file) && !/^https?:\/\//.test(file)) return false
  if (hints.inAppPrefixes?.some((p) => file.startsWith(p))) return true
  if (hints.appPackage && file.startsWith(hints.appPackage)) return true
  void fn
  return true
}

export function isMinifiedJs(frames: Frame[]): boolean {
  const scored = frames.filter((f) => f.file && f.inApp)
  if (scored.length === 0) return false
  const suspicious = scored.filter((f) => /\.min\.js$|bundle\.js$|index\.(android|ios)\.bundle|main\.[0-9a-f]{6,}\.js$/.test(f.file!) || (f.column ?? 0) > 5000 || (f.function !== undefined && /^[a-zA-Z_$]{1,2}$/.test(f.function)))
  return suspicious.length / scored.length >= 0.6
}

export const js: TraceParser = {
  language: "js",
  score(text) {
    let s = 0
    const foreign = /\.(kt|kts|java|swift|m|mm|dart|py|go|cs|rs|rb|php)(?::\d+|\b)/
    for (const line of text.split("\n")) {
      if (foreign.test(line)) {
        s -= 1
        continue
      }
      if (V8.test(line) || V8_ANON.test(line)) s += 1
      else if (FIREFOX.test(line)) s += 1
    }
    if (/\.(ts|tsx|js|jsx|mjs|cjs):\d+:\d+/.test(text)) s += 1
    return s
  },
  parse(text, hints) {
    const frames: Frame[] = []
    let exceptionType: string | undefined
    let message: string | undefined
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\s+$/, "")
      if (!line.trim()) continue
      let m = V8.exec(line)
      if (m) {
        const file = cleanJsPath(m[2]!)
        frames.push({ raw: line.trim(), file, line: Number(m[3]), column: Number(m[4]), function: m[1]?.trim() || undefined, inApp: inApp(file, m[1], hints) })
        continue
      }
      m = V8_ANON.exec(line)
      if (m) {
        frames.push({ raw: line.trim(), function: m[1]?.trim() || undefined, inApp: false })
        continue
      }
      m = FIREFOX.exec(line)
      if (m) {
        const file = cleanJsPath(m[2]!)
        frames.push({ raw: line.trim(), file, line: Number(m[3]), column: Number(m[4]), function: m[1] || undefined, inApp: inApp(file, m[1], hints) })
        continue
      }
      if (frames.length === 0 && !exceptionType) {
        const h = HEADER.exec(line.trim().replace(/^Uncaught\s+/, "").replace(/^\(in promise\)\s+/, ""))
        if (h) {
          exceptionType = h[1]
          message = h[2]?.trim() || undefined
        }
      }
    }
    return { language: "js", exceptionType, message, frames }
  },
}
