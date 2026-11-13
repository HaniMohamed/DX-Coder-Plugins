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
    expect(r.value).toEqual({ ...DEFAULTS, worker: { ...DEFAULTS.worker, model: undefined }, review: { mode: "session", model: undefined }, testCommands: { ...DEFAULTS.testCommands, unit: undefined, integration: undefined, lint: undefined, typecheck: undefined }, jira: { ...DEFAULTS.jira, project: undefined, url: undefined, token: undefined, username: undefined, password: undefined, sslVerify: undefined }, mr: { ...DEFAULTS.mr, target: undefined, forge: undefined }, crashlytics: { appId: undefined }, sentry: { organization: undefined, project: undefined }, appPackage: undefined, worktree: { root: undefined, keep: "until-merged" } })
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

  test("parseModelRef", () => {
    expect(parseModelRef("anthropic/claude-sonnet-4-5")).toEqual({ providerID: "anthropic", id: "claude-sonnet-4-5" })
    expect(parseModelRef("x")).toBeUndefined()
    expect(parseModelRef("x/")).toBeUndefined()
  })
})
