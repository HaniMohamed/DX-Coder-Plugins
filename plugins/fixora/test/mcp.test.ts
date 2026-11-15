import { describe, expect, test } from "bun:test"
import { classifyTool, isWriteTool, matchServices, mcpNamespace, normalizeToolOutput, adaptInput, paramStyleOf, parseToolText, renderDoctor, renderToolSchema } from "../src/mcp.js"
import { pruneUndefined, prunedHandlers } from "../src/rpc.js"

describe("matchServices", () => {
  test("detects each service from tool ids, including odd server names", () => {
    const tools = [
      "sentry_get_issue_details",
      "sentry_search_issues",
      "sentry_update_issue",
      "firebase_crashlytics_get_issue",
      "firebase_crashlytics_batch_get_events",
      "firebase_crashlytics_create_note",
      "jira_jira_get_issue",
      "jira_jira_search",
      "jira_jira_create_issue",
      "My_GitLab_create_merge_request",
      "My_GitLab_get_merge_request",
      "github_create_pull_request",
      "read",
      "edit",
    ]
    const servers = [
      { name: "sentry", status: { status: "connected" } },
      { name: "firebase", status: "connected" },
      { name: "jira", status: { status: "needs_auth" } },
      { name: "My GitLab", status: "connected" },
      { name: "github", status: "failed" },
    ]
    const s = matchServices(tools, servers, new Map([["jira", { environment: { JIRA_URL: "https://jira.example.com" } }]]))
    expect(s.sentry).toMatchObject({ namespace: "sentry", status: "connected", capabilities: { getIssue: "sentry_get_issue_details", searchIssues: "sentry_search_issues", updateIssue: "sentry_update_issue" } })
    expect(s.crashlytics).toMatchObject({ namespace: "firebase", status: "connected", capabilities: { getIssue: "firebase_crashlytics_get_issue", batchGetEvents: "firebase_crashlytics_batch_get_events", createNote: "firebase_crashlytics_create_note" } })
    expect(s.jira).toMatchObject({ namespace: "jira", status: "needs_auth", environment: { JIRA_URL: "https://jira.example.com" }, capabilities: { createIssue: "jira_jira_create_issue" } })
    expect(s.gitlab).toMatchObject({ namespace: "My_GitLab", serverName: "My GitLab", status: "connected", capabilities: { createMr: "My_GitLab_create_merge_request", getMr: "My_GitLab_get_merge_request" } })
    expect(s.github).toMatchObject({ namespace: "github", status: "failed" })
  })

  test("nothing detected without probes; unknown status without server", () => {
    expect(matchServices(["read", "edit"], [])).toEqual({})
    const s = matchServices(["sentry_get_issue_details"], [])
    expect(s.sentry?.status).toBe("unknown")
  })

  test("mcpNamespace mirrors the host", () => {
    expect(mcpNamespace("my jira.server")).toBe("my_jira_server")
  })
})

describe("classifyTool / isWriteTool / paramStyleOf", () => {
  test("tools map to their service by namespace; writes are recognised by capability or name", () => {
    const services = matchServices(["sentry_get_issue_details", "sentry_update_issue", "firebase_crashlytics_get_issue", "firebase_crashlytics_create_note", "jira_jira_search", "jira_jira_create_issue", "gitlab_gitlab_create_mr", "gitlab_gitlab_get_mr"], [])
    expect(classifyTool("sentry_update_issue", services)).toMatchObject({ service: { id: "sentry" }, capability: "updateIssue" })
    expect(classifyTool("gitlab_gitlab_get_mr", services)).toMatchObject({ service: { id: "gitlab" }, capability: "getMr" })
    expect(classifyTool("firebase_crashlytics_list_events", services)).toMatchObject({ service: { id: "crashlytics" }, capability: undefined })
    expect(classifyTool("read", services)).toBeUndefined()
    expect(isWriteTool("sentry_update_issue", "updateIssue")).toBe(true)
    expect(isWriteTool("sentry_get_issue_details", "getIssue")).toBe(false)
    expect(isWriteTool("firebase_crashlytics_list_events")).toBe(false)
    expect(isWriteTool("firebase_crashlytics_delete_issue")).toBe(true)
    expect(isWriteTool("jira_jira_add_comment")).toBe(true)
    expect(paramStyleOf({ app_id: {}, issue_id: {} })).toBe("snake")
    expect(paramStyleOf({ appId: {} })).toBe("camel")
    expect(paramStyleOf({})).toBe("camel")
  })
})

describe("normalizeToolOutput", () => {
  test("prefers structured output, parses JSON text, joins text content", () => {
    expect(normalizeToolOutput({ output: { a: 1 } })).toEqual({ a: 1 })
    expect(normalizeToolOutput({ output: '{"a":1}' })).toEqual({ a: 1 })
    expect(normalizeToolOutput({ content: [{ type: "text", text: "## Issue" }, { type: "text", text: "body" }] })).toBe("## Issue\nbody")
    expect(normalizeToolOutput({ content: '[{"id":1}]' })).toEqual([{ id: 1 }])
    expect(normalizeToolOutput("plain")).toBe("plain")
  })
})

describe("renderDoctor", () => {
  test("explains a connected Firebase server without crashlytics tools", () => {
    const servers = [{ name: "firebase", status: { status: "connected" } }, { name: "jira", status: "connected" }]
    const toolIds = ["firebase_firebase_get_project", "firebase_firebase_list_apps", "jira_jira_get_issue", "jira_jira_search", "jira_jira_create_issue"]
    const services = matchServices(toolIds, servers)
    const out = renderDoctor({ servers, toolIds, services, options: { sources: ["crashlytics"], crashlytics: { appIds: ["1:1:android:a"] }, jira: { project: "DE", issueType: "Sub-task", parent: "DE-62556" } }, warnings: ["`worktree` is ignored: x"] })
    expect(out).toContain("**firebase** (connected) — 2 tool(s)")
    expect(out).toContain("### Ignored legacy options")
    expect(out).toContain("`worktree` is ignored")
    expect(out).toContain("crashlytics: not found")
    expect(out).toContain('jira: server "jira" (connected)')
    expect(out).toContain("DE / Sub-task under DE-62556")
    expect(out).toContain("### Likely fix")
    expect(out).toContain('"--only", "crashlytics"')
  })
  test("no fix section when crashlytics is detected", () => {
    const servers = [{ name: "firebase", status: { status: "connected" } }]
    const toolIds = ["firebase_crashlytics_get_issue", "firebase_crashlytics_get_report"]
    const out = renderDoctor({ servers, toolIds, services: matchServices(toolIds, servers), options: { sources: ["crashlytics"], crashlytics: { appIds: [] }, jira: { issueType: "Bug" } } })
    expect(out).toContain('crashlytics: server "firebase" (connected)')
    expect(out).not.toContain("Likely fix")
  })
})

describe("parseToolText", () => {
  test("JSON, YAML with nested YAML strings, scalars trimmed, text blocks kept", () => {
    expect(parseToolText('{"a":1}')).toEqual({ a: 1 })
    const parsed = parseToolText("name: x\nversion: |\n  3.1.9\nissue: |\n  id: abc\n  title: T\nexceptions: |-\n  _TypeError: boom\n  at a.b (c.dart:1)\n") as Record<string, unknown>
    expect(parsed.name).toBe("x")
    expect(parsed.version).toBe("3.1.9")
    expect(parsed.issue).toEqual({ id: "abc", title: "T" })
    expect(parsed.exceptions).toBe("_TypeError: boom\nat a.b (c.dart:1)")
    expect(parseToolText("- id: 1\n- id: 2\n")).toEqual([{ id: 1 }, { id: 2 }])
    expect(parseToolText("Issue not found")).toBe("Issue not found")
    expect(parseToolText({ events: ["a: 1"] })).toEqual({ events: ["a: 1"] })
  })
})

describe("describeError", () => {
  test("Error, strings, host-style tagged objects, nested causes", async () => {
    const { describeError } = await import("../src/errors.js")
    expect(describeError(new Error("boom"))).toBe("boom")
    expect(describeError(Object.assign(new Error("outer"), { cause: new Error("inner") }))).toBe("outer (cause: inner)")
    expect(describeError("plain")).toBe("plain")
    expect(describeError({ _tag: "PermissionDenied", message: "tool not allowed" })).toBe("tool not allowed [PermissionDenied]")
    expect(describeError({ type: "ToolFailure", error: { message: "Must specify 'appId' parameter" } })).toBe("Must specify 'appId' parameter")
    expect(describeError({ foo: 1 })).toBe('{"foo":1}')
    expect(describeError({})).toBe("unknown error")
  })
})

describe("gitlab tool aliases + adaptInput", () => {
  test("create_mr / get_mr style servers are recognised", () => {
    const servers = [{ name: "gitlab", status: "connected" }]
    const ids = ["gitlab_gitlab_create_mr", "gitlab_gitlab_get_mr", "gitlab_gitlab_update_mr", "gitlab_gitlab_list_mrs", "gitlab_gitlab_create_issue"]
    expect(matchServices(ids, servers).gitlab).toMatchObject({ namespace: "gitlab_gitlab", serverName: "gitlab", status: "connected", capabilities: { createMr: "gitlab_gitlab_create_mr", getMr: "gitlab_gitlab_get_mr", updateMr: "gitlab_gitlab_update_mr", listMrs: "gitlab_gitlab_list_mrs" } })
  })
  test("adaptInput renames to the schema's spelling and drops unknown keys", () => {
    const aliases = { project_id: ["projectId", "project"], merge_request_iid: ["mrIid", "iid"], description: ["body"] }
    expect(adaptInput({ project_id: "a/b", source_branch: "x", description: "d", merge_request_iid: 3, extra: 1 }, { projectId: {}, sourceBranch: {}, body: {}, iid: {} }, aliases)).toEqual({ projectId: "a/b", sourceBranch: "x", body: "d", iid: 3 })
    expect(adaptInput({ project_id: "a/b", draft: true }, { project_id: {}, draft: {} })).toEqual({ project_id: "a/b", draft: true })
    expect(adaptInput({ project_id: "a/b" }, {})).toEqual({ project_id: "a/b" })
  })
  test("renderToolSchema", () => {
    const out = renderToolSchema("gitlab_gitlab_create_mr", { description: "Create MR", input: { properties: { projectId: { type: "string", description: "Project" }, draft: { type: "boolean" } }, required: ["projectId"] } })
    expect(out).toContain("| `projectId` | string | yes | Project |")
    expect(out).toContain("| `draft` | boolean |  |  |")
    expect(renderToolSchema("nope", undefined)).toContain("not found")
  })
})

describe("rpc reply pruning", () => {
  test("drops undefined keys recursively and stringifies dates", async () => {
    expect(pruneUndefined<unknown>({ a: 1, b: undefined, c: [{ d: undefined, e: "x" }], f: new Date("2026-11-13T21:14:02.000Z") })).toEqual({ a: 1, c: [{ e: "x" }], f: "2026-11-13T21:14:02.000Z" })
    const h = prunedHandlers({ "x.y": async (input: { n: number }) => ({ crashes: [{ id: "1", lastSeen: undefined }], n: input.n }) })
    expect((await h["x.y"]({ n: 2 })) as unknown).toEqual({ crashes: [{ id: "1" }], n: 2 })
  })
  test("YAML timestamps become ISO strings", () => {
    const parsed = parseToolText("issue:\n  lastSeenTime: 2026-11-13T21:14:02Z\n  id: a\n") as { issue: { lastSeenTime: unknown } }
    expect(parsed.issue.lastSeenTime).toBe("2026-11-13T21:14:02.000Z")
  })
})
