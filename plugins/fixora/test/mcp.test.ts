import { describe, expect, test } from "bun:test"
import { decideAutoAllow, matchServices, mcpNamespace, normalizeToolOutput, pendingKey } from "../src/mcp.js"

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

describe("decideAutoAllow", () => {
  test("allows only registered plugin-originated calls", () => {
    const pending = new Set([pendingKey("ses_1", "sentry_get_issue_details")])
    expect(decideAutoAllow({ sessionID: "ses_1", action: "sentry_get_issue_details" }, pending)).toBe("allow")
    expect(decideAutoAllow({ sessionID: "ses_2", action: "sentry_get_issue_details" }, pending)).toBeUndefined()
    expect(decideAutoAllow({ sessionID: "ses_1", action: "sentry_update_issue" }, pending)).toBeUndefined()
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
