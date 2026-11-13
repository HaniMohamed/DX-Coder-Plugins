// Maps stack frames to repository paths (pure). The worker does the real reasoning; this produces
// ranked candidates from a file index built with `git ls-files` on the base branch.

import type { Frame, Language, MappedFrame } from "./types.js"

export interface FileIndex {
  headSha: string
  files: string[]
  byBasename: Record<string, string[]>
}

export function buildIndex(files: string[], headSha: string): FileIndex {
  const byBasename: Record<string, string[]> = {}
  const normalized = files.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""))
  for (const f of normalized) {
    const base = f.slice(f.lastIndexOf("/") + 1)
    ;(byBasename[base] ??= []).push(f)
  }
  return { headSha, files: normalized, byBasename }
}

export const PACKAGE_ROOTS = ["lib/", "src/", "app/", "packages/", "modules/", "android/app/src/main/", "ios/Runner/", "Sources/", "cmd/", "internal/", "pkg/"]
const PENALTY = /(^|\/)(test|tests|spec|__tests__|integration_test|androidTest|androidTestDebug|UITests)\/|(_test|\.test|\.spec|Tests?)\.[a-z]+$|\.g\.dart$|\.freezed\.dart$|\.pb\.|(^|\/)(dist|build|generated|__generated__|node_modules|\.dart_tool)\//

/**
 * Turns a frame's file/module into likely repo-relative paths before index lookup.
 * Returns the candidate strings in priority order (first = most specific).
 */
export function packagePathToRepoPath(frame: Frame, hints: { appPackage?: string; language: Language }): string[] {
  const out: string[] = []
  const file = frame.file?.replace(/\\/g, "/")
  if (!file) {
    // JVM/.NET frames without a file still carry a class: com.foo.Bar → com/foo/Bar.{kt,java}
    if ((hints.language === "jvm" || hints.language === "dotnet") && frame.module) {
      const cls = frame.module.split("$")[0]!
      const path = cls.replace(/\./g, "/")
      if (hints.language === "jvm") out.push(`${path}.kt`, `${path}.java`)
      else out.push(`${cls.split(".").pop()}.cs`)
    }
    return out
  }
  if (hints.language === "dart" && frame.package) {
    out.push(`lib/${file}`)
    if (hints.appPackage && frame.package !== hints.appPackage) out.push(`packages/${frame.package}/lib/${file}`)
    out.push(file)
    return out
  }
  if (hints.language === "jvm" && frame.module && !file.includes("/")) {
    const pkgPath = frame.module.split("$")[0]!.split(".").slice(0, -1).join("/")
    if (pkgPath) out.push(`${pkgPath}/${file}`)
    out.push(file)
    return out
  }
  const stripped = file
    .replace(/^(webpack(-internal)?:\/\/\/?(\.\/)?|file:\/\/)/, "")
    .replace(/^[A-Za-z]:\//, "")
    .replace(/^\/+/, "")
  out.push(stripped)
  // Absolute paths from CI/containers: also try the suffix starting at each common root component.
  const parts = stripped.split("/")
  const ROOTS = new Set(["src", "lib", "app", "packages", "internal", "pkg", "cmd", "Sources", "android", "ios", "test", "tests"])
  for (let i = 1; i < parts.length - 1; i++) if (ROOTS.has(parts[i]!)) out.push(parts.slice(i).join("/"))
  return out.filter((v, i, a) => a.indexOf(v) === i)
}

function score(candidate: string, wanted: string): { score: number; reason: string } | undefined {
  if (candidate === wanted) return { score: 1, reason: "exact" }
  if (candidate.endsWith(`/${wanted}`)) {
    const n = wanted.split("/").length
    return { score: Math.min(0.95, 0.5 + 0.1 * n), reason: `suffix:${n}` }
  }
  const wantedParts = wanted.split("/")
  const candParts = candidate.split("/")
  if (wantedParts[wantedParts.length - 1] !== candParts[candParts.length - 1]) return undefined
  // Common trailing components beyond the basename.
  let n = 1
  while (n < wantedParts.length && n < candParts.length && wantedParts[wantedParts.length - 1 - n] === candParts[candParts.length - 1 - n]) n++
  if (n > 1) return { score: Math.min(0.9, 0.4 + 0.1 * n), reason: `suffix:${n}` }
  return { score: 0.3, reason: "basename" }
}

export function mapFrames(frames: Frame[], index: FileIndex, o: { language: Language; appPackage?: string; maxCandidates?: number }): MappedFrame[] {
  const max = o.maxCandidates ?? 3
  const set = new Set(index.files)
  return frames.map((frame, i) => {
    const wanted = packagePathToRepoPath(frame, { appPackage: o.appPackage, language: o.language })
    const scored = new Map<string, { score: number; reason: string }>()
    for (const w of wanted) {
      if (set.has(w)) scored.set(w, { score: 1, reason: "exact" })
      const base = w.slice(w.lastIndexOf("/") + 1)
      for (const candidate of index.byBasename[base] ?? []) {
        const s = score(candidate, w)
        if (!s) continue
        let total = s.score
        let reason = s.reason
        if (s.reason !== "exact" && PACKAGE_ROOTS.some((r) => candidate.startsWith(r))) {
          total = Math.min(0.99, total + 0.15)
          reason += "+root"
        }
        if (PENALTY.test(candidate)) {
          total -= 0.3
          reason += "-test/generated"
        }
        const prev = scored.get(candidate)
        if (!prev || prev.score < total) scored.set(candidate, { score: Math.round(total * 100) / 100, reason })
      }
    }
    const candidates = [...scored.entries()]
      .map(([path, s]) => ({ path, ...s }))
      .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
      .slice(0, max)
    return { frame, index: i, candidates, external: !frame.inApp }
  })
}

export function mappability(mapped: MappedFrame[]): "high" | "low" | "none" {
  const inApp = mapped.filter((m) => !m.external)
  const resolved = inApp.filter((m) => m.candidates.length > 0 && m.candidates[0]!.score >= 0.5)
  if (resolved.length === 0) {
    const any = mapped.filter((m) => m.candidates.length > 0)
    return any.length > 0 ? "low" : "none"
  }
  return resolved[0] === inApp[0] || resolved.length >= Math.ceil(inApp.length / 2) ? "high" : "low"
}

/** Paths the primary frames map to, used for test-subset selection and the commit scope. */
export function primaryPaths(mapped: MappedFrame[], n = 3): string[] {
  const out: string[] = []
  for (const m of mapped) {
    if (m.external) continue
    const best = m.candidates[0]
    if (best && best.score >= 0.5 && !out.includes(best.path)) out.push(best.path)
    if (out.length >= n) break
  }
  return out
}
