// Go panics.
//   panic: runtime error: invalid memory address or nil pointer dereference
//   [signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x4a1b2c]
//   goroutine 1 [running]:
//   github.com/acme/shop/cart.(*Service).Apply(0xc000010000, 0x0)
//   	/src/shop/cart/service.go:88 +0x1a
//   main.main()
//   	/src/shop/cmd/api/main.go:40 +0x2f

import type { Frame } from "../types.js"
import type { Hints, ParsedTrace, TraceParser } from "./index.js"

const FUNC = /^([\w./@-]+(?:\.\(\*?[\w]+\))?\.[\w.]+)\((.*)\)\s*$/
const LOC = /^\s+((?:[A-Za-z]:)?[^\s:]+\.go):(\d+)(?:\s+\+0x[0-9a-f]+)?\s*$/

function inApp(file: string, fn: string, hints: Hints): boolean {
  if (/(^|\/)(go\/pkg\/mod|\/usr\/local\/go\/src|\/usr\/lib\/go|GOROOT)\//.test(file) || /^runtime[./]/.test(fn)) return false
  if (/\/go\/src\/runtime\//.test(file) || /^\/.*\/src\/runtime\//.test(file)) return false
  if (hints.appPackage && fn.startsWith(hints.appPackage)) return true
  if (hints.inAppPrefixes?.some((p) => fn.startsWith(p) || file.startsWith(p))) return true
  if (hints.appPackage) return false
  return !/^(runtime|reflect|sync|net|os|io|fmt|errors|context|testing|golang\.org\/x|google\.golang\.org|github\.com\/(gin-gonic|gorilla|labstack|go-chi|gofiber|grpc))/.test(fn)
}

export const go: TraceParser = {
  language: "go",
  score(text) {
    let s = 0
    if (/^goroutine \d+ \[/m.test(text)) s += 2
    if (/^panic: /m.test(text)) s += 1
    for (const line of text.split("\n")) if (LOC.test(line)) s += 1
    return s
  },
  parse(text, hints) {
    const frames: Frame[] = []
    let message: string | undefined
    let exceptionType: string | undefined
    const lines = text.split("\n")
    let pendingFn: string | undefined
    let goroutines = 0
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "")
      if (!line.trim()) continue
      if (/^goroutine \d+ \[/.test(line)) {
        goroutines++
        if (goroutines > 1) break // only the crashing goroutine
        continue
      }
      const p = /^panic:\s*(.*)$/.exec(line)
      if (p && !message) {
        message = p[1]!.replace(/\s*\[recovered\]$/, "")
        const rt = /^runtime error:\s*(.*)$/.exec(message)
        exceptionType = rt ? "runtime.Error" : /^([\w.*]+(?:Error|Exception)?)/.exec(message)?.[1]?.replace(/^\*/, "") ?? "panic"
        if (rt) message = rt[1]
        continue
      }
      const loc = LOC.exec(line)
      if (loc && pendingFn) {
        const file = loc[1]!
        frames.push({ raw: `${pendingFn}\n${line.trim()}`, file, line: Number(loc[2]), function: pendingFn, module: pendingFn.split(".")[0], inApp: inApp(file, pendingFn, hints) })
        pendingFn = undefined
        continue
      }
      const fn = FUNC.exec(line)
      if (fn) pendingFn = fn[1]
    }
    return { language: "go", exceptionType, message, frames }
  },
}
