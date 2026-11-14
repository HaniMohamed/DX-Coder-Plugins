import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { DEFAULTS } from "../src/options.js"
import { dedupeJql, JiraClient, pickTransition, resolveCredentials, restPort } from "../src/jira.js"

describe("resolveCredentials", () => {
  test("options → MCP env → process env; PAT beats basic", () => {
    expect(resolveCredentials({ options: { ...DEFAULTS.jira, url: "https://j.example.com/", token: "pat" } })).toMatchObject({ baseUrl: "https://j.example.com", authKind: "pat", source: "plugin options" })
    expect(resolveCredentials({ options: DEFAULTS.jira, mcpEnv: { JIRA_URL: "https://j", JIRA_USERNAME: "u", JIRA_API_TOKEN: "p", JIRA_SSL_VERIFY: "false" } })).toMatchObject({ authKind: "basic", insecure: true, source: "MCP server environment" })
    expect(resolveCredentials({ options: DEFAULTS.jira, processEnv: { JIRA_URL: "https://j", JIRA_PERSONAL_TOKEN: "t" } })?.source).toBe("process environment")
    expect(resolveCredentials({ options: DEFAULTS.jira })).toBeUndefined()
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

describe("REST port against a mock Jira", () => {
  const requests: Array<{ method: string; path: string; body?: unknown }> = []
  let server: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const body = req.method === "POST" ? await req.json() : undefined
        requests.push({ method: req.method, path: url.pathname + url.search, body })
        if (req.headers.get("authorization") !== "Bearer pat") return new Response(JSON.stringify({ errorMessages: ["unauthorized"] }), { status: 401 })
        if (url.pathname === "/rest/api/2/search") return Response.json({ issues: [{ key: "APP-1", fields: { summary: "s", status: { name: "Open" } } }] })
        if (url.pathname === "/rest/api/2/issue" && req.method === "POST") return Response.json({ id: "1", key: "APP-2" })
        if (url.pathname.endsWith("/comment")) return Response.json({ id: "c1" })
        if (url.pathname.endsWith("/transitions") && req.method === "GET") return Response.json({ transitions: [{ id: "21", name: "In Review" }] })
        if (url.pathname.endsWith("/transitions") && req.method === "POST") return new Response(null, { status: 204 })
        return new Response("not found", { status: 404 })
      },
    })
  })
  afterAll(() => server.stop(true))

  test("search, create, comment, transitions, errors", async () => {
    const port = restPort(new JiraClient({ baseUrl: `http://localhost:${server.port}`, authHeader: "Bearer pat", authKind: "pat", insecure: false, source: "test" }))
    expect(await port.search("project = APP")).toEqual([{ key: "APP-1", url: `http://localhost:${server.port}/browse/APP-1`, status: "Open", summary: "s" }])
    const created = await port.create({ project: "APP", issueType: "Bug", summary: "x".repeat(300), description: "d", labels: ["fixora"] })
    expect(created.key).toBe("APP-2")
    expect((requests.find((r) => r.method === "POST" && r.path === "/rest/api/2/issue")!.body as { fields: { summary: string; labels: string[] } }).fields.summary).toHaveLength(255)
    const sub = await port.create({ project: "DE", issueType: "Sub-task", summary: "s", description: "d", labels: ["fixora"], parent: "DE-62556" })
    expect(sub.key).toBe("APP-2")
    const subBody = requests.filter((r) => r.method === "POST" && r.path === "/rest/api/2/issue").at(-1)!.body as { fields: Record<string, unknown> }
    expect(subBody.fields.parent).toEqual({ key: "DE-62556" })
    expect(subBody.fields.issuetype).toEqual({ name: "Sub-task" })
    await port.comment("APP-2", "hello")
    expect(await port.transitions("APP-2")).toEqual([{ id: "21", name: "In Review" }])
    await port.transition("APP-2", "21")
    const bad = restPort(new JiraClient({ baseUrl: `http://localhost:${server.port}`, authHeader: "Bearer nope", authKind: "pat", insecure: false, source: "test" }))
    await expect(bad.search("x")).rejects.toThrow("401")
  })
})
