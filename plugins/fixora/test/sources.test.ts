import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULTS } from "../src/options.js"
import { parseToolText } from "../src/mcp.js"
import { crashlytics, crashlyticsRef, hasIssue, mapCrashlyticsIssue, mapCrashlyticsList, parseFormattedFrames, platformOfAppId, sampleEventOf } from "../src/sources/crashlytics.js"
import type { SourceContext } from "../src/sources/types.js"
import { interpretCrashList, listPlans, resolveRef, runIdFor } from "../src/sources/index.js"
import { crashFromText } from "../src/sources/manual.js"
import { mapSentryIssue, mapSentryList, sentry, stackFromMarkdown } from "../src/sources/sentry.js"

const fixture = (p: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", p), "utf8")) as unknown

describe("resolveRef", () => {
  test("source:id, URLs, manual", () => {
    expect(resolveRef("sentry:12345", DEFAULTS)).toEqual({ source: "sentry", id: "12345", extra: undefined })
    expect(resolveRef("https://acme.sentry.io/issues/12345/", DEFAULTS)).toMatchObject({ source: "sentry", id: "12345", extra: { org: "acme" } })
    expect(resolveRef("https://sentry.io/organizations/acme/issues/777/?project=1", DEFAULTS)).toMatchObject({ source: "sentry", id: "777", extra: { org: "acme" } })
    expect(resolveRef("crashlytics:abc_DEF-1", DEFAULTS)).toMatchObject({ source: "crashlytics", id: "abc_DEF-1" })
    expect(resolveRef("https://console.firebase.google.com/project/my-proj/crashlytics/app/1:123:android:abc/issues/deadbeef", DEFAULTS)).toMatchObject({ source: "crashlytics", id: "deadbeef", extra: { appId: "1:123:android:abc", project: "my-proj" } })
    expect(resolveRef("crashlytics:deadbeef@1:10866044419:ios:6b0c10a898bd6acdbba836", DEFAULTS)).toEqual({ source: "crashlytics", id: "deadbeef", extra: { appId: "1:10866044419:ios:6b0c10a898bd6acdbba836" } })
    expect(resolveRef("crashlytics:deadbeef", DEFAULTS)).toEqual({ source: "crashlytics", id: "deadbeef", extra: undefined })
    expect(resolveRef("https://console.firebase.google.com/v1/appid/project/taminaty-2e06a/crashlytics/app/1:10866044419:ios:6b0c10a898bd6acdbba836/issues/88cbff17cf699dfe71d7f529d3f0b704?&time=1793410611000:1794620211000", DEFAULTS)).toMatchObject({ source: "crashlytics", id: "88cbff17cf699dfe71d7f529d3f0b704", extra: { appId: "1:10866044419:ios:6b0c10a898bd6acdbba836", project: "taminaty-2e06a" } })
    expect(crashlyticsRef("deadbeef")).toBe("crashlytics:deadbeef")
    expect(crashlyticsRef("deadbeef", "1:1:ios:a")).toBe("crashlytics:deadbeef@1:1:ios:a")
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

describe("crashlytics plans across several apps (the agent makes the calls)", () => {
  const ANDROID = "1:10866044419:android:6352c04266dbc3babba836"
  const IOS = "1:10866044419:ios:6b0c10a898bd6acdbba836"
  const sc = (appIds: string[], props: Record<string, Record<string, unknown>> = {}): SourceContext => ({
    options: { ...DEFAULTS, crashlytics: { appIds } },
    services: {
      crashlytics: { id: "crashlytics", namespace: "firebase", serverName: "firebase", status: "connected", toolIds: [], capabilities: { getReport: "firebase_crashlytics_get_report", getIssue: "firebase_crashlytics_get_issue", batchGetEvents: "firebase_crashlytics_batch_get_events", listEvents: "firebase_crashlytics_list_events" } },
      sentry: { id: "sentry", namespace: "sentry", serverName: "sentry", status: "connected", toolIds: [], capabilities: { getIssue: "sentry_get_issue_details", searchIssues: "sentry_search_issues", searchErrors: "sentry_search_errors" } },
    },
    toolProps: (id) => props[id] ?? {},
  })

  test("listPlan: one report call per app with the window filter; interpretCrashList tags platform and app-qualified refs", () => {
    const { plans, errors } = listPlans(sc([ANDROID, IOS]), { top: 5 })
    expect(errors).toEqual([])
    const cl = plans.find((p) => p.source === "crashlytics")!
    expect(cl.calls.map((c) => c.appId)).toEqual([ANDROID, IOS])
    expect(cl.calls[0]!.input).toMatchObject({ appId: ANDROID, report: "topIssues", pageSize: 5, filter: { issueErrorTypes: ["FATAL"] } })
    expect(plans.find((p) => p.source === "sentry")!.calls[0]!.input).toMatchObject({ query: "is:unresolved level:error", limit: 5 })
    const list = interpretCrashList(
      [
        { source: "crashlytics", toolId: "firebase_crashlytics_get_report", appId: ANDROID, raw: { issues: [{ id: "a1", title: "NPE", issueStats: { userCount: 10 } }] } },
        { source: "crashlytics", toolId: "firebase_crashlytics_get_report", appId: IOS, raw: { issues: [{ id: "i1", title: "EXC_BAD_ACCESS", issueStats: { userCount: 40 } }, { id: "shared", title: "Null check", issueStats: { userCount: 3 } }] } },
        { source: "sentry", toolId: "sentry_search_issues", error: "401" },
      ],
      sc([ANDROID, IOS]),
      { top: 5 },
    )
    expect(list.crashes.map((c) => [c.id, c.platform, c.ref])).toEqual([
      ["i1", "ios", `crashlytics:i1@${IOS}`],
      ["a1", "android", `crashlytics:a1@${ANDROID}`],
      ["shared", "ios", `crashlytics:shared@${IOS}`],
    ])
    expect(list.crashes[0]!.url).toContain(`/app/${IOS}/issues/i1`)
    expect(list.errors).toEqual(["sentry: 401"])
    // A single app keeps the short reference.
    const single = interpretCrashList([{ source: "crashlytics", toolId: "x", appId: ANDROID, raw: { issues: [{ id: "a1", title: "NPE" }] } }], sc([ANDROID]), { top: 5 })
    expect(single.crashes.map((c) => c.ref)).toEqual(["crashlytics:a1"])
    expect(() => listPlans(sc([]), { top: 5 })).not.toThrow()
    expect(listPlans(sc([]), { top: 5 }).errors[0]).toContain("Firebase app id")
  })

  test("fetchPlan: the app from the reference, else every configured app in order; follow-ups carry placeholders", () => {
    const direct = crashlytics.fetchPlan!(sc([ANDROID, IOS]), "i1", { appId: IOS })
    expect(direct.primary.map((c) => c.appId)).toEqual([IOS])
    expect(direct.primary[0]!.input).toEqual({ appId: IOS, issueId: "i1" })
    expect(direct.followUps[0]!.toolId).toBe("firebase_crashlytics_batch_get_events")
    expect(JSON.stringify(direct.followUps[0]!.input)).toContain("sampleEvent")
    expect(direct.note).toContain(`Report \`appId\` as ${IOS}`)
    const probed = crashlytics.fetchPlan!(sc([ANDROID, IOS]), "i1")
    expect(probed.primary.map((c) => c.appId)).toEqual([ANDROID, IOS])
    expect(probed.note).toContain("stop at the first reply")
    expect(JSON.stringify(probed.followUps[0]!.input)).toContain("<appId of the app")
    expect(() => crashlytics.fetchPlan!(sc([]), "a1")).toThrow("Firebase app id")
    // Snake-case schema (older firebase-tools) is honoured.
    const snake = crashlytics.fetchPlan!(sc([ANDROID], { firebase_crashlytics_get_issue: { app_id: {}, issue_id: {} } }), "x")
    expect(snake.primary[0]!.input).toEqual({ app_id: ANDROID, issue_id: "x" })
  })

  test("mapCrash: needs the app for several apps, rejects a not-found issue reply", () => {
    const ctx = sc([ANDROID, IOS])
    expect(() => crashlytics.mapCrash!({ issue: { id: "i1", title: "x" } }, ctx, "i1")).toThrow("report the `appId`")
    expect(() => crashlytics.mapCrash!({ appId: IOS, issue: "Issue not found" }, ctx, "i1")).toThrow("does not describe issue")
    expect(() => crashlytics.mapCrash!({ appId: "1:1:web:zz", issue: { id: "i1" } }, ctx, "i1")).toThrow("not one of the configured apps")
    const crash = crashlytics.mapCrash!({ appId: IOS, issue: { id: "i1", title: "EXC_BAD_ACCESS" }, events: fixture("crashlytics/batch_get_events.ios.unsymbolicated.json") }, ctx, "i1")
    expect(crash.appId).toBe(IOS)
    expect(crash.platform).toBe("ios")
    expect(crash.symbolication).toBe("unsymbolicated")
  })

  test("sentry plans and mapCrash use the organisation and the sample event", () => {
    const ctx = { ...sc([ANDROID]), options: { ...DEFAULTS, sentry: { organization: "acme", project: "shop" } } }
    const plan = sentry.fetchPlan!(ctx, "4523123", { org: "other" })
    expect(plan.primary[0]).toMatchObject({ toolId: "sentry_get_issue_details", input: { organizationSlug: "other", projectSlugOrId: "shop", issueId: "4523123" } })
    expect(plan.followUps[0]!.toolId).toBe("sentry_search_errors")
    const summaryOnly = sentry.mapCrash!({ issue: { id: "4523123", title: "TypeError" } }, ctx, "4523123")
    expect(summaryOnly.frames).toHaveLength(0)
    const withEvent = sentry.mapCrash!({ issue: { id: "4523123", title: "TypeError" }, events: fixture("sentry/get_issue_details.node.json") }, ctx, "4523123")
    expect(withEvent.frames[0]).toMatchObject({ file: "src/cart/service.ts", line: 88 })
    expect(sentry.annotatePlan!(ctx, "1", { text: "hi" })).toBeUndefined() // no updateIssue capability in this context
  })

  test("hasIssue", () => {
    expect(hasIssue({ id: "x" })).toBe(true)
    expect(hasIssue({ issue: { name: "projects/p/apps/a/issues/x" } })).toBe(true)
    expect(hasIssue("Issue not found")).toBe(false)
    expect(hasIssue({ error: { code: 404 } })).toBe(false)
    expect(hasIssue({})).toBe(false)
  })
})

describe("crashlytics via firebase-tools 15 (YAML text, camelCase schema)", () => {
  const text = (p: string) => readFileSync(join(import.meta.dir, "fixtures", p), "utf8")

  test("top issues report: nested YAML groups, metrics, versions", () => {
    const list = mapCrashlyticsList(text("crashlytics/get_report.topIssues.v15.yaml"))
    expect(list.map((c) => [c.id, c.userCount, c.eventCount, c.appVersion])).toEqual([
      ["0123456789abcdef0123456789abcdef", 612, 1402, "3.1.9"],
      ["fedcba9876543210fedcba9876543210", 97, 200, "3.1.8"],
    ])
    expect(list[0]!.title).toBe("Null check operator used on a null value")
    expect(list[0]!.url).toContain("/issues/0123456789abcdef0123456789abcdef")
  })

  test("issue + sample event: text-formatted exceptions become frames with Dart packages", () => {
    const issue = parseToolText(text("crashlytics/get_issue.v15.yaml"))
    expect(hasIssue(issue)).toBe(true)
    expect(sampleEventOf(issue)).toBe("projects/10866044419/apps/1:10866044419:android:6352c04266dbc3babba836/events/evt-1")
    const events = parseToolText(text("crashlytics/batch_get_events.v15.yaml"))
    const crash = mapCrashlyticsIssue(issue, events, { id: "0123456789abcdef0123456789abcdef", appId: "1:10866044419:android:6352c04266dbc3babba836", hints: { appPackage: "taminaty", inAppPrefixes: ["gosi_core"] } })
    expect(crash.language).toBe("dart")
    expect(crash.platform).toBe("android")
    expect(crash.exceptionType).toBe("_TypeError")
    expect(crash.message).toBe("Null check operator used on a null value")
    expect(crash.appVersion).toBe("3.1.9")
    expect(crash.buildNumber).toBe("319")
    expect(crash.frames.map((f) => [f.package, f.file, f.line, f.inApp])).toEqual([
      ["taminaty", "ui/checkout_page.dart", 301, true],
      ["taminaty", "ui/checkout_page.dart", 287, true],
      ["gosi_core", "src/cart_repository.dart", 42, true],
      ["flutter", "src/widgets/framework.dart", 5080, false],
      [undefined, "dart:async/zone.dart", 1399, false],
    ])
    expect(crash.frames[1]!.function).toBe("_CheckoutPageState._submit(bool)")
    expect(crash.device).toMatchObject({ model: "SM-G991B", os: "Android 14" })
    expect(crash.url).toContain("console.firebase.google.com")
    expect(crash.rawStackTrace).toContain("at _CheckoutPageState.build")
  })

  test("parseFormattedFrames: caused-by blocks, crashed threads, omitted marker", () => {
    const { blocks } = parseFormattedFrames("Thread: worker\nat a.b (A.kt:1)\n\nThread: main (crashed)\nat -[ViewController viewDidLoad] (ViewController.m:42)\nat Foo.bar(int)\n... frames omitted ...\n\nCaused by: java.io.IOException: disk full\nat java.io.File.write (File.java:10)")
    expect(blocks.map((b) => [b.crashed, b.type, b.message, b.frames.length])).toEqual([
      [false, undefined, undefined, 1],
      [true, undefined, undefined, 2],
      [false, "java.io.IOException", "disk full", 1],
    ])
    expect(blocks[1]!.frames[0]).toEqual({ symbol: "-[ViewController viewDidLoad]", file: "ViewController.m", line: 42 })
    expect(blocks[1]!.frames[1]).toEqual({ symbol: "Foo.bar(int)", file: undefined, line: undefined })
  })
})
