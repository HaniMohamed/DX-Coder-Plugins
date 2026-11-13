import { describe, expect, test } from "bun:test"
import { compareVersions, detectReopen, fingerprintOf } from "../src/fingerprint.js"
import type { Frame } from "../src/types.js"

const frame = (file: string, fn: string, line: number, inApp = true): Frame => ({ raw: "", file, function: fn, line, inApp })

describe("fingerprintOf", () => {
  test("stable across line numbers and hex ids, different across types", () => {
    const a = fingerprintOf({ exceptionType: "TypeError", message: "x", frames: [frame("src/a.ts", "applyCoupon", 88), frame("src/b.ts", "pay", 40)] })
    const b = fingerprintOf({ exceptionType: "TypeError", message: "y", frames: [frame("src/a.ts", "applyCoupon", 91), frame("src/b.ts", "pay", 45)] })
    const c = fingerprintOf({ exceptionType: "RangeError", message: "x", frames: [frame("src/a.ts", "applyCoupon", 88)] })
    expect(a.hash).toBe(b.hash)
    expect(a.hash).not.toBe(c.hash)
    const h1 = fingerprintOf({ exceptionType: "E", frames: [frame("lib/x.dart", "Foo.<anonymous closure>", 1)] })
    const h2 = fingerprintOf({ exceptionType: "E", frames: [frame("/build/app/lib/x.dart", "Foo.<anonymous closure>", 9)] })
    expect(h1.hash).toBe(h2.hash)
  })

  test("ignores non-in-app frames when in-app ones exist; falls back to message", () => {
    const a = fingerprintOf({ exceptionType: "E", frames: [frame("x.kt", "f", 1), frame("Handler.java", "h", 2, false)] })
    const b = fingerprintOf({ exceptionType: "E", frames: [frame("x.kt", "f", 1), frame("Other.java", "o", 3, false)] })
    expect(a.hash).toBe(b.hash)
    const m1 = fingerprintOf({ exceptionType: "E", message: "user 123 not found at 0xdeadbeef", frames: [] })
    const m2 = fingerprintOf({ exceptionType: "E", message: "user 456 not found at 0xcafebabe", frames: [] })
    expect(m1.hash).toBe(m2.hash)
    expect(m1.basis[1]).toContain("message:")
  })

  test("platform is part of the fingerprint", () => {
    const a = fingerprintOf({ exceptionType: "E", frames: [frame("x", "f", 1)], platform: "ios" })
    const b = fingerprintOf({ exceptionType: "E", frames: [frame("x", "f", 1)], platform: "android" })
    expect(a.hash).not.toBe(b.hash)
  })
})

describe("compareVersions", () => {
  test("orders dotted versions with builds and prereleases", () => {
    expect(compareVersions("1.2.3", "1.2.10")).toBe(-1)
    expect(compareVersions("1.2.3+45", "1.2.3+46")).toBe(-1)
    expect(compareVersions("v2.0.0", "2.0.0")).toBe(0)
    expect(compareVersions("2.0.0-beta.1", "2.0.0")).toBe(-1)
    expect(compareVersions("3.2.2", "3.2.1")).toBe(1)
  })
})

describe("detectReopen", () => {
  const fixedAt = "2026-11-01T00:00:00.000Z"
  const index = { fingerprint: "fp", runIds: ["sentry-1"], reopened: { count: 0 }, fixedIn: { release: "3.2.1", markedBy: "me", at: fixedAt, runId: "sentry-1" } }

  test("not reopened without a fix, before the fix, or while ignored", () => {
    expect(detectReopen(undefined, { lastSeen: "2026-11-05T00:00:00Z" }, "2026-11-06T00:00:00Z").reopened).toBe(false)
    expect(detectReopen(index, { lastSeen: "2026-10-30T00:00:00Z" }, "2026-11-06T00:00:00Z").reopened).toBe(false)
    expect(detectReopen({ ...index, ignoreUntil: "2026-12-01T00:00:00Z" }, { lastSeen: "2026-11-05T00:00:00Z" }, "2026-11-06T00:00:00Z").reopened).toBe(false)
  })

  test("classifies fix-not-shipped vs incomplete-fix", () => {
    expect(detectReopen(index, { lastSeen: "2026-11-05T00:00:00Z", appVersion: "3.2.0" }, "2026-11-06T00:00:00Z")).toMatchObject({ reopened: true, reason: "fix-not-shipped" })
    expect(detectReopen(index, { lastSeen: "2026-11-05T00:00:00Z", appVersion: "3.2.2" }, "2026-11-06T00:00:00Z")).toMatchObject({ reopened: true, reason: "incomplete-fix" })
    expect(detectReopen(index, { lastSeen: "2026-11-05T00:00:00Z" }, "2026-11-06T00:00:00Z")).toMatchObject({ reopened: true, reason: "incomplete-fix" })
  })
})
