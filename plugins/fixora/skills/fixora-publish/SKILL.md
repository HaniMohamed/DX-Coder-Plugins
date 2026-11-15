---
name: fixora-publish
description: Commit the reviewed Fixora fix with the prepared message, push the fixora/ branch and open the draft merge request through the provider order the prompt gives (GitLab/GitHub MCP, glab/gh, compare URL), reporting through fixora_submit_publish. Invoked by the /fixora command after the user approved; not for general use.
disable-model-invocation: true
---

# Fixora publish — exactly what was approved

The user saw a preview and approved this step. The prompt says which of commit / push / merge
request you may do; do only those, in order, and report what happened. Nothing here is creative:
the commit message and the MR body are prepared files, the branch and remote are given.

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
errors; then stop. Never retry a push or commit on your own initiative.
