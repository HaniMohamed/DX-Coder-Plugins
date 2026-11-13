// Apple (Swift / Objective-C) crash logs, symbolicated or not.
//   3   MyApp                     0x0000000104a1b2c4 PaymentSheet.present(amount:) + 212 (PaymentSheet.swift:142)
//   4   MyApp                     0x0000000104a1b2c4 -[Checkout pay:] + 44 (Checkout.m:88)
//   5   UIKitCore                 0x00000001a3b1c000 -[UIApplication sendAction:to:from:forEvent:] + 100
//   6   MyApp                     0x0000000104a00000 0x104a00000 + 111300            (unsymbolicated)
// Crashlytics console export variant:
//   PaymentSheet.swift line 142
//   PaymentSheet.present(amount:)

import type { Frame } from "../types.js"
import type { Hints, ParsedTrace, TraceParser } from "./index.js"

const LINE = /^\s*(\d+)\s+(\S+)\s+(0x[0-9a-fA-F]+)\s+(.*?)\s*$/
const LOCATION = /\(([^():]+\.(?:swift|m|mm|c|cpp|h)):(\d+)\)\s*$/
const UNSYMBOLICATED = /^0x[0-9a-fA-F]+\s*\+\s*\d+$/
const CRASHLYTICS_FILE = /^([\w.+-]+\.(?:swift|m|mm|c|cpp))\s+line\s+(\d+)$/i

const SYSTEM = /^(UIKit|UIKitCore|Foundation|CoreFoundation|CoreGraphics|QuartzCore|SwiftUI|libdispatch\.dylib|libsystem_\w+\.dylib|libswiftCore\.dylib|libswift\w+\.dylib|libobjc\.A\.dylib|GraphicsServices|FrontBoardServices|CoreTelephony|AVFoundation|CFNetwork|Security|libc\+\+\.1\.dylib|dyld|WebKit|CoreData|MapKit|StoreKit|libxpc\.dylib)$/

function inApp(module: string, file: string | undefined, hints: Hints): boolean {
  if (SYSTEM.test(module)) return false
  if (hints.appPackage && hints.appPackage === module) return true
  if (hints.inAppPrefixes?.some((p) => module === p)) return true
  if (!file && !hints.appPackage) return !SYSTEM.test(module) && !/dylib$/.test(module)
  return !/dylib$|\.framework$/.test(module)
}

export const apple: TraceParser = {
  language: "apple",
  score(text) {
    let s = 0
    for (const line of text.split("\n")) {
      if (LINE.test(line)) s += 1
      else if (CRASHLYTICS_FILE.test(line.trim())) s += 1
    }
    if (/EXC_BAD_ACCESS|SIGABRT|SIGSEGV|NSInvalidArgumentException|NSRangeException|Fatal error:|\.swift:\d+/.test(text)) s += 1
    return s
  },
  parse(text, hints) {
    const frames: Frame[] = []
    const lines = text.split("\n")
    let exceptionType: string | undefined
    let message: string | undefined
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.replace(/\s+$/, "")
      if (!line.trim()) continue
      const m = LINE.exec(line)
      if (m) {
        const module = m[2]!
        const rest = m[4]!
        const loc = LOCATION.exec(rest)
        const symbol = rest.replace(LOCATION, "").trim().replace(/\s*\+\s*\d+$/, "").trim()
        const unsym = UNSYMBOLICATED.test(symbol)
        frames.push({ raw: line.trim(), file: loc?.[1], line: loc ? Number(loc[2]) : undefined, function: unsym ? undefined : symbol || undefined, module, inApp: inApp(module, loc?.[1], hints) })
        continue
      }
      const cf = CRASHLYTICS_FILE.exec(line.trim())
      if (cf) {
        const next = lines[i + 1]?.trim()
        const fn = next && !CRASHLYTICS_FILE.test(next) && !LINE.test(next) ? next : undefined
        if (fn) i++
        frames.push({ raw: line.trim(), file: cf[1], line: Number(cf[2]), function: fn, module: hints.appPackage, inApp: true })
        continue
      }
      if (frames.length === 0) {
        const ex = /^(?:\*\*\* Terminating app due to uncaught exception '|Exception Type:\s*|Fatal Exception:\s*|Crashed:\s*)?([A-Z][\w]*(?:Exception|Error)|EXC_[A-Z_]+|SIG[A-Z]+)(?:\s*\(([^)]*)\))?['\s:,-]*(.*)$/.exec(line.trim())
        if (ex && !exceptionType) {
          exceptionType = ex[1]
          message = (ex[3] || ex[2] || "").replace(/^reason:\s*'?/, "").replace(/'$/, "").trim() || undefined
        } else if (/^Fatal error:\s*/.test(line.trim()) && !exceptionType) {
          exceptionType = "FatalError"
          message = line.trim().replace(/^Fatal error:\s*/, "")
        } else if (exceptionType && !message && !/^(Thread|Crashed|Exception|Application|Process|Hardware|OS Version|Date|Last Exception)/i.test(line.trim())) {
          message = line.trim().replace(/^reason:\s*'?/, "").replace(/'$/, "")
        }
      }
    }
    return { language: "apple", exceptionType, message, frames }
  },
}
