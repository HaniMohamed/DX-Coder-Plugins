import { describe, expect, test } from "bun:test"
import { forbiddenReason, globToRegExp, guardWorkerMcp, guardWorkerShell, guardWorkerTool, guardWorkerWrite, isGeneratedChange, parseGitInvocations, workerRules, type Rule } from "../src/permissions.js"
import type { Services, WorkerInfo, WorkerPhase } from "../src/types.js"

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

const ns = { sourceNamespaces: ["sentry", "firebase"], jiraNamespace: "jira", forgeNamespaces: ["gitlab"] }

describe("workerRules", () => {
  const fixer = workerRules({ role: "fixer", shell: "allow", ...ns })
  test("fixer: edits inside the repo, reads allowed, env files denied, shell allowed, every MCP namespace allowed (the hook narrows)", () => {
    expect(evaluate("edit", "src/x.ts", fixer)).toBe("allow")
    expect(evaluate("edit", "../other/x.ts", fixer)).toBe("deny")
    expect(evaluate("edit", "/etc/passwd", fixer)).toBe("deny")
    expect(evaluate("edit", ".git/config", fixer)).toBe("deny")
    expect(evaluate("read", "src/x.ts", fixer)).toBe("allow")
    expect(evaluate("read", "config/.env", fixer)).toBe("deny")
    expect(evaluate("external_directory", "/tmp", fixer)).toBe("deny")
    expect(evaluate("shell", "git push origin fixora/x", fixer)).toBe("allow")
    expect(evaluate("sentry_get_issue_details", "*", fixer)).toBe("allow")
    expect(evaluate("jira_jira_create_issue", "*", fixer)).toBe("allow")
    expect(evaluate("gitlab_create_merge_request", "*", fixer)).toBe("allow")
    expect(hidden("webfetch", fixer)).toBe(true)
    expect(hidden("websearch", fixer)).toBe(true)
    expect(evaluate("fixora_submit_fix", "*", fixer)).toBe("allow")
    expect(hidden("fixora_start", fixer)).toBe(true)
    expect(evaluate("question", "*", fixer)).toBe("allow")
    // CodeMode: MCP tools are reached only through `execute`, so it must never be hidden; unrelated servers stay hidden.
    expect(hidden("execute", fixer)).toBe(false)
    expect(evaluate("execute", "*", fixer)).toBe("allow")
    expect(hidden("other_server_do_thing", fixer)).toBe(true)
  })
  test("reviewer and lister: no edits, no questions; the lister has no shell", () => {
    const reviewer = workerRules({ role: "reviewer", shell: "allow", ...ns })
    expect(hidden("edit", reviewer)).toBe(true)
    expect(hidden("question", reviewer)).toBe(true)
    expect(evaluate("shell", "git diff", reviewer)).toBe("allow")
    const lister = workerRules({ role: "lister", shell: "allow", ...ns })
    expect(hidden("shell", lister)).toBe(true)
    expect(hidden("execute", lister)).toBe(false)
    expect(evaluate("firebase_crashlytics_get_report", "*", lister)).toBe("allow")
  })
})

describe("forbiddenReason / globToRegExp / isGeneratedChange", () => {
  test("protected patterns", () => {
    expect(globToRegExp("**/*.lock").test("a/b/c.lock")).toBe(true)
    expect(globToRegExp(".github/**").test(".github/workflows/ci.yml")).toBe(true)
    for (const p of [".github/workflows/ci.yml", "package-lock.json", "pubspec.lock", "lib/api.g.dart", "src/generated/x.ts", ".env.local", "ios/Pods/x", ".dxcoder/fixora/x", "certs/key.pem"]) expect(forbiddenReason(p)).toBeDefined()
    for (const p of ["src/cart/service.ts", "lib/cart/service.dart", "README.md", "test/x.test.ts"]) expect(forbiddenReason(p)).toBeUndefined()
    expect(forbiddenReason("docs/x.md", ["docs/**"])).toContain("docs/**")
  })
  test("lockfiles, caches and build outputs are generated; sources are not", () => {
    for (const p of ["pubspec.lock", "packages/core/pubspec.lock", "bun.lock", "web/package-lock.json", ".dart_tool/package_config.json", "node_modules/a/b.js", "build/app.apk", "ios/Pods/x"]) expect(isGeneratedChange(p)).toBe(true)
    for (const p of ["lib/cart/service.dart", "test/cart_test.dart", "pubspec.yaml", "src/lock.ts"]) expect(isGeneratedChange(p)).toBe(false)
  })
})

describe("guardWorkerWrite", () => {
  const base = { repo: "/repo", directory: "/repo", folder: "/repo/.dxcoder/fixora/run-1", phase: "fix" as const }
  test("allows writes inside the repo during fix, blocks outside, forbidden, read-only phases, patch without paths", () => {
    expect(guardWorkerWrite({ ...base, tool: "write", input: { path: "src/x.ts" } })).toBeUndefined()
    expect(guardWorkerWrite({ ...base, tool: "edit", input: { filePath: "/repo/src/x.ts" } })).toBeUndefined()
    expect(guardWorkerWrite({ ...base, tool: "write", input: { path: "../../src/x.ts" } })).toContain("outside the repository")
    expect(guardWorkerWrite({ ...base, tool: "write", input: { path: "/other/src/x.ts" } })).toContain("outside the repository")
    expect(guardWorkerWrite({ ...base, tool: "write", input: { path: ".github/workflows/ci.yml" } })).toContain("must not be changed")
    expect(guardWorkerWrite({ ...base, tool: "write", input: { path: "bun.lock" } })).toContain("must not be changed")
    expect(guardWorkerWrite({ ...base, tool: "write", input: { path: "src/x.ts" }, phase: "triage" })).toContain("read-only")
    expect(guardWorkerWrite({ ...base, tool: "write", input: { path: "src/x.ts" }, phase: "publish" })).toContain("read-only")
    // Notes in the run folder are fine in every phase.
    expect(guardWorkerWrite({ ...base, tool: "write", input: { path: "/repo/.dxcoder/fixora/run-1/analysis.md" }, phase: "triage" })).toBeUndefined()
    expect(guardWorkerWrite({ ...base, tool: "write", input: { path: ".dxcoder/fixora/run-1/fix-plan.md" } })).toBeUndefined()
    expect(guardWorkerWrite({ ...base, tool: "write", input: { path: ".dxcoder/fixora/other/x.md" } })).toContain("must not be changed")
    expect(guardWorkerWrite({ ...base, tool: "patch", input: { patch: "*** Begin Patch\n*** Update File: src/x.ts\n" } })).toBeUndefined()
    expect(guardWorkerWrite({ ...base, tool: "patch", input: { patch: "*** Update File: ../x.ts" } })).toContain("outside")
    expect(guardWorkerWrite({ ...base, tool: "patch", input: {} })).toContain("not allowed")
    expect(guardWorkerWrite({ ...base, tool: "write", input: {} })).toContain("without a path")
  })
})

describe("parseGitInvocations", () => {
  test("finds every git call in a command line, with -C", () => {
    expect(parseGitInvocations("git fetch origin main && git checkout -b fixora/x origin/main")).toEqual([
      { verb: "fetch", args: ["origin", "main"], dir: undefined },
      { verb: "checkout", args: ["-b", "fixora/x", "origin/main"], dir: undefined },
    ])
    expect(parseGitInvocations("cd src; git -C /repo status --porcelain=v1 | head")).toEqual([{ verb: "status", args: ["--porcelain=v1"], dir: "/repo" }])
    expect(parseGitInvocations('git commit -F "msg file.txt"')[0]!.args).toEqual(["-F", "msg file.txt"])
    expect(parseGitInvocations("bun test")).toEqual([])
  })
})

const worker = (phase: WorkerPhase, extra: Partial<WorkerInfo> = {}): WorkerInfo => ({ runId: "run-1", role: "fixer", repo: "/repo", folder: "/repo/.dxcoder/fixora/run-1", phase, baseBranch: "main", branch: "fixora/run-1-x", grants: {}, ...extra })
const shell = (phase: WorkerPhase, command: string, extra: Partial<WorkerInfo> = {}, checkCommands: string[] = []) => guardWorkerShell({ tool: "shell", input: { command }, worker: worker(phase, extra), checkCommands })

describe("guardWorkerShell per phase", () => {
  test("always denied: network, sudo, rm -rf, cd outside, cwd outside, git -C outside", () => {
    for (const phase of ["prepare", "triage", "fix", "publish", "restore"] as const) {
      expect(shell(phase, "curl http://evil")).toContain("not allowed")
      expect(shell(phase, "sudo rm -rf /")).toContain("not allowed")
      expect(shell(phase, "rm -rf node_modules")).toContain("not allowed")
      expect(shell(phase, "cd /tmp && ls")).toContain("cd outside")
      expect(shell(phase, "git -C /other status")).toContain("git -C outside")
    }
    expect(guardWorkerShell({ tool: "shell", input: { command: "ls", cwd: "/elsewhere" }, worker: worker("fix") })).toContain("cwd must stay")
    expect(guardWorkerShell({ tool: "read", input: { command: "git push" }, worker: worker("fix") })).toBeUndefined()
  })

  test("prepare: fetch, checkout, branch creation, stash push allowed; resets, prune, protected branches denied", () => {
    expect(shell("prepare", "git rev-parse --show-toplevel && git status --porcelain=v1 --untracked-files=all")).toBeUndefined()
    expect(shell("prepare", "git fetch origin main")).toBeUndefined()
    expect(shell("prepare", "git checkout -b fixora/run-1-x origin/main")).toBeUndefined()
    expect(shell("prepare", "git checkout fixora/run-1-x")).toBeUndefined()
    expect(shell("prepare", "git branch -r --list | head -40")).toBeUndefined()
    expect(shell("prepare", 'git stash push -u -m "fixora/run-1" && git rev-parse stash@{0}')).toBeUndefined()
    expect(shell("prepare", "bun install")).toBeUndefined()
    expect(shell("prepare", "flutter pub get")).toBeUndefined()
    expect(shell("prepare", "git checkout main")).toBeUndefined() // the base branch itself is fine
    expect(shell("prepare", "git checkout develop")).toContain("not allowed")
    expect(shell("prepare", "git checkout -- src/x.ts")).toContain("not allowed")
    expect(shell("prepare", "git reset --hard")).toContain("not allowed")
    expect(shell("prepare", "git fetch --prune origin")).toContain("not allowed")
    expect(shell("prepare", "git stash drop")).toContain("not allowed")
    expect(shell("prepare", "git branch -D main")).toContain("not allowed")
    expect(shell("prepare", "git push origin main")).toContain("not allowed")
  })

  test("triage: read-only git plus ordinary commands; no state changes", () => {
    expect(shell("triage", "git log -n 20 -- src/x.ts && git blame -L 80,95 -- src/x.ts")).toBeUndefined()
    expect(shell("triage", "rg applyCoupon src")).toBeUndefined()
    expect(shell("triage", "git checkout other")).toContain("read-only git only")
    expect(shell("triage", "git stash")).toContain("read-only git only")
  })

  test("fix: tests and installs allowed, git add -N allowed, commits / checkouts / stash denied", () => {
    expect(shell("fix", "bun test src/cart")).toBeUndefined()
    expect(shell("fix", "git add -N . && git status --porcelain=v1 --untracked-files=all && git diff HEAD")).toBeUndefined()
    expect(shell("fix", "git add src/x.ts")).toContain("publish phase")
    expect(shell("fix", "git commit -am x")).toContain("publish phase")
    expect(shell("fix", "git checkout main")).toContain("publish phase")
    expect(shell("fix", "git stash")).toContain("publish phase")
    expect(shell("fix", "git push origin HEAD")).toContain("publish phase")
  })

  test("review: read-only git and the listed check commands only", () => {
    expect(shell("review", "git diff HEAD", { role: "reviewer" }, ["bun test"])).toBeUndefined()
    expect(shell("review", "bun test src/x", { role: "reviewer" }, ["bun test"])).toBeUndefined()
    expect(shell("review", "bun run build", { role: "reviewer" }, ["bun test"])).toContain("only read-only git")
    expect(shell("review", "git checkout main", { role: "reviewer" }, ["bun test"])).toContain("read-only git only")
  })

  test("publish: explicit add, commit -F, push of the run's branch; never -A, --no-verify, --force, other branches, main", () => {
    const g = { grants: { commit: true, push: true, mr: true } }
    expect(shell("publish", "git add -- src/x.ts test/x.test.ts", g)).toBeUndefined()
    expect(shell("publish", "git commit -F /repo/.dxcoder/fixora/run-1/commit-message.txt --signoff", g)).toBeUndefined()
    expect(shell("publish", "git rev-parse HEAD", g)).toBeUndefined()
    expect(shell("publish", "git push -u origin fixora/run-1-x", g)).toBeUndefined()
    expect(shell("publish", "git push origin fixora/run-1-x:refs/heads/fixora/run-1-x", g)).toBeUndefined()
    expect(shell("publish", "glab mr create --source-branch fixora/run-1-x --target-branch main --title x --description-file mr.md --yes", g)).toBeUndefined()
    expect(shell("publish", "gh pr create --head fixora/run-1-x --base main --title x --body-file mr.md", g)).toBeUndefined()
    expect(shell("publish", "git add -A", g)).toContain("never everything")
    expect(shell("publish", "git add .", g)).toContain("never everything")
    expect(shell("publish", "git commit --no-verify -F x", g)).toContain("--no-verify")
    expect(shell("publish", "git commit --amend", g)).toContain("--amend")
    expect(shell("publish", "git push --force origin fixora/run-1-x", g)).toContain("never force")
    expect(shell("publish", "git push -f origin fixora/run-1-x", g)).toContain("never force")
    expect(shell("publish", "git push origin main", g)).toContain("push only fixora/run-1-x")
    expect(shell("publish", "git push origin fixora/other", g)).toContain("push only fixora/run-1-x")
    expect(shell("publish", "git push origin --delete fixora/run-1-x", g)).toContain("never force")
    expect(shell("publish", "git checkout main", g)).toContain("publish only")
    // Without the grants nothing is allowed.
    expect(shell("publish", "git commit -F x", { grants: {} })).toContain("commit is not granted")
    expect(shell("publish", "git push -u origin fixora/run-1-x", { grants: { commit: true } })).toContain("push is not granted")
    expect(shell("publish", "glab mr create --title x", { grants: { commit: true, push: true } })).toContain("not approved")
    expect(shell("publish", "glab mr merge 1", g)).toContain("only glab mr create")
    expect(shell("publish", "bun test", g)).toContain("read-only helpers only")
  })

  test("restore: checkout of the previous branch and stash pop only", () => {
    expect(shell("restore", "git checkout main && git stash list && git stash pop stash@{0}")).toBeUndefined()
    expect(shell("restore", "git status --porcelain=v1 --untracked-files=all")).toBeUndefined()
    expect(shell("restore", "git checkout -f main")).toContain("plain checkout")
    expect(shell("restore", "git stash drop stash@{0}")).toBeUndefined()
    expect(shell("restore", "git stash clear")).toContain("only stash pop")
    expect(shell("restore", "git reset --hard")).toContain("restore only")
    expect(shell("restore", "bun test")).toContain("git only")
  })

  test("clean: delete the run's branch only; remote deletion needs the grant", () => {
    expect(shell("clean", "git branch -D fixora/run-1-x")).toBeUndefined()
    expect(shell("clean", "git branch -D main")).toContain("only the run's branch")
    expect(shell("clean", "git push origin --delete fixora/run-1-x")).toContain("not approved")
    expect(shell("clean", "git push origin --delete fixora/run-1-x", { grants: { deleteBranch: true } })).toBeUndefined()
    expect(shell("clean", "git push origin --delete main", { grants: { deleteBranch: true } })).toContain("only the run's branch")
  })

  test("crash, ticket and close-loop phases run no shell at all", () => {
    expect(shell("crash", "ls")).toContain("not allowed in the crash phase")
    expect(shell("ticket", "git status")).toBeUndefined() // read-only git is harmless everywhere
    expect(shell("ticket", "git checkout main")).toContain("read-only git only")
    expect(shell("ticket", "cat x")).toContain("not allowed in the ticket phase")
  })
})

const services: Services = {
  sentry: { id: "sentry", namespace: "sentry", serverName: "sentry", status: "connected", toolIds: [], capabilities: { getIssue: "sentry_get_issue_details", searchIssues: "sentry_search_issues", updateIssue: "sentry_update_issue" } },
  crashlytics: { id: "crashlytics", namespace: "firebase", serverName: "firebase", status: "connected", toolIds: [], capabilities: { getIssue: "firebase_crashlytics_get_issue", getReport: "firebase_crashlytics_get_report", createNote: "firebase_crashlytics_create_note" } },
  jira: { id: "jira", namespace: "jira_jira", serverName: "jira", status: "connected", toolIds: [], capabilities: { getIssue: "jira_jira_get_issue", search: "jira_jira_search", createIssue: "jira_jira_create_issue", addComment: "jira_jira_add_comment", transition: "jira_jira_transition_issue" } },
  gitlab: { id: "gitlab", namespace: "gitlab", serverName: "gitlab", status: "connected", toolIds: [], capabilities: { createMr: "gitlab_create_merge_request", getMr: "gitlab_get_merge_request", updateMr: "gitlab_update_merge_request" } },
}

describe("guardWorkerMcp", () => {
  test("source reads in analysis phases, source writes only with the grant", () => {
    expect(guardWorkerMcp("sentry_get_issue_details", worker("triage"), services)).toBeUndefined()
    expect(guardWorkerMcp("firebase_crashlytics_get_report", worker("crashes", { role: "lister", runId: undefined }), services)).toBeUndefined()
    expect(guardWorkerMcp("sentry_get_issue_details", worker("publish"), services)).toContain("not allowed")
    expect(guardWorkerMcp("sentry_update_issue", worker("triage"), services)).toContain("not granted")
    expect(guardWorkerMcp("firebase_crashlytics_create_note", worker("close-loop", { grants: { sourceWrite: true } }), services)).toBeUndefined()
    expect(guardWorkerMcp("firebase_crashlytics_list_events", worker("crash"), services)).toBeUndefined() // unknown id, read-like name
    expect(guardWorkerMcp("firebase_crashlytics_delete_issue", worker("crash"), services)).toContain("not granted")
  })
  test("jira reads everywhere (not the lister); writes need jiraWrite", () => {
    expect(guardWorkerMcp("jira_jira_get_issue", worker("triage"), services)).toBeUndefined()
    expect(guardWorkerMcp("jira_jira_search", worker("fix"), services)).toBeUndefined()
    expect(guardWorkerMcp("jira_jira_create_issue", worker("triage"), services)).toContain("Jira writes")
    expect(guardWorkerMcp("jira_jira_create_issue", worker("ticket", { grants: { jiraWrite: true } }), services)).toBeUndefined()
    expect(guardWorkerMcp("jira_jira_transition_issue", worker("close-loop", { grants: { jiraWrite: true } }), services)).toBeUndefined()
    expect(guardWorkerMcp("jira_jira_get_issue", worker("crashes", { role: "lister", runId: undefined }), services)).toContain("lister")
  })
  test("forge: create needs the mr grant, update needs mr or closeMr, reads in publish / sync / clean", () => {
    expect(guardWorkerMcp("gitlab_create_merge_request", worker("publish"), services)).toContain("not approved")
    expect(guardWorkerMcp("gitlab_create_merge_request", worker("publish", { grants: { mr: true } }), services)).toBeUndefined()
    expect(guardWorkerMcp("gitlab_update_merge_request", worker("clean", { grants: { closeMr: true } }), services)).toBeUndefined()
    expect(guardWorkerMcp("gitlab_get_merge_request", worker("sync"), services)).toBeUndefined()
    expect(guardWorkerMcp("gitlab_get_merge_request", worker("triage"), services)).toContain("forge reads")
    expect(guardWorkerMcp("unrelated_tool", worker("triage"), services)).toBeUndefined()
  })
})

describe("guardWorkerTool", () => {
  test("dispatches by tool kind and leaves fixora tools to their handlers", () => {
    expect(guardWorkerTool({ tool: "fixora_submit_fix", input: {}, worker: worker("triage"), services })).toBeUndefined()
    expect(guardWorkerTool({ tool: "edit", input: { path: "src/x.ts" }, worker: worker("triage"), services })).toContain("read-only")
    expect(guardWorkerTool({ tool: "bash", input: { command: "git push origin main" }, worker: worker("fix"), services })).toContain("publish phase")
    expect(guardWorkerTool({ tool: "jira_jira_create_issue", input: {}, worker: worker("fix"), services })).toContain("Jira writes")
    expect(guardWorkerTool({ tool: "read", input: { path: "/etc/hosts" }, worker: worker("fix"), services })).toBeUndefined()
  })
})
