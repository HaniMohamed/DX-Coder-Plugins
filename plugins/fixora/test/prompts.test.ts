import { describe, expect, test } from "bun:test"
import { DEFAULTS } from "../src/options.js"
import { codeModePath, crashListPrompt, opsPrompt, publishPrompt, restoreSteps, reviewPrompt, workPrompt } from "../src/prompts.js"
import { sampleRun } from "./state.test.js"

describe("prompts", () => {
  test("crash list carries the exact tool calls, the CodeMode paths and the forwarding script", () => {
    const p = crashListPrompt({ requestId: "list-1", plans: [{ source: "crashlytics", calls: [{ toolId: "firebase_crashlytics_get_report", namespace: "firebase", input: { appId: "1:1:android:a", report: "topIssues" }, appId: "1:1:android:a", label: "android" }] }], top: 5 })
    expect(p.skills).toEqual(["fixora-crashes"])
    expect(p.text).toContain("tools.firebase.crashlytics_get_report")
    expect(p.text).toContain('"report": "topIssues"')
    expect(p.text).toContain('const r0 = await tools.firebase.crashlytics_get_report({"appId":"1:1:android:a","report":"topIssues"})')
    expect(p.text).toContain('tools.fixora.submit_crashes({ version: 1, requestId: "list-1", results })')
    expect(codeModePath("jira_jira_create_issue", "jira_jira")).toBe("tools.jira_jira.create_issue")
    expect(codeModePath("My-GitLab_create_mr", "My-GitLab")).toBe('tools["My-GitLab"].create_mr')
    expect(codeModePath("sentry_get_issue_details", undefined)).toBeUndefined()
    expect(codeModePath("sentry_get_issue_details", "firebase")).toBeUndefined()
  })

  test("work turn: one prompt with every stage, the continue rule, the stash and resume facts", () => {
    const run = sampleRun({ branch: undefined, checkout: { active: false }, triage: undefined })
    const checks = [{ kind: "unit" as const, command: "bun test", cwd: "" }, { kind: "typecheck" as const, command: "tsc --noEmit", cwd: "", optional: true }]
    const w = workPrompt(run, DEFAULTS, { stages: ["fetch", "prepare", "triage", "fix"], fetch: { primary: [{ toolId: "sentry_get_issue_details", namespace: "sentry", input: { issueId: "4523123" } }], followUps: [{ toolId: "sentry_search_errors", namespace: "sentry", input: { query: "issue:4523123" }, note: "only without frames" }], note: "Submit the issue reply verbatim." }, fallbackBranch: "fixora/sentry-4523123-typeerror", attempt: 1, checks })
    expect(w.skills).toEqual(["fixora-crashes", "fixora-prepare", "fixora-triage", "fixora-fix"])
    expect(w.files).toEqual(["crash.md", "project.md", "triage.json", "limits.json"])
    expect(w.text).toContain("CONTINUE")
    expect(w.text).toContain("STOP")
    expect(w.text).toContain("tools.sentry.get_issue_details")
    expect(w.text).toContain("submit_crash")
    expect(w.text).toContain("fixora/sentry-4523123-typeerror")
    expect(w.text).toContain("fixora_submit_prepare")
    expect(w.text).toContain("fixora_submit_triage")
    expect(w.text).toContain("fixora_submit_fix")
    expect(w.text).toContain("bun test")
    expect(w.text).toContain("tsc --noEmit")
    expect(w.text).not.toContain("worktree")
    const apply = workPrompt(sampleRun({ branch: undefined, checkout: { active: false } }), DEFAULTS, { stages: ["prepare", "triage", "fix"], fallbackBranch: "fixora/x", stashApproved: true, attempt: 1, checks })
    expect(apply.skills).toEqual(["fixora-prepare", "fixora-triage", "fixora-fix"])
    expect(apply.text).toContain("git stash push -u -m fixora/sentry-4523123")
    const resumed = workPrompt(sampleRun({ checkout: { active: false, previousBranch: "feature/x", previousHeadSha: "abc1234", stashRef: "deadbeefdeadbeef" } }), DEFAULTS, { stages: ["prepare"], fallbackBranch: "fixora/x", attempt: 1, checks })
    expect(resumed.skills).toEqual(["fixora-prepare"])
    expect(resumed.text).toContain("fixora/sentry-4523123-typeerror")
    expect(resumed.text).toContain("feature/x")
    // A configured naming convention: exact name, the ticket step first, the fallback id when no ticket.
    const naming = { ...DEFAULTS, branchNaming: { template: "{type}/{ticket}-{slug}", type: "fix", example: "fix/DE-456-fix-crash-on-startup" } }
    const ticket = { namespace: "jira_jira", searchTool: "jira_jira_search", searchInput: { jql: "x" }, createTool: "jira_jira_create_issue", createInput: { project_key: "DE" }, browseBase: "https://jira.example.com" }
    const exact = workPrompt(sampleRun({ branch: undefined, checkout: { active: false }, jiraKey: undefined }), naming, { stages: ["prepare", "triage", "fix"], fallbackBranch: "fixora/fix/<key>-typeerror", exactBranch: true, ticket, ticketFallback: "4523123", attempt: 1, checks })
    expect(exact.text).toContain("from the configured naming convention ({type}/{ticket}-{slug}, e.g. fix/DE-456-fix-crash-on-startup): `fixora/fix/<key>-typeerror` — use it exactly, with <key> replaced by the Jira key from the ticket step below (or by 4523123 when no ticket could be created)")
    expect(exact.text).toContain("Before creating the branch (the name needs the ticket key):")
    expect(exact.text).toContain("tools.jira_jira.search")
    expect(exact.text).toContain("fixora_submit_ticket ONCE")
    expect(exact.text).toContain("then continue with the branch")
    expect(exact.text).toContain("the branch name is given, do not look for a convention")
    expect(exact.text).not.toContain("git branch -r --list")
    expect(exact.files).toContain("ticket-preview.md")
    const noTicket = workPrompt(sampleRun({ branch: undefined, checkout: { active: false } }), naming, { stages: ["prepare"], fallbackBranch: "fixora/fix/4523123-typeerror", exactBranch: true, ticketFallback: "4523123", attempt: 1, checks })
    expect(noTicket.text).toContain("`fixora/fix/4523123-typeerror` — use it exactly. Create it with `git checkout -b <name> origin/main`")
    expect(noTicket.text).not.toContain("Jira ticket")
    const fb = workPrompt(sampleRun(), DEFAULTS, { stages: ["fix"], fallbackBranch: "fixora/x", attempt: 3, checks, feedback: "also guard null" })
    expect(fb.skills).toEqual(["fixora-fix"])
    expect(fb.text).toContain("also guard null")
    expect(fb.text).toContain("changesMade")
    expect(fb.files).toContain("feedback.md")
  })

  test("review names the run, the diff and the submit tool", () => {
    const r = reviewPrompt(sampleRun(), { attempt: 1, fixAttempt: 2, checks: [{ kind: "unit", command: "bun test", cwd: "" }] })
    expect(r.skills).toEqual(["fixora-review"])
    expect(r.files).toContain("diff.2.patch")
    expect(r.text).toContain("fixora_submit_review")
  })

  test("publish turn: ticket, commit with the Jira trailer, push, MR attempts, links and restore in one prompt", () => {
    const run = sampleRun({ jiraKey: undefined, jiraUrl: undefined, checkout: { active: true, previousBranch: "main", previousHeadSha: "abc", stashRef: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d" } })
    const p = publishPrompt(run, {
      ticket: { namespace: "jira_jira", searchTool: "jira_jira_search", searchInput: { jql: "x" }, createTool: "jira_jira_create_issue", createInput: { project_key: "APP" }, browseBase: "https://jira.example.com" },
      commit: true,
      push: true,
      mr: true,
      files: ["src/cart/service.ts", "src/cart/service.test.ts"],
      commitMessageFile: "/repo/.dxcoder/fixora/x/commit-message.txt",
      mrBodyFile: "/repo/.dxcoder/fixora/x/mr.md",
      signoff: true,
      remote: "origin",
      branch: "fixora/sentry-4523123-typeerror",
      target: "main",
      attempts: [
        { provider: "gitlab-mcp", toolId: "gitlab_create_merge_request", namespace: "gitlab", input: { project_id: "mobile/shop", source_branch: "fixora/sentry-4523123-typeerror" } },
        { provider: "glab", command: "glab mr create --source-branch fixora/sentry-4523123-typeerror --target-branch main --title Guard --description-file /repo/.dxcoder/fixora/x/mr.md --yes --remove-source-branch --draft" },
        { provider: "url", url: "https://gitlab.example.com/mobile/shop/-/merge_requests/new?x" },
      ],
      closeLoop: [{ call: { toolId: "jira_jira_add_comment", namespace: "jira_jira", input: { issue_key: "<key>", comment: "MR <mrUrl>" } } }],
      restore: ["git checkout main", "git stash pop stash@{n}"],
    })
    expect(p.skills).toEqual(["fixora-publish"])
    expect(p.files).toContain("commit-message.txt")
    expect(p.files).toContain("mr.md")
    expect(p.text).toContain("tools.jira_jira.search")
    expect(p.text).toContain('"project_key": "APP"')
    expect(p.text).toContain("fixora_submit_ticket")
    expect(p.text).toContain("git add -- src/cart/service.ts src/cart/service.test.ts")
    expect(p.text).toContain("git commit -F /repo/.dxcoder/fixora/x/commit-message.txt")
    expect(p.text).toContain("--signoff")
    expect(p.text).toContain("Jira: <key>")
    expect(p.text).toContain("git push -u origin fixora/sentry-4523123-typeerror")
    expect(p.text).toContain("{{JIRA}}")
    expect(p.text).toContain("tools.gitlab.create_merge_request")
    expect(p.text).toContain("glab mr create")
    expect(p.text).toContain("merge_requests/new")
    expect(p.text).toContain("fixora_submit_publish")
    expect(p.text).toContain("jira_jira_add_comment")
    expect(p.text).toContain("close-loop")
    expect(p.text).toContain("git stash pop stash@{n}")
    expect(p.text).toContain('"restore"')
    const partial = publishPrompt(sampleRun(), { commit: false, push: false, mr: true, files: [], commitMessageFile: "/c", mrBodyFile: "/m", signoff: false, remote: "origin", branch: "b", target: "main", attempts: [], closeLoop: [], restore: ["git checkout main"], committedSha: "0123456789abcdef", pushedAlready: true })
    expect(partial.text).toContain("0123456789")
    expect(partial.text).toContain("APP-1831")
    expect(partial.text).not.toContain("git commit")
    expect(partial.text).not.toContain("{{JIRA}}")
  })

  test("ops prompt lists steps verbatim; restore steps come from the checkout record", () => {
    const run = sampleRun({ checkout: { active: true, previousBranch: "main", previousHeadSha: "abc", stashRef: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d" } })
    const steps = restoreSteps(run)
    const o = opsPrompt({ runId: run.runId, op: "restore", title: "restore", steps, report: "{ branch }", repo: "/repo" })
    expect(o.skills).toEqual(["fixora-ops"])
    expect(o.text).toContain("git checkout main")
    expect(o.text).toContain("git stash pop")
    expect(o.text).toContain('"restore"')
    expect(o.text).toContain("sentry-4523123")
    const c = opsPrompt({ op: "close-loop", title: "link", steps: [{ call: { toolId: "jira_jira_add_comment", input: { issue_key: "APP-1", comment: "hi" } } }], report: "{}", repo: "/repo" })
    expect(c.text).toContain("jira_jira_add_comment")
    expect(c.text).toContain('"issue_key": "APP-1"')
  })
})
