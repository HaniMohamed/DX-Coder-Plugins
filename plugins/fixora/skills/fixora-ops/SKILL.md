---
name: fixora-ops
description: Run the small bookkeeping steps of a Fixora run exactly as listed by the /fixora command (restore the checkout, Jira ticket / comment / transition, merge request update, close or status, branch cleanup, crash-source note) and report through fixora_submit_ops or fixora_submit_ticket. Invoked by the /fixora command; not for general use.
disable-model-invocation: true
---

# Fixora ops — listed steps, nothing else

The prompt names an operation and lists its steps: tool calls with exact inputs, or shell commands.
Run them in order, in the repository you are in, and report. Do not add steps, do not retry with
different inputs, do not "clean up" anything that was not listed.

MCP tool calls (Jira, GitLab, GitHub, crash sources) go through the `execute` tool (CodeMode) as
`tools.<server>.<tool>(input)`; the prompt prints that path next to each tool id. Pass the input exactly.

## Operations

- **restore** — put the user's checkout back: `git checkout <previous branch or commit>`, then, when a
  stash is named, `git stash list` to find the entry whose message is `fixora/<runId>` and
  `git stash pop stash@{n}`. If the pop conflicts, leave the stash in place, do not resolve anything,
  and report `ok: false` with the conflicting files in `errors[]`.
  When the prompt says to keep an uncommitted fix (its first step says so and the report has a `kept`
  field): if `git status` lists anything outside `.dxcoder/` and generated paths, stop right there,
  leave the fix branch checked out and the stash untouched, and report `ok: true` with
  `{ "branch": "<fix branch>", "stashPopped": false, "kept": true }`; a clean status continues with
  the checkout and the pop and reports `kept: false`.
  Otherwise (a `clean` or `restart`), if the fix branch still has uncommitted changes, do not discard
  them: report them in `errors[]` and still check the previous branch out when git allows it
  (`git checkout` refuses when they would be lost — report that too).
  Results: `{ "branch": "<branch now checked out>", "stashPopped": true|false }`.
- **close-loop** — Jira comment with the MR link, optional transition, optional note on the crash
  source. For the transition: call the "get transitions" tool, pick the one whose name matches the
  wanted name ignoring case and punctuation ("In Review" ≈ "in-review" ≈ "Review"), apply it; when
  none matches, skip it and say so. Results: `{ "comment": true, "transition": "In Review" | "none", "note": true|false }`.
- **ticket** (reported with `fixora_submit_ticket`, not `fixora_submit_ops`) — search with the given
  JQL; reuse a hit (`action: "reused"`), else create with the given input (`action: "created"`). If the
  server rejects `additional_fields` as the wrong type, resend once with the other encoding (JSON
  string ↔ object). Any other failure → `action: "failed"` with the exact error.
- **sync** — read the merge request state with the given tool / command and report
  `{ "status": "draft" | "open" | "merged" | "closed" }` (merged when it has a merge date or state merged).
- **close-mr** — close the merge request with the given tool / command. Results: `{ "closed": true }`.
- **jira-comment** — add the given comment. Results: `{ "commented": true }`.
- **clean** — `git branch -D <branch>` for the run's branch only (skip, and say so, when it is the
  current branch or does not exist), and `git push <remote> --delete <branch>` only when listed.
  Results: `{ "localDeleted": true|false, "remoteDeleted": true|false }`.
- **annotate** — post the given note on the crash source. Results: `{ "noted": true }`.

## Report (`fixora_submit_ops`)

```json
{
  "version": 1,
  "runId": "sentry-4523123",
  "op": "restore",
  "ok": true,
  "results": { "branch": "feature/checkout-v2", "stashPopped": true },
  "errors": []
}
```

`ok` is false when any listed step failed; put each failure's exact error in `errors[]`. Call the
tool once, correct and resubmit on validation errors, then stop. Never run commands or call tools
that were not listed, never touch files, never use the network except through the listed MCP tools
and `glab` / `gh`.
