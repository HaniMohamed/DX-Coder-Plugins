// Python tracebacks (outermost first in the text; reversed to innermost first).
//   Traceback (most recent call last):
//     File "/app/shop/cart.py", line 88, in apply_coupon
//       return coupon.id
//   AttributeError: 'NoneType' object has no attribute 'id'

import type { Frame } from "../types.js"
import type { Hints, ParsedTrace, TraceParser } from "./index.js"

const FILE = /^\s*File "([^"]+)", line (\d+)(?:, in (.+))?\s*$/
const HEADER = /^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning)?)(?::\s*(.*))?$/

function inApp(file: string, hints: Hints): boolean {
  if (/(^|\/)(site-packages|dist-packages|lib\/python\d|\.venv|venv|__pycache__)\//.test(file)) return false
  if (/^<.*>$/.test(file)) return false
  if (hints.inAppPrefixes?.some((p) => file.startsWith(p) || file.includes(`/${p}`))) return true
  return true
}

export const python: TraceParser = {
  language: "python",
  score(text) {
    let s = 0
    for (const line of text.split("\n")) if (FILE.test(line)) s += 1
    if (/Traceback \(most recent call last\)/.test(text)) s += 2
    return s
  },
  parse(text, hints) {
    const frames: Frame[] = []
    let exceptionType: string | undefined
    let message: string | undefined
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.replace(/\s+$/, "")
      const m = FILE.exec(line)
      if (m) {
        const file = m[1]!.replace(/\\/g, "/")
        frames.push({ raw: line.trim(), file, line: Number(m[2]), function: m[3]?.trim(), inApp: inApp(file, hints) })
        continue
      }
      if (frames.length > 0 && /^\S/.test(line) && !/^(Traceback|During handling|The above exception)/.test(line)) {
        const h = HEADER.exec(line.trim())
        if (h) {
          exceptionType = h[1]?.split(".").pop()
          message = h[2]?.trim() || undefined
        }
      }
    }
    frames.reverse()
    return { language: "python", exceptionType, message, frames }
  },
}
