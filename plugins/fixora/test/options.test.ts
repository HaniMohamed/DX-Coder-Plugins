import { describe, expect, test } from "bun:test"
import { DEFAULTS, parseModelRef, readOptions } from "../src/options.js"

describe("readOptions", () => {
  test("defaults when empty", () => {
    const r = readOptions(undefined)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.baseBranch).toBe("main")
    expect(r.value.worker.agent).toBe("build")
    expect(r.value.approvals).toBe("publish")
    expect(r.value.mr.draft).toBe(true)
    expect(r.value.branchPrefix).toBe("fixora/")
    expect(r.value).toEqual({ ...DEFAULTS, worker: { ...DEFAULTS.worker, model: undefined }, review: { mode: "session", model: undefined }, testCommands: { ...DEFAULTS.testCommands, unit: undefined, integration: undefined, lint: undefined, typecheck: undefined }, jira: { ...DEFAULTS.jira, project: undefined, parent: undefined, url: undefined, token: undefined, username: undefined, password: undefined, sslVerify: undefined }, mr: { ...DEFAULTS.mr, target: undefined, forge: undefined }, crashlytics: { appIds: [] }, sentry: { organization: undefined, project: undefined }, appPackage: undefined, worktree: { root: undefined, keep: "until-merged" } })
  })

  test("accepts overrides and normalises the prefix", () => {
    const r = readOptions({ baseBranch: "develop", branchPrefix: "/bots/fixora//", worker: { model: "openai/gpt-5", shell: "ask" }, jira: { project: "APP", transitionOnMr: null }, approvals: "each", mode: "test-first", testCommands: { unit: "bun test", lint: "" }, sources: ["sentry"] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.branchPrefix).toBe("bots/fixora/")
    expect(r.value.worker.model).toEqual({ providerID: "openai", id: "gpt-5" })
    expect(r.value.worker.shell).toBe("ask")
    expect(r.value.jira.project).toBe("APP")
    expect(r.value.jira.transitionOnMr).toBeUndefined()
    expect(r.value.approvals).toBe("each")
    expect(r.value.mode).toBe("test-first")
    expect(r.value.testCommands.unit).toBe("bun test")
    expect(r.value.sources).toEqual(["sentry"])
  })

  test("reports every invalid value", () => {
    const r = readOptions({ baseBranch: 5, approvals: "maybe", maxFixRounds: 1.5, confidence: { minToFix: 2 }, worker: { model: "nope" }, allowSecretPatterns: ["("], sources: ["jira"], branchPrefix: "main" })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join("\n")).toContain("baseBranch must be a string")
    expect(r.errors.join("\n")).toContain("approvals must be one of")
    expect(r.errors.join("\n")).toContain("maxFixRounds must be an integer")
    expect(r.errors.join("\n")).toContain("confidence.minToFix must be <= 1")
    expect(r.errors.join("\n")).toContain("worker.model must be")
    expect(r.errors.join("\n")).toContain("invalid regex")
    expect(r.errors.join("\n")).toContain("unknown source")
    expect(r.errors.join("\n")).toContain("protected branch")
  })

  test("crashlytics app ids: string, array, both keys, validation", () => {
    const one = readOptions({ crashlytics: { appId: "1:123:android:abc" } })
    expect(one.ok && one.value.crashlytics.appIds).toEqual(["1:123:android:abc"])
    const many = readOptions({ crashlytics: { appId: ["1:123:android:abc", "1:123:ios:def"], appIds: ["1:123:ios:def", " 1:123:web:0a1 "] } })
    expect(many.ok && many.value.crashlytics.appIds).toEqual(["1:123:android:abc", "1:123:ios:def", "1:123:web:0a1"])
    const bad = readOptions({ crashlytics: { appIds: ["com.example.app"], appId: 5 } })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.errors.join("\n")).toContain("crashlytics.appIds contains an invalid Firebase app id")
    expect(bad.errors.join("\n")).toContain("crashlytics.appId must be a string or an array of strings")
  })

  test("jira.parent enables sub-tasks and is validated", () => {
    const sub = readOptions({ jira: { project: "DE", issueType: "Sub-task", parent: "DE-62556" } })
    expect(sub.ok && sub.value.jira).toMatchObject({ project: "DE", issueType: "Sub-task", parent: "DE-62556" })
    const noParent = readOptions({ jira: { project: "DE", issueType: "Subtask" } })
    expect(!noParent.ok && noParent.errors.join("\n")).toContain('needs "jira": { "parent"')
    const badKey = readOptions({ jira: { project: "DE", parent: "story 62556" } })
    expect(!badKey.ok && badKey.errors.join("\n")).toContain("jira.parent must be an issue key")
  })

  test("parseModelRef", () => {
    expect(parseModelRef("anthropic/claude-sonnet-4-5")).toEqual({ providerID: "anthropic", id: "claude-sonnet-4-5" })
    expect(parseModelRef("x")).toBeUndefined()
    expect(parseModelRef("x/")).toBeUndefined()
  })
})
