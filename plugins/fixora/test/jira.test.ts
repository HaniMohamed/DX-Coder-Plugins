import { describe, expect, test } from "bun:test"
import { DEFAULTS } from "../src/options.js"
import { dedupeJql, issueKeyFromResult, jiraAvailable, jiraCommentInput, jiraCreateInput, pickTransition } from "../src/jira.js"
import type { DetectedService } from "../src/types.js"

describe("jiraAvailable / inputs / result parsing", () => {
  const service: DetectedService = { id: "jira", namespace: "jira_jira", serverName: "jira", status: "connected", toolIds: [], capabilities: { createIssue: "jira_jira_create_issue", search: "jira_jira_search", addComment: "jira_jira_add_comment" } }
  test("tickets need a connected server with create + search and a project", () => {
    expect(jiraAvailable(service, { ...DEFAULTS, jira: { ...DEFAULTS.jira, project: "APP" } })).toBe(true)
    expect(jiraAvailable(service, DEFAULTS)).toBe(false)
    expect(jiraAvailable({ ...service, status: "needs_auth" }, { ...DEFAULTS, jira: { ...DEFAULTS.jira, project: "APP" } })).toBe(false)
    expect(jiraAvailable(undefined, { ...DEFAULTS, jira: { ...DEFAULTS.jira, project: "APP" } })).toBe(false)
  })
  test("create input follows mcp-atlassian, encodes additional_fields per schema, truncates the summary", () => {
    const input = jiraCreateInput({ project: "DE", issueType: "Sub-task", summary: "x".repeat(300), description: "d", labels: ["fixora"], parent: "DE-62556" })
    expect(input).toMatchObject({ project_key: "DE", issue_type: "Sub-task", description: "d", additional_fields: { labels: ["fixora"], parent: "DE-62556" } })
    expect((input.summary as string).length).toBe(255)
    expect(jiraCreateInput({ project: "DE", issueType: "Bug", summary: "s", description: "d", labels: [] }, { additionalFieldsType: "string" }).additional_fields).toBe('{"labels":[]}')
    expect(jiraCommentInput("APP-1", "hello")).toEqual({ issue_key: "APP-1", comment: "hello" })
  })
  test("issue keys are read from objects and text", () => {
    expect(issueKeyFromResult({ key: "APP-2", url: "https://j/browse/APP-2" })).toEqual({ key: "APP-2", url: "https://j/browse/APP-2" })
    expect(issueKeyFromResult({ issue: { key: "APP-3" } })).toMatchObject({ key: "APP-3" })
    expect(issueKeyFromResult("Created APP-4: https://jira.example.com/browse/APP-4")).toEqual({ key: "APP-4", url: "https://jira.example.com/browse/APP-4" })
    expect(issueKeyFromResult({ nope: 1 })).toEqual({ key: undefined, url: undefined })
  })
})

describe("dedupeJql / pickTransition", () => {
  test("jql carries the project and the fingerprint marker", () => {
    expect(dedupeJql("APP", "abcdef0123456789")).toBe('project = "APP" AND (labels = "fixora" OR text ~ "fixora-fp") AND text ~ "fixora-fp:abcdef012345" ORDER BY created DESC')
    expect(dedupeJql(undefined, "abcdef0123456789")).not.toContain("project")
  })
  test("transition matching is fuzzy", () => {
    const t = [{ id: "11", name: "To Do" }, { id: "21", name: "In Review" }, { id: "31", name: "Done" }]
    expect(pickTransition(t, "in-review")?.id).toBe("21")
    expect(pickTransition(t, "Review")?.id).toBe("21")
    expect(pickTransition(t, "Closed")).toBeUndefined()
  })
})

describe("mcp-atlassian additional_fields encoding", () => {
  test("follows the declared schema type and defaults to an object", async () => {
    const { schemaParamType, encodeAdditionalFields } = await import("../src/jira.js")
    const stringSchema = { type: "object", properties: { additional_fields: { type: "string", description: "JSON" } } }
    const objectSchema = { type: "object", properties: { additional_fields: { type: "object" } } }
    const nullable = { type: "object", properties: { additional_fields: { anyOf: [{ type: "string" }, { type: "null" }] } } }
    expect(schemaParamType(stringSchema, "additional_fields")).toBe("string")
    expect(schemaParamType(objectSchema, "additional_fields")).toBe("object")
    expect(schemaParamType(nullable, "additional_fields")).toBe("string")
    expect(schemaParamType({}, "additional_fields")).toBeUndefined()
    const value = { labels: ["fixora"], parent: "DE-62556" }
    expect(encodeAdditionalFields(value, "string")).toBe('{"labels":["fixora"],"parent":"DE-62556"}')
    expect(encodeAdditionalFields(value, "object")).toEqual(value)
    expect(encodeAdditionalFields(value, undefined)).toEqual(value)
  })
})
