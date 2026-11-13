// Crash fingerprint (stable across line-number changes), version comparison and reopen detection.

import { createHash } from "node:crypto"
import type { Crash, CrashIndexEntry, Frame, ReopenReason } from "./types.js"

/** Last two path components, so build roots and absolute prefixes do not change the fingerprint. */
const normalizeFile = (file: string) =>
  file
    .replace(/\\/g, "/")
    .replace(/\?.*$/, "")
    .split("/")
    .filter(Boolean)
    .slice(-2)
    .join("/")
    .toLowerCase()

const normalizeFn = (fn: string) =>
  fn
    .replace(/\b0x[0-9a-f]+\b/gi, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "")
    .replace(/<anonymous closure>|\$\d+|lambda\$\d+|\.\d+$/g, "")
    .replace(/\d+/g, "#")
    .trim()

const normalizeMessage = (m: string) =>
  m
    .replace(/\b0x[0-9a-f]+\b/gi, "0x#")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)

export interface Fingerprint {
  hash: string
  basis: string[]
}

export function fingerprintOf(crash: Pick<Crash, "exceptionType" | "message" | "frames"> & { platform?: string }, n = 3): Fingerprint {
  const basis: string[] = []
  basis.push(`type:${(crash.exceptionType ?? "unknown").trim().toLowerCase()}`)
  if (crash.platform) basis.push(`platform:${crash.platform.toLowerCase()}`)
  const frameKey = (f: Frame) => `frame:${f.file ? normalizeFile(f.file) : "?"}:${f.function ? normalizeFn(f.function) : "?"}`
  const inApp = crash.frames.filter((f) => f.inApp && (f.file || f.function)).slice(0, n)
  if (inApp.length > 0) {
    for (const f of inApp) basis.push(frameKey(f))
  } else {
    const any = crash.frames.filter((f) => f.file || f.function).slice(0, n)
    if (any.length > 0) for (const f of any) basis.push(frameKey(f))
    else basis.push(`message:${normalizeMessage(crash.message ?? "")}`)
  }
  const hash = createHash("sha256").update(basis.join("\n")).digest("hex").slice(0, 32)
  return { hash, basis }
}

export const shortFingerprint = (fp: string, n = 12) => fp.slice(0, n)

/** Compares dotted versions with optional build suffixes (1.2.3+45, 1.2.3-beta.1). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) => {
    const [main, pre] = v.trim().replace(/^v/i, "").split("-", 2)
    const [core, build] = (main ?? "").split("+", 2)
    const parts = (core ?? "").split(".").map((p) => Number.parseInt(p, 10) || 0)
    return { parts, build: Number.parseInt(build ?? "0", 10) || 0, pre: pre ?? "" }
  }
  const A = parse(a)
  const B = parse(b)
  const len = Math.max(A.parts.length, B.parts.length)
  for (let i = 0; i < len; i++) {
    const x = A.parts[i] ?? 0
    const y = B.parts[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (A.build !== B.build) return A.build < B.build ? -1 : 1
  if (A.pre !== B.pre) {
    if (!A.pre) return 1
    if (!B.pre) return -1
    return A.pre < B.pre ? -1 : 1
  }
  return 0
}

export interface ReopenDecision {
  reopened: boolean
  reason?: ReopenReason
  detail?: string
}

/**
 * A crash is "reopened" when its fingerprint was marked fixed in a release and the crash was seen
 * again afterwards (later timestamp, and — when versions are known — in a version >= the fixed one).
 */
export function detectReopen(index: CrashIndexEntry | undefined, crash: Pick<Crash, "lastSeen" | "appVersion">, now: string): ReopenDecision {
  if (!index?.fixedIn) return { reopened: false }
  if (index.ignoreUntil && index.ignoreUntil > now) return { reopened: false }
  const seen = crash.lastSeen ?? now
  if (seen <= index.fixedIn.at) return { reopened: false }
  if (crash.appVersion && index.fixedIn.release) {
    const cmp = compareVersions(crash.appVersion, index.fixedIn.release)
    if (cmp < 0) return { reopened: true, reason: "fix-not-shipped", detail: `seen in ${crash.appVersion}, fix shipped in ${index.fixedIn.release}` }
    return { reopened: true, reason: "incomplete-fix", detail: `seen again in ${crash.appVersion} (fixed in ${index.fixedIn.release})` }
  }
  return { reopened: true, reason: "incomplete-fix", detail: `seen again after the fix (${index.fixedIn.release})` }
}

export const topInAppFrame = (frames: Frame[]) => frames.find((f) => f.inApp && f.file) ?? frames.find((f) => f.file)
