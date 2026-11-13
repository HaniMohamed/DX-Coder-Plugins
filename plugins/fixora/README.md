# fixora

Adds a `/fixora` command to DXcoder that turns production crashes into reviewed, tested draft
merge requests. It reads crashes from Sentry or Firebase Crashlytics through their MCP servers
(or from a pasted stack trace), maps the stack trace to code on the base branch, runs the DXcoder
coding agent in a fresh git worktree to find the root cause and write the smallest correct fix with
a regression test, runs the project's lint / typecheck / tests itself, has an independent agent
session review the diff, commits, pushes and opens a draft MR on GitLab or GitHub, and links the
MR on a Jira ticket when a Jira MCP server is available. Works on any codebase: Flutter/Dart,
Kotlin/Java, Swift, JavaScript/TypeScript, Python, Go, .NET, Rust.

## Commands

| Command | What it does |
|---|---|
| `/fixora` | List the top crashes from every connected source. The agent then asks which to fix and starts the runs. |
| `/fixora fix <source>:<id> \| <crash url>` | Fix one crash, e.g. `sentry:4523123`, `crashlytics:deadbeef`, a Sentry issue URL or a Firebase console issue URL. `/fixora sentry:123` is a shortcut. |
| `/fixora paste <file> [--title ".."] [--platform ..] [--language ..]` | Fix a stack trace saved in a file. No MCP server needed. |
| `/fixora top [N]` | Fix the top N new crashes (default 1). |
| `/fixora batch [--top N] [--min-users N] [--source s] [--minutes M]` | Batch mode with a time budget. |
| `/fixora status [<runId>]` | Runs table, or one run in detail (steps, timings, links, worktree). |
| `/fixora retry <runId> [--from <step>] [--fresh]` | Resume a stopped run from where it stopped (or from a step); `--fresh` recreates the worktree. |
| `/fixora feedback <runId> "<message>"` | Fix copilot: ask a question about the fix or request a change. Changes are re-validated, re-reviewed, pushed and the MR is updated. |
| `/fixora restart <runId>` | Close the MR, note it on Jira, and start a fresh fix cycle on a new branch. |
| `/fixora fixed <runId> --release <X> [--platform android\|ios\|web]` | Release tracking: if the same crash fingerprint shows up later, it is flagged as reopened with a likely reason. |
| `/fixora report [--days 30]` | Funnel (detected → analysed → fixed → validated → reviewed → pushed → MR → merged), timings, MR status, reopen rate, top platforms/versions. |
| `/fixora sync` | Refresh MR statuses (merged / closed). |
| `/fixora clean <runId> [--remote]` | Remove the worktree (and, after approval, the remote branch). |

Flags: `--dry-run` (stop before commit; writes the MR body and commit message to the run folder),
`--no-ticket`, `--no-mr`, `--no-push`, `--auto` (auto-approve when confidence, checks, review and
risk allow it), `--force` (start over), `--force-triage` (analyse even when frames do not map or
symbolication is missing), `--test-first`, `--base <branch>`, `--model <providerID/modelID>`,
`--review quick|session`, `--tests full|mapped|skip`.

## Flow

1. **detect** — git repository, remote, connected MCP servers (Sentry, Firebase, Jira, GitLab, GitHub). Nothing is registered by the plugin; it only detects what you configured.
2. **fetch** — crash → normalised model (frames innermost first, in-app flags, fingerprint, symbolication check). Crash data is written to `.dxcoder/fixora/<runId>/crash.md` inside "untrusted" banners. Same fingerprint across sources or a crash marked fixed earlier is detected here (dedupe, reopen).
3. **map** — `git fetch` of the base branch, frame → file candidates from `git ls-tree` with path-suffix scoring, early stop for crashes with no in-app frames or missing symbols.
4. **branch** — a fresh worktree from `<remote>/<base>` (via the host's worktree API) and branch `fixora/<runId>-<slug>`.
5. **analyse** — a worker session (the host's coding agent, `worker.agent`) runs the `fixora-triage` skill read-only in the worktree and submits a structured root cause through the `fixora_submit_triage` tool (classification, mapped frames with evidence, suspect commits, confidence, strategy, alternatives). Low confidence or non-fixable classifications stop here with a report.
6. **ticket** — optional Jira Bug (deduplicated by a fingerprint marker) after approval.
7. **fix** — the same worker session runs the `fixora-fix` skill: minimal change, regression test, project checks, `fixora_submit_fix` (validated against `git status`, forbidden paths and limits).
8. **validate** — the plugin runs the detected check commands (lint, typecheck, unit tests — subset first, then the full suite within the time budget). Failures go back to the worker, up to `maxFixRounds`.
9. **review** — a fresh, read-only reviewer session runs the `fixora-review` skill (or a one-shot model call in `quick` mode). A rejection goes back to the worker with the findings, up to `maxReviewRounds`.
10. **commit** — secret scan of the added lines, conventional commit (`fix(<scope>): …` with `Fixora-Run` / `Fixora-Fingerprint` trailers). Hooks run; never `--no-verify`.
11. **push** — one approval dialog (`fixora.publish`) showing branch, files, checks, review and the MR body; then `git push -u` (never force, never the base branch).
12. **mr** — draft MR via the GitLab/GitHub MCP server, else the `glab` / `gh` CLI, else a compare URL to open by hand. The MR body explains what broke, the root cause with evidence, what changed, how it was verified, the review verdict and the rollback.
13. **close-loop** — Jira comment with the MR link and transition, optional note on the crash source.

Every step is persisted; `/fixora retry` resumes where a run stopped. Worker sessions are confined
by session permission rules (no Jira/GitLab/Sentry write tools, no web, no git state changes) and by
a tool hook that rejects writes outside the worktree, writes to protected paths (CI, lockfiles,
generated files, secrets) and dangerous shell commands. All approvals go through the host's
permission dialog; the plugin never pushes, creates tickets or MRs without one (unless `approvals: "auto"`).

Run folder `.dxcoder/fixora/<runId>/`: `crash.json`, `crash.md`, `mapping.md`, `project.md`,
`conventions.md`, `triage.json`, `analysis.md`, `fix.<n>.json`, `diff.<n>.patch`,
`verification.<n>.json`, `checks/*.log`, `review.<n>.json`, `publish-preview.md`, `mr.md`, `run.log`.
`.dxcoder/fixora/.gitignore` is created with `*`.

## TUI

The package also ships a TUI entry (`./tui`, loaded automatically by DXcoder next to the server
entry). With it:

- **`/fixora`** opens a searchable picker of the top crashes grouped by source (users affected,
  version, age, NEW / REOPENED / MR badges), with `ctrl+t` "fix top 3" and `ctrl+r` refresh, plus a
  "paste a stack trace" entry. Picking a crash shows a one-line confirmation, then starts the run.
- A **live pipeline panel** opens in the session (`/fixora panel` or the palette toggles it): stage
  checklist with spinner and timings, retry counters, the root-cause card with a confidence meter and
  "introduced by" line, the diff / checks / review summary, the Jira key, and the MR link when done.
  Keys: `a` answer approval, `r` retry, `R` restart, `c` cancel, `w` jump to the worker session,
  `d` feedback, `y` copy the MR URL, `l` all runs, `f` fullscreen, `esc` close.
- **Approvals** become a dialog: branch, files and line counts, checks, review verdict, confidence
  and risk, the MR title and body (`v` expands it). `a` approves, `r` rejects with feedback, `esc`
  decides later (the composer strip, the sidebar badge, the footer chip and the palette command
  "Fixora: answer pending approval" bring it back). Without a TUI, or when nobody answers within
  the acknowledgement window, the host's permission prompt is used instead.
- **Pages:** `/fixora status` (or `/fixora runs`) lists every run with status, step, Jira and MR
  (`enter` opens its session and panel, `a`/`r`/`R`/`x`/`m` act on it, `s` syncs MR statuses);
  `/fixora report` shows the funnel, the 30-day trend, timings, MR and reopen statistics.
- Toasts and OS notifications (with sounds) on start, decision needed, done, failed and reopened crashes.

Everything else (`fix`, `paste`, `top`, `batch`, `fixed`, `clean`, flags) is forwarded to the server
command, so the two entries behave the same. `bun run build` bundles the TUI entry as `dist/tui.js`
with `solid-js` and `@opentui/*` left external (the host provides them).

## Setup

Add at least one crash source MCP server to `opencode.jsonc`, optional Jira and GitLab/GitHub
servers, and the plugin:

```jsonc
{
  "mcp": {
    "servers": {
      "sentry": { "type": "remote", "url": "https://mcp.sentry.dev/mcp" },
      "firebase": { "type": "local", "command": ["npx", "-y", "firebase-tools@latest", "mcp"] },
      "jira": { "type": "local", "command": ["mcp-atlassian"], "environment": { "JIRA_URL": "https://jira.example.com", "JIRA_PERSONAL_TOKEN": "<pat>" } },
      "gitlab": { "type": "local", "command": ["npx", "-y", "@zereight/mcp-gitlab"], "environment": { "GITLAB_API_URL": "https://gitlab.example.com/api/v4", "GITLAB_PERSONAL_ACCESS_TOKEN": "<token>" } }
    }
  },
  "plugins": [
    {
      "package": "git+https://<your-git-host>/<org>/dxcoder-plugins.git#path:plugins/fixora",
      "options": {
        // all optional
        "sources": ["sentry", "crashlytics"],
        "baseBranch": "main", "remote": "origin", "branchPrefix": "fixora/",
        "worker": { "agent": "build", "model": "anthropic/claude-sonnet-4-5", "shell": "allow", "maxPhaseMinutes": { "triage": 10, "fix": 20, "review": 10 } },
        "review": { "mode": "session" },
        "testCommands": { "unit": null, "integration": null, "lint": null, "typecheck": null, "timeoutSec": 600, "fullSuiteMaxMinutes": 15 },
        "validate": { "denyPaths": [], "maxFilesChanged": 10, "maxDiffLines": 400, "requireTestChange": true },
        "maxFixRounds": 3, "maxReviewRounds": 3,
        "confidence": { "minToFix": 0.4, "minToPublish": 0.6, "autoApprove": 0.85 },
        "approvals": "publish",
        "mode": "fix",
        "jira": { "project": "APP", "issueType": "Bug", "labels": ["fixora"], "transitionOnMr": "In Review", "ticketOnSkip": false },
        "mr": { "draft": true, "labels": ["fixora"], "reviewers": [], "target": null, "forge": null },
        "sourceWriteBack": false,
        "crashlytics": { "appId": "1:1234567890:android:abcdef" },
        "sentry": { "organization": "acme", "project": "shop" },
        "inAppPackages": ["com.example.app"], "appPackage": "my_app",
        "worktree": { "root": null, "keep": "until-merged" },
        "batch": { "top": 5, "minUsers": 5, "maxMinutes": 90 },
        "signoff": false, "allowSecretPatterns": [], "gitignore": true
      }
    }
  ]
}
```

Install the plugin:

```sh
dxcoder plugin add 'git+https://<your-git-host>/<org>/dxcoder-plugins.git#path:plugins/fixora'
```

### Options

| Option | Default | Meaning |
|---|---|---|
| `sources` | both | Which crash sources to use when their MCP server is connected. Pasted traces always work. |
| `baseBranch`, `remote`, `branchPrefix` | `main`, `origin`, `fixora/` | Where fixes start from and how branches are named. |
| `worker.agent` / `worker.model` | `build` / host default | The coding agent (and model) used for the analysis, fix and review sessions. |
| `worker.shell` | `allow` | Whether the worker may run shell commands (tests). `ask` or `deny` to tighten. |
| `worker.maxPhaseMinutes` | 10 / 20 / 10 | Time budget per phase; the session is interrupted and the run can be resumed. |
| `review.mode` | `session` | `session` = independent reviewer session; `quick` = one model call with the diff. |
| `testCommands.*` | detected | Override the lint / typecheck / unit / integration commands; `""` or `null` disables a kind. |
| `validate.*` | 10 files / 400 lines | Change-set limits; `denyPaths` adds protected globs. |
| `maxFixRounds`, `maxReviewRounds` | 3 / 3 | How often failing checks or a rejecting review send the worker back. |
| `confidence.*` | 0.4 / 0.6 / 0.85 | Minimum confidence to attempt a fix, to publish, and to auto-approve. |
| `approvals` | `publish` | `publish` = one dialog for push + MR; `each` = separate dialogs; `auto` = no dialog when confidence, checks, review and risk allow. |
| `mode` | `fix` | `test-first` makes the worker write a failing reproduction test before the fix. |
| `jira.*` | — | Project key enables tickets; issue type, labels, transition after the MR, REST credentials as a fallback to the MCP server. |
| `mr.*` | draft | Draft MRs, labels, reviewers, target branch, forge override (`gitlab` / `github`). |
| `sourceWriteBack` | false | Post a note with the MR link on the Sentry / Crashlytics issue. |
| `crashlytics.appId`, `sentry.organization` / `project` | — | Needed by the respective MCP tools when not derivable from a URL. |
| `inAppPackages`, `appPackage` | — | Package / module prefixes that count as application code. |
| `worktree.root`, `worktree.keep` | host default, `until-merged` | Where worktrees go and when they are removed. |

## Offline / restricted machines: single-folder bundle

`bun run build` bundles `index.ts` (+ `src/rpc.ts`) and `gray-matter` into `dist/`, keeping only
`@opencode/plugin` and `effect` external because the host provides them. `bun run pack` also writes
`fixora-<version>-dist.tgz` (+ `.sha256`) whose `INSTALL.md` explains the config. Reference the
extracted folder by absolute path in `opencode.jsonc`: `"plugins": [{ "package": "/opt/dxcoder/fixora" }]`.

## Development

```sh
bun install
bun run typecheck
bun test plugins/fixora
```

The tests cover the pure modules (stack-trace parsers for every ecosystem, fingerprinting,
frame→file mapping, toolchain detection, secret scanning, validators, permission rules and guards,
MCP detection, source adapters against fixture JSON, Jira REST against a mock server) and the git
helpers against a temporary repository with a bare remote.

## Verification checklist (manual, before a release)

1. Sentry MCP connected, Node repo with tests: `/fixora fix sentry:<id>` → triage card, fix, checks, review, publish dialog, draft MR with the full body, Jira Bug created with the fingerprint marker and transitioned; re-run → "already has a merge request", no duplicates.
2. `/fixora paste trace.txt` with the same crash → dedupe by fingerprint links to the existing run.
3. Crashlytics Flutter crash on a GitHub repo without a GitHub MCP but with `gh` installed → PR via the CLI.
4. Repo without tests (Go / Swift) → typecheck-only verification plus a worker-written test; the MR says so.
5. Obfuscated Android crash → `needs symbolication` stop with instructions; `--force-triage` path.
6. Plant `AKIA…` in a touched file → commit blocked; edit, `retry --from commit`.
7. `maxReviewRounds: 1` with a bad strategy → `review-exhausted`, branch kept locally.
8. Kill DXcoder during `fix` → `/fixora status` shows `fix`; `/fixora retry` resumes the session.
9. Revoke push credentials → push fails with a masked error; restore; `retry --from push`.
10. `/fixora feedback <id> "…"` → change applied, re-reviewed, MR updated; `/fixora restart <id>` closes the MR and starts `-r2`.
11. `/fixora fixed <id> --release 1.2.0`, then a later event with the same fingerprint → reopened warning with the reason.
12. `/fixora batch --top 3 --minutes 10` → stops cleanly between crashes; `/fixora report` shows the funnel and timings.
