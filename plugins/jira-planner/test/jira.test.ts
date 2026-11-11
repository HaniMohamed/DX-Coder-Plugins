import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { findStoryPointsField, findSubtaskIssueType, JiraClient, JiraError, projectKeyOf, resolveCredentials, storyPointsOf } from "../src/jira.js"
import { startMockJira, type MockJira } from "./mock-jira.js"

describe("resolveCredentials", () => {
  test("prefers options, then MCP env, then process env; PAT beats basic", () => {
    const fromOptions = resolveCredentials({ options: { url: "https://a/", token: "t" }, mcpEnv: { JIRA_URL: "https://b" } })
    expect(fromOptions).toMatchObject({ baseUrl: "https://a", authKind: "pat", authHeader: "Bearer t", source: "plugin options" })

    const fromMcp = resolveCredentials({ mcpEnv: { JIRA_URL: "https://b", JIRA_USERNAME: "u", JIRA_API_TOKEN: "p", JIRA_SSL_VERIFY: "false" }, processEnv: { JIRA_URL: "https://c", JIRA_PERSONAL_TOKEN: "x" } })
    expect(fromMcp).toMatchObject({ baseUrl: "https://b", authKind: "basic", insecure: true, source: "MCP server environment" })
    expect(fromMcp?.authHeader).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`)

    const fromProcess = resolveCredentials({ mcpEnv: { JIRA_URL: "https://b" }, processEnv: { JIRA_URL: "https://c", JIRA_PERSONAL_TOKEN: "x" } })
    expect(fromProcess?.source).toBe("process environment")

    expect(resolveCredentials({ processEnv: { JIRA_URL: "https://c" } })).toBeUndefined()
  })
})

describe("field helpers", () => {
  test("story points field by id or name, subtask type selection", () => {
    const fields = [
      { id: "customfield_1", name: "Story Points" },
      { id: "customfield_2", name: "Story point estimate" },
    ]
    expect(findStoryPointsField(fields, {})?.id).toBe("customfield_1")
    expect(findStoryPointsField(fields, { id: "customfield_2" })?.id).toBe("customfield_2")
    expect(findStoryPointsField(fields, { names: ["Nope"] })).toBeUndefined()

    const types = [
      { id: "1", name: "Story" },
      { id: "2", name: "Sub-task", subtask: true },
      { id: "3", name: "Technical sub-task", subtask: true },
    ]
    expect(findSubtaskIssueType(types).type).toBeUndefined()
    expect(findSubtaskIssueType(types, "technical sub-task").type?.id).toBe("3")
    expect(findSubtaskIssueType(types.slice(0, 2)).type?.id).toBe("2")
    expect(projectKeyOf("ABC-123")).toBe("ABC")
    expect(storyPointsOf({ id: "1", key: "A-1", fields: { customfield_1: 3 } }, "customfield_1")).toBe(3)
    expect(storyPointsOf({ id: "1", key: "A-1", fields: {} }, "customfield_1")).toBeNull()
  })
})

describe("JiraClient against the mock server", () => {
  let mock: MockJira
  beforeAll(() => {
    mock = startMockJira()
  })
  afterAll(() => mock.stop())

  const client = () => new JiraClient({ baseUrl: mock.url, authHeader: "Bearer x", authKind: "pat", insecure: false, source: "test" })

  test("sends the bearer header and parses JSON", async () => {
    const me = await client().myself()
    expect(me.displayName).toBe("Tech Lead")
    expect(mock.requests.at(-1)?.auth).toBe("Bearer x")
  })

  test("raises JiraError with messages on 401 and 404", async () => {
    const bad = new JiraClient({ baseUrl: mock.url, authHeader: "Bearer wrong", authKind: "pat", insecure: false, source: "test" })
    await expect(bad.myself()).rejects.toBeInstanceOf(JiraError)
    try {
      await client().issue("PROJ-404", ["summary"])
    } catch (error) {
      expect((error as JiraError).status).toBe(404)
      expect((error as JiraError).messages).toEqual(["Issue Does Not Exist"])
    }
  })

  test("fetches the story with subtasks, comments and attachments", async () => {
    const issue = await client().issue("PROJ-1", ["summary", "subtasks", "attachment", "comment", "customfield_10002"])
    expect(issue.fields.subtasks?.map((s) => s.key)).toEqual(["PROJ-2", "PROJ-3"])
    expect(issue.fields.attachment?.[0]?.content).toContain("/secure/attachment/a1/")
    expect(storyPointsOf(issue, "customfield_10002")).toBe(8)
  })

  test("downloads attachments only from the Jira host", async () => {
    const bytes = await client().download(`${mock.url}/secure/attachment/a1/file`, 1024)
    expect(Buffer.from(bytes).toString()).toContain("Invoice export BRD")
    await expect(client().download("http://evil.example/secure/attachment/a1/file", 1024)).rejects.toThrow("refusing to download")
  })

  test("creates a subtask and a comment", async () => {
    const created = await client().createIssue({ project: { key: "PROJ" }, parent: { key: "PROJ-1" }, issuetype: { id: "10003" }, summary: "New one", customfield_10002: 2 })
    expect(created.key).toMatch(/^PROJ-\d+$/)
    expect(mock.issues.get(created.key)?.fields.customfield_10002).toBe(2)
    const comment = await client().addComment("PROJ-1", "hello")
    expect(comment.id).toBeDefined()
    expect(mock.comments.at(-1)).toEqual({ issue: "PROJ-1", body: "hello" })
  })

  test("exposes field errors when story points are rejected on create", async () => {
    const strict = startMockJira({ rejectStoryPointsOnCreate: true })
    try {
      const c = new JiraClient({ baseUrl: strict.url, authHeader: "Bearer x", authKind: "pat", insecure: false, source: "test" })
      await expect(c.createIssue({ project: { key: "PROJ" }, parent: { key: "PROJ-1" }, issuetype: { id: "10003" }, summary: "x", customfield_10002: 1 })).rejects.toMatchObject({ status: 400 })
      try {
        await c.createIssue({ project: { key: "PROJ" }, parent: { key: "PROJ-1" }, issuetype: { id: "10003" }, summary: "x", customfield_10002: 1 })
      } catch (error) {
        expect(Object.keys((error as JiraError).fieldErrors)).toEqual(["customfield_10002"])
      }
      const ok = await c.createIssue({ project: { key: "PROJ" }, parent: { key: "PROJ-1" }, issuetype: { id: "10003" }, summary: "x" })
      await c.updateIssue(ok.key, { customfield_10002: 1 })
      expect(strict.issues.get(ok.key)?.fields.customfield_10002).toBe(1)
    } finally {
      strict.stop()
    }
  })
})
