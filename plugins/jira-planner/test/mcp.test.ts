import { describe, expect, test } from "bun:test"
import { guardWorkerWrite, mcpNamespace, workerPermissions } from "../src/mcp.js"

// Mirrors the host: Wildcard.match turns * into .* and the LAST matching rule wins
// (packages/core/src/util/wildcard.ts, packages/core/src/permission.ts evaluate()).
const match = (input: string, pattern: string) => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "s").test(input)
}
const evaluate = (action: string, resource: string, rules: ReturnType<typeof workerPermissions>) =>
  rules.findLast((r) => match(action, r.action) && match(resource, r.resource))?.effect ?? "ask"
// Mirrors whollyDisabled() in packages/core/src/tool.ts: a tool is hidden when the last rule matching its action denies "*".
const hidden = (action: string, rules: ReturnType<typeof workerPermissions>) => {
  const rule = rules.findLast((r) => match(action, r.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

const rules = workerPermissions({ namespace: "jira", shell: "deny" })

describe("workerPermissions", () => {
  test("leaves file edits to the agent defaults (no edit rule at all)", () => {
    expect(rules.some((r) => ["edit", "write", "patch"].includes(r.action))).toBe(false)
    expect(evaluate("edit", ".dxcoder/jira-planner/PROJ-1/plan.md", rules)).toBe("ask")
  })

  test("keeps read-only Jira tools, hides write tools, web and shell", () => {
    expect(evaluate("jira_jira_get_issue", "*", rules)).toBe("allow")
    expect(evaluate("jira_jira_search", "*", rules)).toBe("allow")
    expect(hidden("jira_jira_get_issue", rules)).toBe(false)
    for (const tool of ["jira_jira_create_issue", "jira_jira_update_issue", "jira_jira_add_comment", "jira_jira_transition_issue", "jira_jira_download_attachments", "jira_jira_delete_issue"]) {
      expect(evaluate(tool, "*", rules)).toBe("deny")
      expect(hidden(tool, rules)).toBe(true)
    }
    expect(hidden("webfetch", rules)).toBe(true)
    expect(hidden("websearch", rules)).toBe(true)
    expect(hidden("shell", rules)).toBe(true)
  })

  test("other server names still lose their Jira write tools", () => {
    const other = workerPermissions({ namespace: "atlassian", shell: "allow" })
    expect(evaluate("atlassian_jira_get_issue", "*", other)).toBe("allow")
    expect(evaluate("atlassian_jira_create_issue", "*", other)).toBe("deny")
    expect(evaluate("shell", "*", other)).toBe("allow")
    expect(mcpNamespace("my jira.server")).toBe("my_jira_server")
  })
})

describe("guardWorkerWrite", () => {
  const folder = "/repo/.dxcoder/jira-planner/PROJ-1"
  const directory = "/repo"
  const guard = (tool: string, input: unknown) => guardWorkerWrite({ tool, input, folder, directory })

  test("allows relative and absolute paths inside the issue folder", () => {
    expect(guard("write", { path: ".dxcoder/jira-planner/PROJ-1/plan.md" })).toBeUndefined()
    expect(guard("edit", { path: "/repo/.dxcoder/jira-planner/PROJ-1/subtasks.json" })).toBeUndefined()
    expect(guard("write", { path: "./.dxcoder/jira-planner/PROJ-1/attachments/notes.md" })).toBeUndefined()
    expect(guard("write", { path: ".dxcoder/jira-planner/PROJ-1/../PROJ-1/x.md" })).toBeUndefined()
  })

  test("blocks paths outside the folder, traversal, sibling folders, patch, and missing paths", () => {
    expect(guard("write", { path: "src/app.ts" })).toContain("outside the issue folder")
    expect(guard("edit", { path: "/repo/src/app.ts" })).toContain("outside the issue folder")
    expect(guard("write", { path: ".dxcoder/jira-planner/PROJ-1/../PROJ-2/plan.md" })).toContain("outside the issue folder")
    expect(guard("write", { path: ".dxcoder/jira-planner/PROJ-10/plan.md" })).toContain("outside the issue folder")
    expect(guard("patch", { patch: "*** Begin Patch" })).toContain("patch tool is not allowed")
    expect(guard("write", {})).toContain("without a path")
  })

  test("ignores non-writing tools and handles Windows-style paths", () => {
    expect(guard("read", { path: "src/app.ts" })).toBeUndefined()
    expect(guard("glob", { pattern: "**/*" })).toBeUndefined()
    expect(guardWorkerWrite({ tool: "write", input: { path: "C:\\repo\\.dxcoder\\jira-planner\\PROJ-1\\plan.md" }, folder: "C:/repo/.dxcoder/jira-planner/PROJ-1", directory: "C:/repo" })).toBeUndefined()
    expect(guardWorkerWrite({ tool: "write", input: { path: "C:\\repo\\src\\a.ts" }, folder: "C:/repo/.dxcoder/jira-planner/PROJ-1", directory: "C:/repo" })).toContain("outside")
  })
})
