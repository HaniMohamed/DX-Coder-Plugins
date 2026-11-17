// The crash list and the crash fetch go through agent sessions: the lister / fixer makes the MCP
// calls the plugin planned and hands the raw replies back; the plugin maps them with the same
// fixtures the adapters are tested with.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { presentList, runFix, runList, runTop } from "../src/flows.js"
import { slug } from "../src/git.js"
import { readOptions } from "../src/options.js"
import type { Runtime } from "../src/progress.js"
import { registerPluginTools, type CrashListRecord } from "../src/tools.js"
import type { Crash, RunRecord, WorkerInfo } from "../src/types.js"
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
  for (let guard = 0; guard < 6; guard++) {
    const reply = await stage(prompt, session, tool)
    if (!reply || !/CONTINUE:/.test(reply)) return
  }
}

/** One stage of the scripted agent; returns the tool reply so the loop can honour CONTINUE / STOP. */
const stage = async (prompt: { text: string }, session: { id: string }, tool: (name: string) => { execute: (input: unknown, ctx: ReturnType<typeof toolCtx>) => Promise<{ output?: unknown; content?: string }> }): Promise<string | undefined> => {
  const w = mock.storage.get(`fixora/worker/${session.id}`) as WorkerInfo
  const call = async (name: string, input: unknown) => {
    const r = await tool(name).execute(input, toolCtx(session.id))
    if ((r.output as { ok?: boolean }).ok !== true) throw new Error(`${name} rejected: ${r.content}`)
    return r.content ?? ""
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
    return call("fixora_submit_crashes", { version: 1, requestId: w.requestId, results })
  }
  if (w.phase === "crash") {
    const runId = w.runId!
    if (/sentry_get_issue_details/.test(prompt.text)) {
      // First attempt: the issue only, no frames → the tool asks for the follow-up; then the event.
      const r = await tool("fixora_submit_crash").execute({ version: 1, runId, source: "sentry", issue: { id: "4523123", title: "TypeError", permalink: "https://acme.sentry.io/issues/4523123/" } }, toolCtx(session.id))
      expect((r.output as { ok: boolean }).ok).toBe(false)
      expect(r.content).toContain("sentry_search_errors")
      return call("fixora_submit_crash", { version: 1, runId, source: "sentry", issue: { id: "4523123", title: "TypeError", permalink: "https://acme.sentry.io/issues/4523123/" }, events: fixture("sentry/get_issue_details.node.json") })
    }
    return call("fixora_submit_crash", { version: 1, runId, source: "crashlytics", appId: ANDROID, issue: text("crashlytics/get_issue.v15.yaml"), events: text("crashlytics/batch_get_events.v15.yaml") })
  }
  if (w.phase === "prepare") {
    // A `{ticket}` branch template puts the Jira step before the branch: report the ticket, then stop at base-missing.
    if (/Before creating the branch \(the name needs the ticket key\)/.test(prompt.text)) {
      await call("fixora_submit_ticket", { version: 1, runId: w.runId, action: "created", key: "DE-456", url: "https://jira.example.com/browse/DE-456" })
    }
    return call("fixora_submit_prepare", { version: 1, runId: w.runId, stage: "inspect", blocked: "base-missing", blockedDetail: "fatal: couldn't find remote ref main", conventionFiles: [], notes: [] })
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
    const lister = [...mock.sessions.values()].find((s) => s.title === "Fixora · crash list")!
    expect(lister.location?.directory).toBe(join(root, "repo"))
    expect(mock.storage.get(`fixora/worker/${lister.id}`)).toMatchObject({ role: "lister", phase: "crashes" })
    // Second call within the cache window: no new prompt.
    const again = await runList(rt, { sessionID: "origin", top: 5 })
    expect(listerPrompts).toHaveLength(1)
    expect(again.crashes).toHaveLength(3)
    await runList(rt, { sessionID: "origin", top: 5, refresh: true })
    expect(listerPrompts).toHaveLength(2)
  })

  test("--platform plans only that platform's Firebase app, skips Sentry and has its own cache entry", async () => {
    const before = listerPrompts.length
    const android = await runList(rt, { sessionID: "origin", top: 5, platform: "android" })
    expect(listerPrompts).toHaveLength(before + 1)
    const prompt = listerPrompts[before]!
    expect(prompt).toContain(`"appId": "${ANDROID}"`)
    expect(prompt).not.toContain(IOS)
    expect(prompt).not.toContain("sentry_search_issues")
    expect(android.crashes.every((c) => c.source === "crashlytics" && c.platform === "android")).toBe(true)
    expect(android.crashes.length).toBeGreaterThan(0)
    expect(android.errors).toEqual([])
    expect(android.markdown).toContain("android only")
    // The platform is part of the cache key: the plain list does not reuse the android-only result, and vice versa.
    await runList(rt, { sessionID: "origin", top: 5, platform: "android" })
    expect(listerPrompts).toHaveLength(before + 1)
    const ios = await runList(rt, { sessionID: "origin", top: 5, platform: "ios" })
    expect(listerPrompts).toHaveLength(before + 2)
    expect(ios.crashes).toEqual([])
    expect(ios.errors).toEqual([`crashlytics (${IOS}): PERMISSION_DENIED`])
    await expect(runList(rt, { sessionID: "origin", top: 5, platform: "web" })).rejects.toThrow(/no web app is configured/)
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
    // One work turn: fetch → prepare → analyse → fix, steered by the tool replies (it stopped at prepare).
    expect(fixer.prompts).toHaveLength(1)
    expect(fixer.prompts[0]!.skills?.map((s) => s.id)).toEqual(["fixora-crashes", "fixora-prepare", "fixora-triage", "fixora-fix"])
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

  test("a {ticket} branch template: the crash is fetched in its own turn, the ticket is created before the branch without a dialog, the name carries its key", async () => {
    const saved = { opts: rt.opts, tools: [...mock.mcpTools] }
    mock.mcpTools.push(fakeMcpTool("jira_jira_search", { jql: {} }), fakeMcpTool("jira_jira_create_issue", { project_key: {}, summary: {}, issue_type: {}, description: {}, additional_fields: {} }), fakeMcpTool("jira_jira_get_issue", { issue_key: {} }))
    mock.mcpServers.push({ name: "jira", status: "connected" })
    const options = { crashlytics: { appIds: [ANDROID, IOS] }, jira: { project: "DE" }, branchNaming: { template: "{type}/{ticket}-{slug}", type: "fix" } }
    const parsed = readOptions(options)
    if (!parsed.ok) throw new Error(parsed.errors.join())
    rt.opts = parsed.value
    try {
      const run = await runFix(rt, { sessionID: "origin", ref: `crashlytics:fedcba9876543210fedcba9876543210@${ANDROID}`, flags: { dryRun: false, ticket: true, mr: true, push: true, auto: false, force: false, forceTriage: false } })
      expect(run.status).toBe("blocked")
      expect(run.blockedReason).toBe("base-missing")
      expect(run.timings.fetch?.status).toBe("ok")
      expect(run.jiraKey).toBe("DE-456")
      expect(run.approvals.ticket).toBe("auto")
      // The ticket row of the panel closed from inside the prepare turn, without resetting the rows after it.
      expect(run.timings.ticket).toMatchObject({ status: "ok", attempts: 1 })
      // The fixer session was renamed as the run learned its crash title and ticket key.
      expect(mock.sessions.get(run.sessions.fixer!)!.title).toBe(`Fixora fix · DE-456 · ${run.title}`)
      expect(mock.rpcEvents.filter((e) => e.name === "run.stage" && (e.data as { step: string }).step === "ticket").map((e) => (e.data as { status: string }).status)).toEqual(["ok"])
      expect(mock.permissionRequests.filter((p) => p.action === "fixora.ticket")).toHaveLength(0) // the ticket never asks
      expect(run.meta?.plannedBranch).toBe(`fixora/fix/<key>-${slug(run.title, 32)}`)
      const fixer = mock.sessions.get(run.sessions.fixer!)!
      // Turn 1: fetch only (the ticket needs the crash). Turn 2: prepare → analyse → fix with the ticket step first.
      expect(fixer.prompts.map((p) => p.skills?.map((s) => s.id))).toEqual([["fixora-crashes"], ["fixora-prepare", "fixora-triage", "fixora-fix"]])
      expect(fixer.prompts[1]!.text).toContain("`fixora/fix/<key>-")
      expect(fixer.prompts[1]!.text).toContain("tools.jira.jira_create_issue")
      expect(fixer.prompts[1]!.text).toContain('"project_key": "DE"')
      expect(readFileSync(join(run.folder, "ticket-preview.md"), "utf8")).toContain("h2. Stack trace")
      // The failure message carries the reason the last prepare report was refused (none here: base-missing was accepted).
      expect(run.error).not.toContain("Last report refused")
    } finally {
      rt.opts = saved.opts
      mock.mcpTools.length = 0
      mock.mcpTools.push(...saved.tools)
      mock.mcpServers.pop()
    }
  })
})

describe("the crash list marks what Fixora already did", () => {
  test("runs from earlier fixes are shown with state, label and links; the picker only offers the rest", async () => {
    // The fetch tests above left three blocked runs (base branch missing); pretend one of them went all the way.
    const sentry = mock.storage.get("fixora/run/sentry-4523123") as RunRecord
    sentry.status = "done"
    sentry.step = "done"
    sentry.jiraKey = "DE-100"
    sentry.jiraUrl = "https://jira.example.com/browse/DE-100"
    sentry.mrUrl = "https://gitlab.example.com/acme/shop/-/merge_requests/7"
    sentry.mrId = "7"
    sentry.mrProvider = "gitlab-mcp"
    sentry.mrStatus = "merged"
    sentry.meta = { ...sentry.meta, mergedAt: "2026-11-01T00:00:00.000Z" }
    mock.storage.set("fixora/run/sentry-4523123", sentry)

    const list = await runList(rt, { sessionID: "origin", top: 5, refresh: true })
    const byId = Object.fromEntries(list.crashes.map((c) => [c.id, c]))
    expect(byId["4523123"]).toMatchObject({ state: "merged", runId: "sentry-4523123", fix: { label: "fixed · MR !7 merged", jiraKey: "DE-100", mrRef: "MR !7", mrStatus: "merged", stillSeen: true } })
    expect(byId["0123456789abcdef0123456789abcdef"]).toMatchObject({ state: "failed", fix: { label: "blocked at prepare (base-missing)" } })
    expect(byId["fedcba9876543210fedcba9876543210"]).toMatchObject({ state: "failed", fix: { jiraKey: "DE-456", jiraUrl: "https://jira.example.com/browse/DE-456" } })
    expect(list.markdown).toContain("1 of 3 already fixed by Fixora (1 merged) · 2 failed.")
    expect(list.markdown).toContain("[DE-100](https://jira.example.com/browse/DE-100) · [MR !7 merged](https://gitlab.example.com/acme/shop/-/merge_requests/7)")
    expect(list.markdown).toContain("**Already handled by Fixora**")
    expect(list.markdown).toContain("⚠ still seen")

    await presentList(rt, "origin", list)
    const text = mock.synthetics.at(-1)!.text
    expect(text).toContain("Which crash should Fixora fix?")
    expect(text).toContain(`crashlytics:0123456789abcdef0123456789abcdef@${ANDROID}`)
    expect(text).toContain("Do NOT offer these 1 crash(es)")
    expect(text).toContain("sentry:4523123 = fixed · MR !7 merged")
    expect(text).toContain("Fix the top 2")

    // `/fixora top` skips the fixed one and takes the failed ones (retryable) in order.
    const top = await runTop(rt, { sessionID: "origin", count: 5, flags: { dryRun: true, ticket: false, mr: false, push: false, auto: false, force: false, forceTriage: false } }).catch((e: Error) => e.message)
    expect(typeof top === "string" ? top : JSON.stringify(top)).not.toContain("sentry:4523123")
  })
})
