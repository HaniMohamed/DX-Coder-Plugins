import { describe, expect, test } from "bun:test"
import { fixerRules, forbiddenReason, globToRegExp, guardWorkerShell, guardWorkerWrite, reviewerRules, type Rule } from "../src/permissions.js"

// Mirrors the host: Wildcard.match turns * into .* and the LAST matching rule wins.
const match = (input: string, pattern: string) => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "s").test(input)
}
const evaluate = (action: string, resource: string, rules: Rule[]) => rules.findLast((r) => match(action, r.action) && match(resource, r.resource))?.effect ?? "ask"
const hidden = (action: string, rules: Rule[]) => {
  const rule = rules.findLast((r) => match(action, r.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

const fixer = fixerRules({ sourceNamespaces: ["sentry", "firebase"], jiraNamespace: "jira", forgeNamespaces: ["gitlab"], shell: "allow" })

describe("fixerRules", () => {
  test("edits inside the worktree only, reads allowed, env files denied", () => {
    expect(evaluate("edit", "src/x.ts", fixer)).toBe("allow")
    expect(evaluate("edit", "../other/x.ts", fixer)).toBe("deny")
    expect(evaluate("edit", "/etc/passwd", fixer)).toBe("deny")
    expect(evaluate("edit", ".git/config", fixer)).toBe("deny")
    expect(evaluate("read", "src/x.ts", fixer)).toBe("allow")
    expect(evaluate("read", "config/.env", fixer)).toBe("deny")
    expect(evaluate("external_directory", "/tmp", fixer)).toBe("deny")
  })

  test("shell allowed except git state changes, network and force", () => {
    expect(evaluate("shell", "bun test", fixer)).toBe("allow")
    expect(evaluate("shell", "git push origin main", fixer)).toBe("deny")
    expect(evaluate("shell", "git commit -m x", fixer)).toBe("deny")
    expect(evaluate("shell", "git log -n 3", fixer)).toBe("allow")
    expect(evaluate("shell", "curl https://x", fixer)).toBe("deny")
    expect(evaluate("shell", "rm -rf node_modules --force", fixer)).toBe("deny")
  })

  test("source read tools allowed, writes hidden; jira read-only; forge hidden; web hidden", () => {
    expect(evaluate("sentry_get_issue_details", "*", fixer)).toBe("allow")
    expect(evaluate("sentry_search_issues", "*", fixer)).toBe("allow")
    expect(hidden("sentry_update_issue", fixer)).toBe(true)
    expect(evaluate("firebase_crashlytics_batch_get_events", "*", fixer)).toBe("allow")
    expect(hidden("firebase_crashlytics_create_note", fixer)).toBe(true)
    expect(evaluate("jira_jira_get_issue", "*", fixer)).toBe("allow")
    expect(hidden("jira_jira_create_issue", fixer)).toBe(true)
    expect(hidden("gitlab_create_merge_request", fixer)).toBe(true)
    expect(hidden("webfetch", fixer)).toBe(true)
    expect(hidden("websearch", fixer)).toBe(true)
    expect(evaluate("fixora_submit_fix", "*", fixer)).toBe("allow")
    expect(hidden("fixora_start", fixer)).toBe(true)
    expect(evaluate("question", "*", fixer)).toBe("allow")
  })
})

describe("reviewerRules", () => {
  const reviewer = reviewerRules({ sourceNamespaces: ["sentry"], forgeNamespaces: [], checkCommands: ["bun test", "bun run typecheck"] })
  test("no edits, no questions, only read-only git and the check commands", () => {
    expect(hidden("edit", reviewer)).toBe(true)
    expect(hidden("question", reviewer)).toBe(true)
    expect(evaluate("shell", "git diff origin/main", reviewer)).toBe("allow")
    expect(evaluate("shell", "bun test src/cart", reviewer)).toBe("allow")
    expect(evaluate("shell", "rm -rf src", reviewer)).toBe("deny")
    expect(evaluate("shell", "git push", reviewer)).toBe("deny")
    expect(evaluate("fixora_submit_review", "*", reviewer)).toBe("allow")
  })
})

describe("forbiddenReason / globToRegExp", () => {
  test("protected patterns", () => {
    expect(globToRegExp("**/*.lock").test("a/b/c.lock")).toBe(true)
    expect(globToRegExp("**/*.lock").test("c.lock")).toBe(true)
    expect(globToRegExp(".github/**").test(".github/workflows/ci.yml")).toBe(true)
    expect(globToRegExp("bun.lock*").test("bun.lockb")).toBe(true)
    for (const p of [".github/workflows/ci.yml", "package-lock.json", "pubspec.lock", "lib/api.g.dart", "src/generated/x.ts", ".env.local", "ios/Pods/x", ".dxcoder/fixora/x", "certs/key.pem"]) expect(forbiddenReason(p)).toBeDefined()
    for (const p of ["src/cart/service.ts", "lib/cart/service.dart", "README.md", "test/x.test.ts"]) expect(forbiddenReason(p)).toBeUndefined()
    expect(forbiddenReason("docs/x.md", ["docs/**"])).toContain("docs/**")
  })
})

describe("guardWorkerWrite", () => {
  const base = { worktree: "/repo/.worktrees/fixora-1", directory: "/repo/.worktrees/fixora-1", phase: "fix" as const }
  test("allows writes inside the worktree during fix, blocks outside, forbidden, triage phase, patch without paths", () => {
    expect(guardWorkerWrite({ ...base, tool: "write", input: { path: "src/x.ts" } })).toBeUndefined()
    expect(guardWorkerWrite({ ...base, tool: "edit", input: { filePath: "/repo/.worktrees/fixora-1/src/x.ts" } })).toBeUndefined()
    expect(guardWorkerWrite({ ...base, tool: "write", input: { path: "../../src/x.ts" } })).toContain("outside the worktree")
    expect(guardWorkerWrite({ ...base, tool: "write", input: { path: "/repo/src/x.ts" } })).toContain("outside the worktree")
    expect(guardWorkerWrite({ ...base, tool: "write", input: { path: ".github/workflows/ci.yml" } })).toContain("must not be changed")
    expect(guardWorkerWrite({ ...base, tool: "write", input: { path: "bun.lock" } })).toContain("must not be changed")
    expect(guardWorkerWrite({ ...base, tool: "write", input: { path: "src/x.ts" }, phase: "triage" })).toContain("read-only")
    expect(guardWorkerWrite({ ...base, tool: "patch", input: { patch: "*** Begin Patch\n*** Update File: src/x.ts\n" } })).toBeUndefined()
    expect(guardWorkerWrite({ ...base, tool: "patch", input: { patch: "*** Update File: ../x.ts" } })).toContain("outside")
    expect(guardWorkerWrite({ ...base, tool: "patch", input: {} })).toContain("not allowed")
    expect(guardWorkerWrite({ ...base, tool: "read", input: { path: "/etc/hosts" } })).toBeUndefined()
    expect(guardWorkerWrite({ ...base, tool: "write", input: {} })).toContain("without a path")
  })

  test("windows paths", () => {
    const win = { worktree: "C:/repo/wt", directory: "C:/repo/wt", phase: "fix" as const }
    expect(guardWorkerWrite({ ...win, tool: "write", input: { path: "C:\\repo\\wt\\src\\a.kt" } })).toBeUndefined()
    expect(guardWorkerWrite({ ...win, tool: "write", input: { path: "C:\\repo\\src\\a.kt" } })).toContain("outside")
  })
})

describe("guardWorkerShell", () => {
  const base = { worktree: "/repo/wt", role: "fixer" as const }
  test("denies dangerous commands and cd outside; allows normal commands", () => {
    expect(guardWorkerShell({ ...base, tool: "shell", input: { command: "bun test" } })).toBeUndefined()
    expect(guardWorkerShell({ ...base, tool: "shell", input: { command: "git log --oneline -n 5" } })).toBeUndefined()
    expect(guardWorkerShell({ ...base, tool: "shell", input: { command: "git push origin HEAD" } })).toContain("not allowed")
    expect(guardWorkerShell({ ...base, tool: "shell", input: { command: "git commit -am x" } })).toContain("not allowed")
    expect(guardWorkerShell({ ...base, tool: "shell", input: { command: "curl http://evil" } })).toContain("not allowed")
    expect(guardWorkerShell({ ...base, tool: "shell", input: { command: "rm -rf /" } })).toContain("not allowed")
    expect(guardWorkerShell({ ...base, tool: "shell", input: { command: "cd /tmp && ls" } })).toContain("cd outside")
    expect(guardWorkerShell({ ...base, tool: "shell", input: { command: "cd src && bun test" } })).toBeUndefined()
    expect(guardWorkerShell({ ...base, tool: "shell", input: { command: "ls", cwd: "/repo" } })).toContain("cwd must stay")
    expect(guardWorkerShell({ ...base, tool: "shell", input: { command: "cat .env" } })).toContain("not allowed")
    expect(guardWorkerShell({ ...base, tool: "read", input: { command: "git push" } })).toBeUndefined()
  })

  test("reviewer allowlist", () => {
    const r = { ...base, role: "reviewer" as const, allowPrefixes: ["bun test"] }
    expect(guardWorkerShell({ ...r, tool: "shell", input: { command: "git diff origin/main" } })).toBeUndefined()
    expect(guardWorkerShell({ ...r, tool: "shell", input: { command: "bun test src/x" } })).toBeUndefined()
    expect(guardWorkerShell({ ...r, tool: "shell", input: { command: "ls -la" } })).toContain("only read-only git")
  })
})
