import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULTS } from "../src/options.js"
import { mapCrashlyticsIssue, mapCrashlyticsList, platformOfAppId } from "../src/sources/crashlytics.js"
import { resolveRef, runIdFor } from "../src/sources/index.js"
import { crashFromText } from "../src/sources/manual.js"
import { mapSentryIssue, mapSentryList, stackFromMarkdown } from "../src/sources/sentry.js"

const fixture = (p: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", p), "utf8")) as unknown

describe("resolveRef", () => {
  test("source:id, URLs, manual", () => {
    expect(resolveRef("sentry:12345", DEFAULTS)).toEqual({ source: "sentry", id: "12345", extra: undefined })
    expect(resolveRef("https://acme.sentry.io/issues/12345/", DEFAULTS)).toMatchObject({ source: "sentry", id: "12345", extra: { org: "acme" } })
    expect(resolveRef("https://sentry.io/organizations/acme/issues/777/?project=1", DEFAULTS)).toMatchObject({ source: "sentry", id: "777", extra: { org: "acme" } })
    expect(resolveRef("crashlytics:abc_DEF-1", DEFAULTS)).toMatchObject({ source: "crashlytics", id: "abc_DEF-1" })
    expect(resolveRef("https://console.firebase.google.com/project/my-proj/crashlytics/app/1:123:android:abc/issues/deadbeef", DEFAULTS)).toMatchObject({ source: "crashlytics", id: "deadbeef", extra: { appId: "1:123:android:abc", project: "my-proj" } })
    expect(resolveRef("manual:abc", DEFAULTS)).toMatchObject({ source: "manual", id: "abc" })
    expect(resolveRef("nope", DEFAULTS)).toBeUndefined()
    expect(runIdFor("sentry", "12/34 5")).toBe("sentry-12_34_5")
  })
})

describe("sentry adapter", () => {
  test("maps a structured issue with event frames (outermost → innermost)", () => {
    const crash = mapSentryIssue(fixture("sentry/get_issue_details.node.json"), { id: "4523123", hints: {} })
    expect(crash.source).toBe("sentry")
    expect(crash.title).toContain("TypeError")
    expect(crash.exceptionType).toBe("TypeError")
    expect(crash.language).toBe("js")
    expect(crash.frames[0]).toMatchObject({ file: "src/cart/service.ts", line: 88, function: "applyCoupon", inApp: true })
    expect(crash.frames[crash.frames.length - 1]!.inApp).toBe(false)
    expect(crash.userCount).toBe(540)
    expect(crash.appVersion).toBe("2024.11.2")
    expect(crash.url).toContain("sentry.io")
    expect(crash.symbolication).toBe("ok")
    expect(crash.fingerprint).toHaveLength(32)
    expect(JSON.stringify(crash.extra)).not.toContain("secret-cookie")
  })

  test("maps a markdown response by extracting the fenced trace", () => {
    const md = "# Issue PROJ-1\n**Title**: NullPointerException in CartRepository\n**Platform**: android\n**Users**: 612\n**URL**: https://acme.sentry.io/issues/99/\n\n## Stack trace\n```\njava.lang.NullPointerException: boom\n\tat com.example.app.cart.CartRepository.load(CartRepository.kt:88)\n\tat android.os.Handler.handleCallback(Handler.java:938)\n```\n"
    const crash = mapSentryIssue(md, { id: "99", hints: { appPackage: "com.example.app" } })
    expect(crash.title).toBe("NullPointerException in CartRepository")
    expect(crash.language).toBe("jvm")
    expect(crash.frames[0]).toMatchObject({ file: "CartRepository.kt", line: 88, inApp: true })
    expect(crash.userCount).toBe(612)
    expect(crash.url).toBe("https://acme.sentry.io/issues/99/")
    expect(stackFromMarkdown("no trace here")).toBeUndefined()
  })

  test("react-native minified frames are flagged", () => {
    const crash = mapSentryIssue(fixture("sentry/get_issue_details.react-native.json"), { id: "1", hints: {} })
    expect(crash.symbolication).toBe("minified")
  })

  test("list mapping from arrays and markdown", () => {
    expect(mapSentryList([{ id: "1", title: "A", userCount: 3, count: "10", lastSeen: "2026-11-01T00:00:00Z" }])[0]).toMatchObject({ source: "sentry", id: "1", title: "A", userCount: 3, eventCount: 10 })
    expect(mapSentryList({ issues: [{ shortId: "PROJ-7", culprit: "x" }] })[0]).toMatchObject({ id: "PROJ-7", title: "x" })
    expect(mapSentryList("- ID: `12345` — TypeError in cart\n- ID: `67890` — RangeError")).toHaveLength(2)
  })
})

describe("crashlytics adapter", () => {
  test("maps issue + sample event (android)", () => {
    const crash = mapCrashlyticsIssue(fixture("crashlytics/get_issue.android.json"), fixture("crashlytics/batch_get_events.android.json"), { id: "deadbeef", appId: "1:123:android:abc", hints: { appPackage: "com.example.app" } })
    expect(crash.source).toBe("crashlytics")
    expect(crash.platform).toBe("android")
    expect(crash.language).toBe("jvm")
    expect(crash.exceptionType).toBe("java.lang.NullPointerException")
    expect(crash.frames[0]).toMatchObject({ file: "CartRepository.kt", line: 88, function: "com.example.app.cart.CartRepository.load", inApp: true })
    expect(crash.frames.find((f) => f.module?.startsWith("android."))?.inApp).toBe(false)
    expect(crash.userCount).toBe(612)
    expect(crash.appVersion).toBe("3.2.0")
    expect(crash.device?.model).toBe("Pixel 7")
    expect(crash.url).toContain("console.firebase.google.com")
  })

  test("maps a flutter event with package: frames", () => {
    const crash = mapCrashlyticsIssue({ title: "Null check operator used on a null value", displayVersion: "3.1.9" }, fixture("crashlytics/batch_get_events.flutter.json"), { id: "f1", appId: "1:123:ios:abc", hints: { appPackage: "my_app" } })
    expect(crash.language).toBe("dart")
    expect(crash.frames[0]).toMatchObject({ file: "ui/checkout_page.dart", package: "my_app", line: 301, inApp: true })
    expect(crash.frames.find((f) => f.file?.startsWith("src/widgets"))?.inApp).toBe(false)
  })

  test("unsymbolicated ios frames are flagged", () => {
    const crash = mapCrashlyticsIssue({ title: "EXC_BAD_ACCESS" }, fixture("crashlytics/batch_get_events.ios.unsymbolicated.json"), { id: "i1", appId: "1:123:ios:abc", hints: {} })
    expect(crash.language).toBe("apple")
    expect(crash.symbolication).toBe("unsymbolicated")
  })

  test("list mapping and platform parsing", () => {
    const list = mapCrashlyticsList(fixture("crashlytics/get_report.topIssues.json"))
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ source: "crashlytics", id: "deadbeef", userCount: 612 })
    expect(platformOfAppId("1:123:ios:abc")).toBe("ios")
    expect(platformOfAppId(undefined)).toBeUndefined()
  })
})

describe("manual source", () => {
  test("builds a crash from text with a stable id", () => {
    const text = readFileSync(join(import.meta.dir, "fixtures", "traces", "node.txt"), "utf8")
    const a = crashFromText({ text, title: "Cart crash" })
    const b = crashFromText({ text })
    expect(a.id).toBe(b.id)
    expect(a.title).toBe("Cart crash")
    expect(b.title).toContain("TypeError")
    expect(a.frames.length).toBeGreaterThan(0)
    expect(a.source).toBe("manual")
  })
})
