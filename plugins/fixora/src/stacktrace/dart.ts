// Dart / Flutter stack traces.
//   #0      CartService.applyCoupon (package:my_app/cart/service.dart:88:12)
//   #1      _runGuarded (dart:async/zone.dart:1399:47)
// Flutter web / obfuscated-ish variant:
//   package:my_app/cart/service.dart 88:12   CartService.applyCoupon

import type { Frame } from "../types.js"
import type { Hints, ParsedTrace, TraceParser } from "./index.js"

const VM = /^#(\d+)\s+(.+?)\s+\((.+?)(?::(\d+))?(?::(\d+))?\)\s*$/
const WEB = /^((?:package|dart|file|https?):[^\s]+?)\s+(\d+)(?::(\d+))?\s+(.+)$/
const EXCEPTION = /^(?:Exception: |Error: |Unhandled exception:\s*)?([A-Z_][\w$]*(?:Exception|Error|Fail|Abort)?)(?::\s*(.*))?$/

const EXTERNAL_PACKAGES = new Set(["flutter", "flutter_test", "flutter_localizations", "meta", "collection", "async", "vector_math", "sky_engine", "material_color_utilities", "characters", "typed_data", "path", "provider", "riverpod", "bloc", "flutter_bloc", "get", "dio", "http", "rxdart", "equatable", "freezed_annotation", "json_annotation", "intl", "shared_preferences", "firebase_core", "firebase_crashlytics", "firebase_analytics", "cloud_firestore", "go_router", "auto_route"])

export function splitDartLocation(location: string): { file?: string; package?: string; external: boolean } {
  if (location.startsWith("dart:")) return { file: location, external: true }
  const pkg = /^package:([^/]+)\/(.+)$/.exec(location)
  if (pkg) return { file: pkg[2], package: pkg[1], external: EXTERNAL_PACKAGES.has(pkg[1]!) }
  const file = /^file:\/\/(.+)$/.exec(location)
  if (file) return { file: file[1], external: false }
  const web = /^https?:\/\/[^/]+\/(.+?)(?:\?.*)?$/.exec(location)
  if (web) return { file: web[1], external: /^(packages\/flutter|dart_sdk|main\.dart\.js)/.test(web[1]!) }
  return { file: location, external: false }
}

function inApp(loc: ReturnType<typeof splitDartLocation>, hints: Hints): boolean {
  if (loc.external) return false
  if (hints.appPackage && loc.package) return loc.package === hints.appPackage || (hints.inAppPrefixes ?? []).includes(loc.package)
  return true
}

export const dart: TraceParser = {
  language: "dart",
  score(text) {
    let s = 0
    for (const line of text.split("\n")) {
      if (VM.test(line.trim())) s += 1
      else if (WEB.test(line.trim())) s += 0.8
    }
    if (/package:|dart:(async|core|ui)/.test(text)) s += 1
    return s
  },
  parse(text, hints) {
    const frames: Frame[] = []
    const headerLines: string[] = []
    for (const raw of text.split("\n")) {
      const line = raw.trim()
      if (!line) continue
      let m = VM.exec(line)
      if (m) {
        const loc = splitDartLocation(m[3]!)
        frames.push({ raw: line, file: loc.file, package: loc.package, line: m[4] ? Number(m[4]) : undefined, column: m[5] ? Number(m[5]) : undefined, function: m[2], inApp: inApp(loc, hints) })
        continue
      }
      m = WEB.exec(line)
      if (m) {
        const loc = splitDartLocation(m[1]!)
        frames.push({ raw: line, file: loc.file, package: loc.package, line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined, function: m[4]!.trim(), inApp: inApp(loc, hints) })
        continue
      }
      if (frames.length === 0) headerLines.push(line)
    }
    const header = headerLines.filter((l) => !/^(={3,}|-{3,}|When the exception was thrown|The relevant error-causing widget|Stack trace)/.test(l))
    let exceptionType: string | undefined
    let message: string | undefined
    for (const h of header) {
      const m = EXCEPTION.exec(h)
      if (m && /[A-Z]/.test(m[1]![0]!)) {
        exceptionType = m[1]
        message = m[2] || header.filter((x) => x !== h).join(" ").slice(0, 300) || undefined
        break
      }
    }
    if (!exceptionType && header.length > 0) {
      const first = header[0]!
      if (/^(Null check operator|type '.*' is not a subtype|Bad state|RangeError|FormatException)/.test(first)) {
        exceptionType = first.startsWith("Null check") ? "_TypeError" : first.split(/[:\s]/)[0]
        message = first
      } else message = header.join(" ").slice(0, 300)
    }
    return { language: "dart", exceptionType, message, frames }
  },
}
