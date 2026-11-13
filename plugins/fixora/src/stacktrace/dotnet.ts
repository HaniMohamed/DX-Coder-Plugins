// .NET stack traces.
//   System.NullReferenceException: Object reference not set to an instance of an object.
//      at Shop.Cart.CartService.ApplyCoupon(String code) in C:\src\shop\Cart\CartService.cs:line 88
//      at Shop.Api.CheckoutController.Pay() in /src/shop/Api/CheckoutController.cs:line 40
//      --- End of inner exception stack trace ---

import type { Frame } from "../types.js"
import type { Hints, ParsedTrace, TraceParser } from "./index.js"

const AT = /^\s*at\s+([\w.<>`$+]+)\.([\w<>`$+]+)\s*\((.*?)\)(?:\s+in\s+(.+?):line\s+(\d+))?\s*$/
const HEADER = /^([A-Za-z_][\w.]*(?:Exception|Error))(?::\s*(.*))?$/

function inApp(type: string, hints: Hints): boolean {
  if (hints.appPackage && type.startsWith(hints.appPackage)) return true
  if (hints.inAppPrefixes?.some((p) => type.startsWith(p))) return true
  if (hints.appPackage) return false
  return !/^(System\.|Microsoft\.|Newtonsoft\.|Xamarin\.|Mono\.|Android\.|UIKit\.|Foundation\.|Java\.|Internal\.)/.test(type)
}

export const dotnet: TraceParser = {
  language: "dotnet",
  score(text) {
    let s = 0
    for (const line of text.split("\n")) if (AT.test(line)) s += 1
    if (/:line \d+/.test(text)) s += 2
    if (/^System\.\w+Exception/m.test(text)) s += 1
    return s
  },
  parse(text, hints) {
    const frames: Frame[] = []
    const headers: string[] = []
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\s+$/, "")
      if (!line.trim()) continue
      const m = AT.exec(line)
      if (m) {
        const type = m[1]!
        const file = m[4]?.replace(/\\/g, "/")
        frames.push({ raw: line.trim(), file, line: m[5] ? Number(m[5]) : undefined, function: m[2], module: type, package: type.split(".").slice(0, -1).join("."), inApp: inApp(type, hints) })
        continue
      }
      if (/^---\s*End of inner exception/.test(line.trim())) continue
      const h = HEADER.exec(line.trim().replace(/^Unhandled exception\.\s*/, "").replace(/\s*--->\s*.*$/, ""))
      if (h) headers.push(line.trim())
    }
    // "Outer ---> Inner": the innermost exception is the most specific.
    const primary = headers[0] ?? ""
    const inner = primary.split("--->").map((s) => s.trim()).filter(Boolean)
    const chosen = inner[inner.length - 1] ?? primary
    const hm = HEADER.exec(chosen.replace(/^Unhandled exception\.\s*/, ""))
    return { language: "dotnet", exceptionType: hm?.[1], message: hm?.[2]?.trim() || undefined, frames }
  },
}
