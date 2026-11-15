import { describe, expect, test } from "bun:test"
import { DEFAULTS } from "../src/options.js"
import { codeModePath, crashFetchPrompt, crashListPrompt, feedbackPrompt, fixPrompt, opsPrompt, preparePrompt, publishPrompt, restoreSteps, reviewPrompt, ticketPrompt, triagePrompt } from "../src/prompts.js"
import { sampleRun } from "./state.test.js"

describe("prompts", () => {
  test("crash list and fetch carry the exact tool calls and the submit tool", () => {
    const p = crashListPrompt({ requestId: "list-1", plans: [{ source: "crashlytics", calls: [{ toolId: "firebase_crashlytics_get_report", namespace: "firebase", input: { appId: "1:1:android:a", report: "topIssues" }, appId: "1:1:android:a", label: "android" }] }], top: 5 })
    expect(p.skill).toBe("fixora-crashes")
    expect(p.text).toContain("tool `firebase_crashlytics_get_report` (CodeMode: `tools.firebase.crashlytics_get_report(input)`) (android)")
    expect(p.text).toContain("`execute` tool (CodeMode)")
    expect(p.text).toContain('const r0 = await tools.firebase.crashlytics_get_report({"appId":"1:1:android:a","report":"topIssues"})')
    expect(p.text).toContain('return await tools.fixora.submit_crashes({ version: 1, requestId: "list-1", results })')
    expect(p.text).toContain("forwarded by variable")
    expect(codeModePath("jira_jira_create_issue", "jira_jira")).toBe("tools.jira_jira.create_issue")
    expect(codeModePath("My-GitLab_create_mr", "My-GitLab")).toBe('tools["My-GitLab"].create_mr')
    expect(codeModePath("sentry_get_issue_details", undefined)).toBeUndefined()
    expect(codeModePath("sentry_get_issue_details", "firebase")).toBeUndefined()
    expect(p.text).toContain('"report": "topIssues"')
    expect(p.text).toContain('fixora_submit_crashes once with requestId "list-1"')
    const run = sampleRun({ source: "crashlytics", crashId: "abc" })
    const f = crashFetchPrompt(run, { primary: [{ toolId: "firebase_crashlytics_get_issue", input: { appId: "1:1:android:a", issueId: "abc" } }], followUps: [{ toolId: "firebase_crashlytics_batch_get_events", input: { appId: "1:1:android:a", names: ["<sample>"] }, note: "first choice" }], note: "Report appId." })
    expect(f.text).toContain("firebase_crashlytics_batch_get_events")
    expect(f.text).toContain("first choice")
    expect(f.text).toContain("fixora_submit_crash ONCE")
    expect(f.text).toContain('tools.fixora.submit_crash({ version: 1, runId: "sentry-4523123", source: "crashlytics", appId, issue, events })')
    expect(f.text).toContain("untrusted")
  })

  test("prepare: inspect stops on a dirty checkout; apply mentions the stash; existing branch and recorded values are relayed", () => {
    const run = sampleRun({ branch: undefined, checkout: { active: false } })
    const inspect = preparePrompt(run, DEFAULTS, { stage: "inspect", fallbackBranch: "fixora/sentry-4523123-typeerror" })
    expect(inspect.skill).toBe("fixora-prepare")
    expect(inspect.text).toContain("Step 1 — inspect")
    expect(inspect.text).toContain("no dependency installs here")
    expect(inspect.files).toEqual(["crash.md"])
    expect(inspect.text).toContain('stage "inspect"')
    expect(inspect.text).toContain("Fallback branch name when the repository has no naming convention: `fixora/sentry-4523123-typeerror`")
    const apply = preparePrompt(run, DEFAULTS, { stage: "apply", fallbackBranch: "fixora/x", stashApproved: true })
    expect(apply.text).toContain("git stash push -u -m fixora/sentry-4523123")
    expect(apply.text).toContain('stage "ready"')
    const resumed = preparePrompt(sampleRun({ checkout: { active: false, previousBranch: "feature/x", previousHeadSha: "abc1234", stashRef: "deadbeefdeadbeef" } }), DEFAULTS, { stage: "inspect", fallbackBranch: "fixora/x" })
    expect(resumed.text).toContain("already has branch `fixora/sentry-4523123-typeerror`")
    expect(resumed.text).toContain('previousBranch "feature/x"')
    expect(resumed.text).toContain("never stash a second time")
  })

  test("triage, fix, feedback, review name the run, the branch, the checks and the submit tool", () => {
    const run = sampleRun()
    const t = triagePrompt(run)
    expect(t.files).toEqual(["crash.md", "project.md"])
    expect(t.text).toContain("branch `fixora/sentry-4523123-typeerror`")
    expect(t.text).toContain("fixora_submit_triage")
    expect(t.text).toContain("Fixora does no frame mapping")
    expect(t.text).not.toContain("worktree")
    const checks = [{ kind: "unit" as const, command: "bun test", cwd: "" }, { kind: "typecheck" as const, command: "tsc --noEmit", cwd: "", optional: true }]
    const f = fixPrompt(run, DEFAULTS, { attempt: 2, checks })
    expect(f.text).toContain("Attempt 2")
    expect(f.text).toContain("`bun test`, `tsc --noEmit` (optional)")
    expect(f.text).toContain("git add -N . && git status --porcelain=v1 --untracked-files=all")
    expect(f.text).toContain("git diff HEAD")
    expect(f.text).toContain("Never commit, push, checkout, stash or reset")
    const fb = feedbackPrompt(run, { attempt: 3, message: "also guard null", checks })
    expect(fb.text).toContain('"""also guard null"""')
    expect(fb.text).toContain("changesMade=false")
    expect(fb.files).toContain("feedback.md")
    const r = reviewPrompt(run, { attempt: 1, fixAttempt: 2, checks })
    expect(r.files).toContain("diff.2.patch")
    expect(r.text).toContain("fixora_submit_review")
    expect(r.text).toContain("Do not edit files")
  })

  test("ticket and publish spell out the exact inputs and commands", () => {
    const run = sampleRun()
    const t = ticketPrompt(run, { namespace: "jira_jira", searchTool: "jira_jira_search", searchInput: { jql: "x" }, createTool: "jira_jira_create_issue", createInput: { project_key: "APP" }, browseBase: "https://jira.example.com" })
    expect(t.text).toContain("tool `jira_jira_search` (CodeMode: `tools.jira_jira.search(input)`)")
    expect(t.text).toContain('"project_key": "APP"')
    expect(t.text).toContain("additional_fields")
    expect(t.text).toContain("fixora_submit_ticket")
    const p = publishPrompt(run, {
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
        { provider: "gitlab-mcp", toolId: "gitlab_create_merge_request", input: { project_id: "mobile/shop", source_branch: "fixora/sentry-4523123-typeerror" } },
        { provider: "glab", command: "glab mr create --source-branch fixora/sentry-4523123-typeerror --target-branch main --title Guard --description-file /repo/.dxcoder/fixora/x/mr.md --yes --remove-source-branch --draft" },
        { provider: "url", url: "https://gitlab.example.com/mobile/shop/-/merge_requests/new?x" },
      ],
    })
    expect(p.skill).toBe("fixora-publish")
    expect(p.text).toContain("git add -- src/cart/service.ts src/cart/service.test.ts")
    expect(p.text).toContain("git commit -F /repo/.dxcoder/fixora/x/commit-message.txt --signoff")
    expect(p.text).toContain("git push -u origin fixora/sentry-4523123-typeerror")
    expect(p.text).toContain("a) gitlab-mcp: tool `gitlab_create_merge_request`")
    expect(p.text).toContain("b) glab: `glab mr create")
    expect(p.text).toContain("c) no provider worked")
    expect(p.text).toContain("fixora_submit_publish ONCE")
    const partial = publishPrompt(run, { commit: false, push: false, mr: true, files: [], commitMessageFile: "/c", mrBodyFile: "/m", signoff: false, remote: "origin", branch: "b", target: "main", attempts: [], committedSha: "0123456789abcdef", pushedAlready: true })
    expect(partial.text).toContain("already committed as 0123456789")
    expect(partial.text).toContain("already pushed")
    expect(partial.text).not.toContain("git commit")
  })

  test("ops prompt lists steps verbatim; restore steps come from the checkout record", () => {
    const run = sampleRun({ checkout: { active: true, previousBranch: "main", previousHeadSha: "abc", stashRef: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d" } })
    const steps = restoreSteps(run)
    const o = opsPrompt({ runId: run.runId, op: "restore", title: "restore", steps, report: "{ branch }", repo: "/repo" })
    expect(o.skill).toBe("fixora-ops")
    expect(o.text).toContain("2. `git checkout main`")
    expect(o.text).toContain("git stash pop")
    expect(o.text).toContain('fixora_submit_ops ONCE with op "restore", runId "sentry-4523123"')
    const c = opsPrompt({ op: "close-loop", title: "link", steps: [{ call: { toolId: "jira_jira_add_comment", input: { issue_key: "APP-1", comment: "hi" } } }], report: "{}", repo: "/repo" })
    expect(c.text).toContain("tool `jira_jira_add_comment`")
    expect(c.text).toContain('"issue_key": "APP-1"')
  })
})
