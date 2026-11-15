// The crash list and the crash fetch go through agent sessions: the lister / fixer makes the MCP
// calls the plugin planned and hands the raw replies back; the plugin maps them with the same
// fixtures the adapters are tested with.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runFix, runList } from "../src/flows.js"
import { readOptions } from "../src/options.js"
import type { Runtime } from "../src/progress.js"
import { registerPluginTools, type CrashListRecord } from "../src/tools.js"
import type { Crash, WorkerInfo } from "../src/types.js"
import { fakeMcpTool, mockCtx, toolCtx, type MockCtx, type Worker } from "./mock-ctx.js"

const fixture = (p: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", p), "utf8")) as unknown
const text = (p: string) => readFileSync(join(import.meta.dir, "fixtures", p), "utf8")

const ANDROID = "1:10866044419:android:6352c04266dbc3babba836"
const IOS = "1:10866044419:ios:6b0c10a898bd6acdbba836"

let root: string
let mock: MockCtx
let rt: Runtime
const listerPrompts: string[] = []

const worker: Worker = async (prompt, session, tool) => {
  const w = mock.storage.get(`fixora/worker/${session.id}`) as WorkerInfo
  const call = async (name: string, input: unknown) => {
    const r = await tool(name).execute(input, toolCtx(session.id))
    if ((r.output as { ok?: boolean }).ok !== true) throw new Error(`${name} rejected: ${r.content}`)
    return r
  }
  if (w.phase === "crashes") {
    listerPrompts.push(prompt.text)
    const record = mock.storage.get(`fixora/crashes/${w.requestId}`) as CrashListRecord
    const results = record.plans.flatMap((p) =>
      p.calls.map((c) => {
        if (p.source === "sentry") return { source: "sentry", toolId: c.toolId, raw: [{ id: "4523123", title: "TypeError in applyCoupon", userCount: 540, count: 1830, lastSeen: "2026-11-14T00:00:00Z", permalink: "https://acme.sentry.io/issues/4523123/" }] }
        if (c.appId === IOS) return { source: "crashlytics", toolId: c.toolId, appId: c.appId, error: "PERMISSION_DENIED" }
        return { source: "crashlytics", toolId: c.toolId, appId: c.appId, raw: text("crashlytics/get_report.topIssues.v15.yaml") }
      }),
    )
    await call("fixora_submit_crashes", { version: 1, requestId: w.requestId, results })
    return
  }
  if (w.phase === "crash") {
    const runId = w.runId!
    if (/sentry_get_issue_details/.test(prompt.text)) {
      // First attempt: the issue only, no frames → the tool asks for the follow-up; then the event.
      const r = await tool("fixora_submit_crash").execute({ version: 1, runId, source: "sentry", issue: { id: "4523123", title: "TypeError", permalink: "https://acme.sentry.io/issues/4523123/" } }, toolCtx(session.id))
      expect((r.output as { ok: boolean }).ok).toBe(false)
      expect(r.content).toContain("sentry_search_errors")
      await call("fixora_submit_crash", { version: 1, runId, source: "sentry", issue: { id: "4523123", title: "TypeError", permalink: "https://acme.sentry.io/issues/4523123/" }, events: fixture("sentry/get_issue_details.node.json") })
      return
    }
    await call("fixora_submit_crash", { version: 1, runId, source: "crashlytics", appId: ANDROID, issue: text("crashlytics/get_issue.v15.yaml"), events: text("crashlytics/batch_get_events.v15.yaml") })
    return
  }
  if (w.phase === "prepare") {
    await call("fixora_submit_prepare", { version: 1, runId: w.runId, stage: "inspect", blocked: "base-missing", blockedDetail: "fatal: couldn't find remote ref main", conventionFiles: [], notes: [] })
    return
  }
  throw new Error(`unexpected phase ${w.phase}`)
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fixora-crashes-"))
  await mkdir(join(root, "repo"), { recursive: true })
  const options = { crashlytics: { appIds: [ANDROID, IOS] }, sentry: { organization: "acme" }, appPackage: "taminaty", inAppPackages: ["gosi_core"] }
  mock = mockCtx({ directory: join(root, "repo"), options, worker })
  mock.mcpTools.push(
    fakeMcpTool("sentry_get_issue_details", { organizationSlug: {}, issueId: {} }),
    fakeMcpTool("sentry_search_issues", { organizationSlug: {}, naturalLanguageQuery: {} }),
    fakeMcpTool("sentry_search_errors", { organizationSlug: {}, naturalLanguageQuery: {} }),
    fakeMcpTool("firebase_crashlytics_get_issue", { appId: {}, issueId: {} }),
    fakeMcpTool("firebase_crashlytics_get_report", { appId: {}, report: {}, pageSize: {}, filter: {} }),
    fakeMcpTool("firebase_crashlytics_batch_get_events", { appId: {}, names: {} }),
  )
  mock.mcpServers.push({ name: "sentry", status: "connected" }, { name: "firebase", status: "connected" })
  const opts = readOptions(options)
  if (!opts.ok) throw new Error(opts.errors.join())
  rt = { ctx: mock.ctx, opts: opts.value, services: {}, emit: async (name, data) => void mock.rpcEvents.push({ name, data }), inflight: new Map(), lockPollMs: 5 }
  await registerPluginTools(mock.ctx, { rt: () => rt, isWorkerSession: async (id) => mock.sessions.has(id), start: async () => ({ started: [], errors: [] }) })
})
afterAll(() => rm(root, { recursive: true, force: true }))

describe("crash list through the lister session", () => {
  test("plans one call per source and app, maps the raw replies, keeps errors, caches", async () => {
    const list = await runList(rt, { sessionID: "origin", top: 5 })
    expect(listerPrompts).toHaveLength(1)
    expect(listerPrompts[0]).toContain("firebase_crashlytics_get_report")
    expect(listerPrompts[0]).toContain("sentry_search_issues")
    expect(listerPrompts[0]).toContain("CodeMode: `tools.firebase.crashlytics_get_report(input)`")
    expect(listerPrompts[0]).toContain("tools.fixora.submit_crashes(")
    // The large-reply tools are CodeMode tools so a script can forward replies by variable.
    expect(mock.tools.get("fixora_submit_crashes")!.options?.codemode).toBe(true)
    expect(mock.tools.get("fixora_submit_crash")!.options?.codemode).toBe(true)
    expect(mock.tools.get("fixora_submit_triage")!.options?.codemode).toBe(false)
    expect(listerPrompts[0]).toContain(`"appId": "${ANDROID}"`)
    expect(listerPrompts[0]).toContain('"report": "topIssues"')
    expect(list.crashes.map((c) => [c.source, c.id, c.userCount, c.ref])).toEqual([
      ["crashlytics", "0123456789abcdef0123456789abcdef", 612, `crashlytics:0123456789abcdef0123456789abcdef@${ANDROID}`],
      ["sentry", "4523123", 540, undefined],
      ["crashlytics", "fedcba9876543210fedcba9876543210", 97, `crashlytics:fedcba9876543210fedcba9876543210@${ANDROID}`],
    ])
    expect(list.crashes[0]!.platform).toBe("android")
    expect(list.errors).toEqual([`crashlytics (${IOS}): PERMISSION_DENIED`])
    expect(list.markdown).toContain("| 1 |")
    expect(existsSync(join(root, "repo", ".dxcoder", "fixora", "crashes.md"))).toBe(true)
    // The lister session is confined: no shell, read-only tools, created in the session's checkout.
    const lister = [...mock.sessions.values()].find((s) => s.title === "fixora: crash list")!
    expect(lister.location?.directory).toBe(join(root, "repo"))
    expect(mock.storage.get(`fixora/worker/${lister.id}`)).toMatchObject({ role: "lister", phase: "crashes" })
    // Second call within the cache window: no new prompt.
    const again = await runList(rt, { sessionID: "origin", top: 5 })
    expect(listerPrompts).toHaveLength(1)
    expect(again.crashes).toHaveLength(3)
    await runList(rt, { sessionID: "origin", top: 5, refresh: true })
    expect(listerPrompts).toHaveLength(2)
  })
})

describe("crash fetch through the fixer session", () => {
  test("sentry: the issue alone is refused until the sample event is fetched; the run then stops at prepare (base missing)", async () => {
    const run = await runFix(rt, { sessionID: "origin", ref: "sentry:4523123", flags: { dryRun: false, ticket: true, mr: true, push: true, auto: false, force: false, forceTriage: false } })
    expect(run.status).toBe("blocked")
    expect(run.blockedReason).toBe("base-missing")
    expect(run.step).toBe("prepare")
    expect(run.timings.fetch?.status).toBe("ok")
    const crash = JSON.parse(readFileSync(join(run.folder, "crash.json"), "utf8")) as Crash
    expect(crash.frames[0]).toMatchObject({ file: "src/cart/service.ts", line: 88, inApp: true })
    expect(crash.language).toBe("js")
    expect(run.fingerprint).toBe(crash.fingerprint)
    expect(run.title).toContain("TypeError")
    expect(readFileSync(join(run.folder, "crash.md"), "utf8")).toContain("src/cart/service.ts")
    const fixer = mock.sessions.get(run.sessions.fixer!)!
    expect(fixer.prompts.map((p) => p.skills?.[0]?.id)).toEqual(["fixora-crashes", "fixora-prepare"])
    expect(fixer.prompts[0]!.text).toContain("sentry_get_issue_details")
    expect(fixer.prompts[0]!.text).toContain('"organizationSlug": "acme"')
    expect(run.checkout.active).toBe(false)
    expect(mock.synthetics.at(-1)!.text).toContain('Base branch "main" was not found')
  })

  test("crashlytics v15: YAML replies are parsed by the plugin, the app id is recorded", async () => {
    const run = await runFix(rt, { sessionID: "origin", ref: `crashlytics:0123456789abcdef0123456789abcdef@${ANDROID}`, flags: { dryRun: false, ticket: true, mr: true, push: true, auto: false, force: false, forceTriage: false } })
    expect(run.timings.fetch?.status).toBe("ok")
    const crash = JSON.parse(readFileSync(join(run.folder, "crash.json"), "utf8")) as Crash
    expect(crash.language).toBe("dart")
    expect(crash.appId).toBe(ANDROID)
    expect(crash.frames[0]).toMatchObject({ file: "ui/checkout_page.dart", line: 301, inApp: true })
    expect(run.meta?.platform).toBe("android")
    const fixer = mock.sessions.get(run.sessions.fixer!)!
    expect(fixer.prompts[0]!.text).toContain("firebase_crashlytics_get_issue")
    expect(fixer.prompts[0]!.text).toContain("firebase_crashlytics_batch_get_events")
    expect(fixer.prompts[0]!.text).toContain(`Report \`appId\` as ${ANDROID}`)
  })
})
