---
name: fixora-publish
description: Commit the reviewed Fixora fix with the prepared message, push the fixora/ branch and open the draft merge request through the provider order the prompt gives (GitLab/GitHub MCP, glab/gh, compare URL), reporting through fixora_submit_publish. Invoked by the /fixora command after the user approved; not for general use.
disable-model-invocation: true
---

# Fixora publish — exactly what was approved

The user saw a preview and approved this turn. The prompt lists, in order, which of these you do:
Jira ticket, commit, push, merge request, links (Jira comment / transition, crash-source note) and,
always last, the restore of the user's checkout. Do only the listed steps, in that order, in this one
turn, and report each with the tool the prompt names (`fixora_submit_ticket`, `fixora_submit_publish`,
`fixora_submit_ops`). Nothing here is creative: the commit message and the MR body are prepared
files, the branch and remote are given, the tool inputs are given.

## Jira ticket (only when listed)

Search with the given JQL; reuse a hit (`fixora_submit_ticket` with action `reused`), else create
with the given input (action `created`), then carry on. If the server rejects `additional_fields`
as the wrong type, resend once with the other encoding (JSON string ↔ object). Any other failure →
action `failed` with the exact error, and carry on with the next step. Where later steps say `<key>`,
use the ticket key; `git commit … --trailer "Jira: <key>"` adds it to the commit, and `{{JIRA}}` in
the MR body is replaced by the key and url (or the line is deleted when no ticket exists).

## Commit (only when the prompt grants it)

- `git add -- <file> <file> …` with the files of the fix report, named one by one. Never `git add -A`,
  `git add .`, `git add -u`. Lockfiles or caches touched by dependency setup stay unstaged.
- `git commit -F <commit-message.txt>` (plus `--signoff` only when the prompt says so). Never
  `--no-verify`, never `--amend`, never `-a`. If a commit hook fails, do not work around it: stop and
  put its output in `errors[]`.
- `git rev-parse HEAD` → `committed.sha`.

## Push (only when granted)

- `git push -u <remote> <branch>` for the branch named in the prompt and nothing else. Never
  `--force`, `--force-with-lease`, `--delete`, `--mirror`, `--all`, `--tags`.
- If the remote branch already exists with commits that are not yours, stop and report it in
  `errors[]` (Fixora decides what to do).
- Report `pushed: { remote, branch, remoteSha }` with `remoteSha` = `git rev-parse HEAD`.

## Merge request (only when granted)

Try the providers in the order the prompt lists, top to bottom, and stop at the first success:

- **MCP tool** (GitLab / GitHub server): call it through the `execute` tool (CodeMode) as
  `tools.<server>.<tool>(input)` (the prompt prints the path) with the exact input from the prompt; where
  the input says `<contents of mr.md>` paste the body file verbatim. The reply carries the MR URL.
- **CLI** (`glab mr create …` / `gh pr create …`): run the exact command line; the URL is in its
  output. A missing or unauthenticated CLI (`command not found`, "not logged in") means "skip this
  provider", not "fix the environment".
- **No provider worked**: report `mrSkipped: { reason, compareUrl }` with the compare URL from the
  prompt so the user can open it by hand.

Report `mr: { url, id, provider, status }` where `provider` is one of `gitlab-mcp`, `github-mcp`,
`glab`, `gh`, `status` is `draft` or `open`, and `url` is the merge request / pull request page.

**Labels.** The merge request must carry the label(s) the prompt names (`fixora`): Fixora finds its
own merge requests by them later. When the MR was created through an MCP tool and its reply does not
list them (the create tool had no labels field, or it is GitHub), add them right away with the step
the prompt gives for that provider (`<id>` = the iid / number from the reply): the update tool, or
`glab mr update <id> --label fixora` / `gh pr edit <id> --add-label fixora`. A refused label is an
entry in `errors[]`, never a reason to drop the MR from the report.

## Report (`fixora_submit_publish`)

```json
{
  "version": 1,
  "runId": "sentry-4523123",
  "committed": { "sha": "0123456789abcdef0123456789abcdef01234567", "files": ["src/cart/service.ts", "src/cart/service.test.ts"] },
  "pushed": { "remote": "origin", "branch": "fixora/sentry-4523123-guard-coupon", "remoteSha": "0123456789abcdef0123456789abcdef01234567" },
  "mr": { "url": "https://gitlab.example.com/mobile/shop/-/merge_requests/418", "id": "418", "provider": "gitlab-mcp", "status": "draft" },
  "errors": []
}
```

Partial results are expected and fine (for example committed and pushed, MR skipped): report what
succeeded and the exact error of what did not. Call the tool once; correct and resubmit on validation
errors; then carry on with the links and the restore. Never retry a push or commit on your own initiative.

## Links (only when listed)

Make the listed Jira / crash-source calls with `<key>` and `<mrUrl>` filled in; for the transition,
pick the one whose name matches the wanted name ignoring case and punctuation, skip it when none
matches. Report with `fixora_submit_ops` op `close-loop`: `{ ok, results: { comment, transition, note }, errors }`.

## Restore (always last, even after a failed step)

Run the listed commands: `git checkout <previous branch or commit>`, then, when a stash is named,
`git stash list` to find the entry whose message is `fixora/<runId>` and `git stash pop stash@{n}`.
If the pop conflicts, leave the stash in place, do not resolve anything, and report `ok: false` with
the conflicting files. Report with `fixora_submit_ops` op `restore`:
`{ ok, results: { branch, stashPopped }, errors }`. Then stop.
