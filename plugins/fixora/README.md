# fixora

Adds a `/fixora` command (and one `/fixora:<verb>` command per verb) to DXcoder that turns production crashes into reviewed, tested draft
merge requests. Crashes come from Sentry or Firebase Crashlytics through their MCP servers (or
from a pasted stack trace). **The plugin itself does no work**: it orchestrates the DXcoder coding
agent, which runs in the repository checkout you already have open. The agent reads the crash
through the MCP tools, creates a `fixora/` branch in your checkout, finds the root cause, writes the
smallest correct fix with a regression test, runs the project's lint / typecheck / tests, a second
agent session reviews the change, and after your approval the agent commits, pushes, opens a draft
MR (GitLab / GitHub MCP, else `glab` / `gh`) and links it on a Jira ticket when a Jira MCP server is
available. When the run ends, for any reason, the agent checks your previous branch out again and
pops the stash it made of your uncommitted changes (only after you approved the stash).

Works on any codebase: Flutter/Dart, Kotlin/Java, Swift, JavaScript/TypeScript, Python, Go, .NET, Rust.

## Commands

| Command | What it does |
|---|---|
| `/fixora [--platform android\|ios\|web]` (or `/fixora:list`) | List the top crashes from every connected source (an agent session makes the MCP calls). `--platform` queries only the Firebase app of that platform (Sentry has no platform split and is skipped). Crashes Fixora already worked on are marked in the list with their state and their Jira / MR links (see below); the agent then asks which of the remaining ones to fix and starts the runs. |
| `/fixora:fix <source>:<id> \| <crash url>` | Fix one crash, e.g. `sentry:4523123`, `crashlytics:deadbeef`, a Sentry issue URL or a Firebase console issue URL. With several Firebase apps, `crashlytics:deadbeef@1:123:ios:abc` names the app (the picker and `/fixora` list print this form). `/fixora sentry:123` is a shortcut. |
| `/fixora:paste <file> [--title ".."] [--platform ..] [--language ..]` | Fix a stack trace saved in a file. No MCP server needed. |
| `/fixora:top [N] [--platform p]` | Fix the top N new crashes (default 1), one after the other (one checkout, one run at a time). |
| `/fixora:batch [--top N] [--min-users N] [--source s] [--platform p] [--minutes M]` | Batch mode with a time budget. |
| `/fixora:status [<runId>]` | Runs table, or one run in detail (steps, timings, links, checkout state). |
| `/fixora:retry <runId> [--from <step>] [--fresh]` | Resume a stopped run from where it stopped (or from a step); the agent checks the run's branch out again first, carrying an uncommitted fix along. After a fix-stage timeout the retry runs only the mapped tests (`--tests full` overrides). `--fresh` forgets the worker sessions and redoes the prepare phase. |
| `/fixora:feedback <runId> "<message>"` | Fix copilot: ask a question about the fix or request a change. Changes are re-validated, re-reviewed, committed, pushed and the MR is updated. |
| `/fixora:restart <runId>` | Cancel a running pipeline (restoring your checkout), close the MR, note it on Jira, and start a fresh fix cycle on a new branch. |
| `/fixora:fixed <runId> --release <X> [--platform android\|ios\|web]` | Release tracking: if the same crash fingerprint shows up later, it is flagged as reopened with a likely reason. |
| `/fixora:report [--days 30]` | Funnel (detected → analysed → fixed → validated → reviewed → pushed → MR → merged), timings, MR status, reopen rate, top platforms/versions. |
| `/fixora:sync` | Refresh MR statuses (merged / closed) through the agent. |
| `/fixora:doctor [--all] [--probe] [--tool <id>]` | Show the MCP servers and tools Fixora detects, which services it recognised, ignored legacy options, and the likely fix when a crash source is missing. `--all` lists every tool id; `--probe` has the agent make one real call per crash source and app and prints the raw reply; `--tool <id>` prints a tool's input schema. |
| `/fixora:reset [--files]` | Forget every stored record (runs, crash index, cached crash lists, locks) after approval; `--files` also deletes `<repo>/.dxcoder/fixora`. Branches, commits, MRs and Jira tickets are never touched. Useful between test rounds. |
| `/fixora:clean <runId> [--remote]` | Restore the checkout if a run left it on its branch, delete the local branch (and, after approval, the remote branch). |
| `/fixora:recover [--dry-run] [--force] [--all] [--state all\|open\|merged\|closed] [--limit N] [--label fixora]` | Rebuild the run records from the merge requests Fixora opened: after a `reset`, on a new machine, or when the host's database was lost. `--all` also finds MRs that went out without the label. See [Recovering runs from merge requests](#recovering-runs-from-merge-requests). |

Every verb is registered as its own command so the command palette lists them (`/fixora:status`, `/fixora:fix`, …); the long form `/fixora <verb> …` does the same thing.

### Recovering runs from merge requests

Fixora's memory (run records, crash index) lives in the host's plugin storage, so `/fixora reset`, a
lost database or a second machine leaves the crash list unaware of what was already fixed. The work
products survive on the remotes, and every MR Fixora opens is self-describing: the `fixora` label
(`mr.labels[0]`), a title ending in `(fixes crash <source>:<id>)`, a description with the crash,
the Jira link, the root cause, the confidence, the files changed, the review verdict and the risk,
and a footer with the run id and the fingerprint prefix; the commits carry `Fixora-Run` /
`Fixora-Fingerprint` trailers. `/fixora recover` reads all of that back:

1. A worker session (read-only apart from `git fetch`) lists the labelled MRs through the GitLab /
   GitHub MCP list tool, else `glab mr list` / `gh pr list`, page by page, and greps the commit
   trailers out of `git log --all` for the full fingerprints. The project path comes from
   `.git/config` when the plugin can read it; otherwise the worker runs `git remote get-url`.
2. The plugin parses the descriptions (nothing is guessed: an MR whose title / description do not
   match Fixora's layout is listed under *Skipped*), keeps one MR per run (merged beats open beats
   closed; a restart's `-r2` branch supersedes the closed one), and skips runs already recorded unless
   `--force`. `--all` drops the label filter and lists every merge request (narrowed to titles
   containing *fixes crash* where the forge can search), for MRs that were opened without the label:
   the label is never required to recognise a Fixora MR, only the title / description are.
3. `--dry-run` shows the table and stops. Otherwise one `fixora.recover` approval precedes the write.
   Each recovered run is `done` with its MR, Jira, branch, root cause, files and review; timings,
   worker sessions, check results and the checkout state are not stored in an MR and stay empty
   (`/fixora status <runId>` says so). The original description is saved as `mr.md` in the run
   folder. Only a full fingerprint (from a trailer) is put into the crash index, so reopen detection
   works again for those crashes; the 12-character prefix from the footer is kept on the run only.

After a recovery `/fixora` marks the recovered crashes as handled again, `/fixora sync` refreshes
the MR states and `/fixora fixed <runId> --release X` records the release of a merged fix. Note that
`/fixora feedback` re-renders the MR description from the recovered summary, which is shorter than
the original. The TUI offers the same action as *Fixora: recover runs from merge requests* in the
palette, `/fixora recover [--dry-run] [--force]` in the composer and `u` in the runs view.

### What the list says about crashes Fixora already handled

Every listed crash is matched against Fixora's run records and crash index, so the same crash is never
fixed twice by accident and the ticket and merge request are one click away. The markdown list (and
`<repo>/.dxcoder/fixora/crashes.md`) opens with a tally line such as *"3 of 10 already fixed by
Fixora (1 merged · 2 MR open) · 1 came back · 6 new"*, the **Fixora** column carries a badge and the
links, and an **Already handled by Fixora** block under the table lists, per crash, the run id, the
branch, `[DE-456](…) · [MR !418 merged](…)`, the release, the attempt number, when that happened,
and the command that makes sense next. The TUI picker shows the same badge, links and note on each row;
choosing a handled crash opens its links instead of starting a run, with a "Fix again" (`--force`) option.

| Badge | Meaning | Offered by the picker / `top`? | Next |
|---|---|---|---|
| ✓ fixed · MR !n open / draft | A reviewed fix is waiting in a merge request. | no | `/fixora feedback <runId> "…"`, then `/fixora fixed … --release X` once shipped |
| ✓ fixed · MR !n merged | The MR was merged (`/fixora sync` keeps this current). ⚠ *still seen* appears when the source reported the crash after the merge: it is not released yet, or the fix is incomplete. | no | `/fixora fixed <runId> --release X` |
| ✓ fixed in X | Marked shipped in release X and quiet since. | no | — |
| ✓ fixed on the branch / pushed, no MR / dry run | The run finished without an MR (`--no-mr`, `--no-push`, `--dry-run`). | no | `/fixora feedback`, `/fixora fixed` |
| ↻ came back after the fix in X | Marked fixed in X, but the source saw it again afterwards (the note says *seen in 2.3.0, fix shipped in 2.3.1* = fix not shipped, or *seen again in 2.3.2* = incomplete fix). Also set when an earlier fetch recorded the reopen. | yes | `/fixora restart <runId>` |
| ✗ MR !n closed without merging | The MR was closed, the fix was not taken. | no | `/fixora restart <runId>` or `/fixora fix <ref> --force` |
| ✗ failed / blocked / timeout at *step* | The run stopped; the note quotes the reason. | yes | `/fixora retry <runId>` |
| – skipped: reason | The agent classified it as not fixable here (third-party, needs symbolication, …). | no | `/fixora retry <runId>`, `/fixora status <runId>` |
| ◐ *stage* / ⏸ waiting for your approval | In progress right now. | no (greyed out) | `/fixora status <runId>` |

A reopen history ("reopened ×2, was fixed in 2.3.0") and the attempt number travel with every state,
so a crash that keeps coming back is visible at a glance.

Flags: `--dry-run` (stop before commit; writes the MR body and commit message to the run folder),
`--no-ticket`, `--no-mr`, `--no-push`, `--auto` (auto-approve when confidence, checks, review and
risk allow it; also auto-approves stashing), `--force` (start over), `--test-first`, `--base <branch>`,
`--model <providerID/modelID>`, `--tests full|mapped|skip` (`mapped` = the unit command with the test
files of the change appended; without the flag the agent runs the full suite only when it fits in
`testCommands.fullSuiteMaxMinutes`, else the mapped tests).

## Flow

A run is three agent turns on the happy path. The **work turn** (one fixer session) fetches the
crash, prepares the checkout, analyses and fixes: every `fixora_submit_*` reply tells the agent
CONTINUE or STOP, and the plugin flips the session's permission phase as it goes (read-only during
the analysis, writable during the fix). The **review turn** is a fresh session. The **publish turn**
creates the Jira ticket, commits, pushes, opens the MR, links it and restores your checkout, all
after one approval. The plugin validates every submission, persists it and decides what comes next.
Steps are idempotent; `/fixora retry` resumes where a run stopped.

| Step | Who | What happens |
|---|---|---|
| detect | plugin | Reads the host's tool list and MCP server statuses (Sentry, Firebase, Jira, GitLab, GitHub). Nothing is executed. |
| fetch | agent (`fixora-crashes`) | Calls the crash-source tools the plugin planned (issue, then the sample event) and submits the raw replies; the plugin parses them (firebase-tools ≥ 15 YAML and older JSON shapes), normalises frames, fingerprints, detects duplicates and reopened crashes. No frame mapping and no in-app / symbolication judgement: the frames go to the agent as reported. Pasted traces are parsed by the plugin directly. |
| prepare | agent (`fixora-prepare`) | Inspects your checkout. **Dirty tree → the run stops and asks you** (`fixora.stash` approval); only then the agent runs `git stash push -u`. Then `git fetch <remote> <base>`, a `fixora/…` branch following the repository's naming convention, `git checkout -b`, and a quick marker-file scan of the root and the crash's package(s) for the check commands. No installs here: the fix phase runs them only when a check needs them. |
| analyse | agent (`fixora-triage`) | Read-only root cause in the checkout: the agent locates the files of the frames itself (glob / grep), decides which frames are application code, uses `git log` / `git blame`, and submits classification (`fixable`, `third_party_only`, `needs_symbolication`, …), confidence, strategy, alternatives → `fixora_submit_triage`. Low confidence or non-fixable classifications stop here with a report. |
| ticket | agent, inside the prepare or publish turn | No approval: searches Jira for a ticket with the same fingerprint marker, reuses it or creates one with the exact input the plugin rendered; the key goes into the commit trailer and the MR body. |
| fix | agent (`fixora-fix`) | Minimal change plus a regression test in the checkout, the check commands run by the agent, then `git add -N . && git status --porcelain` and `git diff HEAD` submitted verbatim with the report. |
| validate | plugin | Pure checks on the submitted status / diff: forbidden paths, file and line limits, secret scan, failed checks. Problems go back to the agent, up to `maxFixRounds`. |
| review | agent (`fixora-review`) | A fresh, read-only reviewer session in the same checkout. A rejection goes back to the fixer with the findings, up to `maxReviewRounds`. |
| publish | agent (`fixora-publish`) | After the publish decision (`fixora.publish`: one dialog for push + MR, skipped when confidence is at least `confidence.autoApprove`): the ticket, `git add -- <files>`, `git commit -F` with the prepared conventional message (`fix(<scope>): …`, `Fixora-Run` / `Fixora-Fingerprint` trailers), `git push -u` (never force, never the base branch), then the MR through the first provider that works: GitLab / GitHub MCP → `glab` / `gh` → compare URL. The `mr.labels` (default `fixora`) go into the create call in the shape the tool's schema declares; when the create tool has no labels field (or it is GitHub), the agent adds them right after creation with the update tool or `glab mr update` / `gh pr edit`. |
| close-loop | agent, inside the publish turn | Jira comment with the MR link and transition, optional note on the crash source. |
| restore | agent, inside the publish turn | **On every exit path** (done, failed, rejected, blocked, cancelled): `git checkout <your previous branch>` and `git stash pop` of the Fixora stash. Failure paths run it as a separate step; if it fails, the final report prints the manual commands. One exception: a run that stops with its fix still uncommitted (fix timed out, checks blocked, review rejected, cancelled mid-fix) keeps the fix branch checked out and the stash untouched, so the half-done change never lands on your branch; `/fixora retry <runId> --from fix` continues there and `/fixora clean <runId>` puts your branch back. |

A worker session is confined twice: static session permission rules (no web, no `fixora_start`,
edits only inside the repository) and a tool hook that applies a per-phase policy — which git verbs,
which MCP tools and which CLIs are allowed right now. A fixer in the fix phase cannot commit; a
publish session can only push the run's branch; a reviewer cannot edit; Jira / GitLab writes need
the grant that the matching approval unlocked. Protected paths (CI, lockfiles, generated files,
secrets, `.dxcoder`) are never editable. The plugin never calls an MCP tool, never runs git and never
spawns a process.

Run folder `.dxcoder/fixora/<runId>/`: `crash.json`, `crash.md`, `project.md`, `limits.json`,
`triage.json`, `analysis.md`, `fix.<n>.json`, `diff.<n>.patch`, `verification.<n>.json`,
`review.<n>.json`, `stash-preview.md`, `ticket-preview.md`, `publish-preview.md`,
`commit-message.txt`, `mr.md`, `feedback.md`, `run.log`. `.dxcoder/fixora/.gitignore` is created with `*`.

## TUI

The package also ships a TUI entry (`./tui`, loaded automatically by DXcoder next to the server
entry). With it:

- **`/fixora`** opens a searchable picker of the top crashes grouped by source (users affected,
  version, age, and for crashes Fixora already handled the ✓ / ↻ / ✗ badge with the Jira key, the MR
  and its status, the release and any note), with `ctrl+t` "fix top 3" (new crashes only) and
  `ctrl+r` refresh, plus a "paste a stack trace" entry. Picking a new crash shows a one-line
  confirmation, then starts the run; picking a handled one shows its links and the next command, with
  "Fix again" to start over with `--force`.
- A **panel** opens in the session (`/fixora panel` or the palette toggles it; `f` makes it
  fullscreen, `esc` closes it). It has four tabs that fit the docked width: columns drop as the panel
  narrows and come back in fullscreen; nothing wraps.
  - **crashes** (`/fixora crashes`, `C` from any tab): the top crashes of every connected source,
    grouped New / Came back / In progress / Fixed (or by source with `s`), with the fix-state glyph,
    users or events, the Jira key, the MR and its status, the release, platform, version and age.
    The selected row expands with the run id, the note and clickable links. Keys: `↑↓` select,
    `enter` fix (a handled crash shows its links and "Fix again" with `--force`; a busy one opens
    its run), `t` fix the top 3 new crashes, `r` refresh, `v` show the run, `o` copy the crash URL,
    `y` copy the MR URL, `s` sort, `l` runs, `g` report.
  - **run** (the live pipeline, `/fixora status <runId>` pins one): a status card with a progress
    bar, the current stage, the elapsed time and the fix / review / feedback counters; a "decision
    needed" card while an approval waits; the stage timeline with spinner, live detail, attempt
    badges and timings (finished stages fold while a run is active; `e` expands them); a live log
    card; the root-cause card with the confidence meter, category, risk, the "introduced by" commit
    and reopen warnings; the validation card (diff, per-check results, review verdict); the result
    card (MR, Jira, branch, next steps) or the error card. Keys: `a` answer approval, `r` retry,
    `R` restart, `c` cancel, `w` worker session, `d` feedback, `y` copy the MR URL, `e` stages,
    `C` crashes, `l` runs, `g` report.
  - **runs** (`/fixora status`, `l`): every run grouped Active / Finished with a status chip, the
    title, stage progress (`6/11`), the current stage, MR and Jira links and the age. Keys: `enter`
    show, `a` answer, `r` retry, `R` restart, `x` cancel, `m` mark fixed, `y` copy the MR URL,
    `s` sync MR statuses, `g` report.
  - **report** (`/fixora report`, `g`): the funnel, the 30-day trend, timings, MR and reopen
    statistics and the recent runs as cards.
- **Approvals** become a dialog: stashing your local changes, the Jira ticket, and the publish
  (branch, files and line counts, checks, review verdict, confidence and risk, the MR title and body;
  `v` expands it). `a` approves, `r` rejects with feedback, `esc` decides later. Without a TUI, or
  when nobody answers within the acknowledgement window, the host's permission prompt is used instead.
- Toasts and OS notifications (with sounds) on start, decision needed, done, failed and reopened crashes.

Everything else (`fix`, `paste`, `top`, `batch`, `fixed`, `clean`, flags) is forwarded to the server
command, so the two entries behave the same.

## Setup

What the agent needs on the machine: `git` (with credentials that can push to the remote), the
project's toolchain, and optionally `glab` or `gh` for merge requests when no GitLab / GitHub MCP
server is configured. Add at least one crash source MCP server to `opencode.jsonc`, optional Jira
and GitLab/GitHub servers, and the plugin:

```jsonc
{
  "mcp": {
    "servers": {
      "sentry": { "type": "remote", "url": "https://mcp.sentry.dev/mcp" },
      // --only crashlytics: without it firebase-tools hides the crashlytics_* tools unless it finds a Crashlytics app in its working directory
      "firebase": { "type": "local", "command": ["npx", "-y", "firebase-tools@latest", "mcp", "--only", "crashlytics"] },
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
        "branchNaming": { "template": "{type}/{ticket}-{slug}", "type": "fix", "example": "fix/DE-456-fix-crash-on-startup" },
        "worker": { "agent": "build", "model": "anthropic/claude-sonnet-4-5", "shell": "allow", "maxPhaseMinutes": { "crash": 5, "prepare": 10, "triage": 10, "fix": 20, "review": 10, "publish": 10, "restore": 5, "list": 5 } },
        "review": { "model": null },
        "testCommands": { "unit": null, "integration": null, "lint": null, "typecheck": null, "timeoutSec": 600, "fullSuiteMaxMinutes": 15 },
        "validate": { "denyPaths": [], "maxFilesChanged": 10, "maxDiffLines": 400, "requireTestChange": true },
        "maxFixRounds": 3, "maxReviewRounds": 3,
        "confidence": { "minToFix": 0.4, "minToPublish": 0.6, "autoApprove": 0.8 },
        "approvals": "confidence",
        "mode": "fix",
        "jira": { "project": "APP", "issueType": "Bug", "parent": null, "labels": ["fixora"], "transitionOnMr": "In Review", "ticketOnSkip": false },
        "mr": { "draft": true, "labels": ["fixora"], "reviewers": [], "target": null, "forge": null },
        "sourceWriteBack": false,
        "crashlytics": { "appIds": ["1:1234567890:android:abcdef", "1:1234567890:ios:012345"] },
        "sentry": { "organization": "acme", "project": "shop" },
        "inAppPackages": ["com.example.app"], "appPackage": "my_app",
        "crashes": { "cacheMinutes": 5 },
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
| `baseBranch`, `remote`, `branchPrefix` | `main`, `origin`, `fixora/` | Where fixes start from; every Fixora branch starts with the prefix. |
| `branchNaming` | `{ "type": "fix" }` | The repository's branch naming convention, applied after the prefix. `template` placeholders: `{type}` (`branchNaming.type`), `{ticket}` (the Jira key), `{slug}` (crash title), `{runId}`, `{crashId}`; `example` is shown to the agent. With a template the plugin renders the exact name and the agent must use it. `{ticket}` makes the run create the Jira ticket **before** the branch, without a dialog (no Jira or `--no-ticket` → the crash id takes its place); a Sentry / Crashlytics crash is then fetched in its own agent turn first, because the ticket text needs it. Without a template the agent infers a name from the remote branches, falling back to `<prefix><runId>-<slug>`. Example: a repository with the convention `type/ticket-number-short-description` (`fix/DE-456-fix-crash-on-startup`) sets `"branchNaming": { "template": "{type}/{ticket}-{slug}", "type": "fix" }` and gets `fixora/fix/DE-457-null-coupon-in-applycoupon`; set `"branchPrefix": "fix/"` with `"template": "{ticket}-{slug}"` to drop the `fixora/` part. |
| `worker.agent` / `worker.model` | `build` / host default | The coding agent (and model) used for every session: crash fetch, prepare, analysis, fix, publish, restore. |
| `worker.shell` | `allow` | Whether the host prompts for the agent's shell commands (`ask`) on top of Fixora's own phase policy. |
| `worker.maxPhaseMinutes` | see above | Time budget per phase; the session is interrupted and the run can be resumed. |
| `review.model` | worker model | Model of the independent reviewer session. |
| `testCommands.*` | reported by the agent | Override the lint / typecheck / unit / integration commands the agent must run and report; `""` or `null` disables a kind. `timeoutSec` is the limit per check; the full unit suite runs only when it fits in `fullSuiteMaxMinutes` (else the mapped tests), unless `--tests` says otherwise. |
| `validate.*` | 10 files / 400 lines | Change-set limits; `denyPaths` adds protected globs. |
| `maxFixRounds`, `maxReviewRounds` | 3 / 3 | How often failing checks or a rejecting review send the agent back. |
| `confidence.*` | 0.4 / 0.6 / 0.85 | Minimum confidence to attempt a fix, to publish, and to auto-approve. |
| `approvals` | `confidence` | When the publish dialog (push + MR) appears. `confidence` = only when the analysis confidence is below `confidence.autoApprove` (80% by default); `publish` = always; `auto` = never (stashing is auto-approved too). The Jira ticket never asks: it is created whenever Jira is connected and `--no-ticket` is not set. `each` is accepted as `publish`. |
| `mode` | `fix` | `test-first` makes the agent write a failing reproduction test before the fix. |
| `jira.*` | — | Project key enables tickets (through the Jira MCP server only); issue type, labels, transition after the MR. `parent` links every ticket to an issue (set it together with `"issueType": "Sub-task"` to create sub-tasks under a story). |
| `mr.*` | draft | Draft MRs, labels, reviewers, target branch, forge override (`gitlab` / `github`). |
| `sourceWriteBack` | false | Have the agent post a note with the MR link on the Sentry / Crashlytics issue. |
| `crashlytics.appId` / `appIds`, `sentry.organization` / `project` | — | Needed by the respective MCP tools when not derivable from a URL. `appIds` lists several Firebase apps: `/fixora` queries all of them and shares the list slots round-robin between apps (the best issue of each first), so a quieter platform is not crowded out by a busier one; refs carry the app (`crashlytics:<id>@<appId>`) and a bare `crashlytics:<id>` is looked up in each app in order. |
| `inAppPackages`, `appPackage` | — | Package / module prefixes used only to prefer application frames when fingerprinting a crash (dedupe / reopen detection); they never decide whether a crash is fixable. |
| `crashes.cacheMinutes` | 5 | How long a crash list stays valid for the picker before the agent fetches it again. |

Ignored legacy options (reported by `/fixora doctor` and once per session): `worktree.*` (no
worktrees any more), `review.mode` (always a reviewer session), `jira.url` / `token` / `username` /
`password` / `sslVerify` (Jira is reached only through its MCP server).

## Offline / restricted machines: single-folder bundle

`bun run build` bundles `index.ts` (+ `src/rpc.ts`) and the npm dependencies into `dist/`, keeping
only `@opencode/plugin` and `effect` external because the host provides them; the TUI entry is
copied as source. `bun run pack` also writes `fixora-<version>-dist.tgz` (+ `.sha256`) whose
`INSTALL.md` explains the config. Reference the extracted folder by absolute path in
`opencode.jsonc`: `"plugins": [{ "package": "/opt/dxcoder/fixora" }]`.

## Development

```sh
bun install
bun run typecheck
bun test plugins/fixora
```

The tests never touch git or spawn a process. They cover the pure modules (stack-trace parsers for
every ecosystem, fingerprinting, secret scanning, validators for every submission,
permission rules and the per-phase tool policy, MCP detection, source plans and mappers against
fixture JSON / YAML, prompt builders) and the orchestration end to end with a scripted agent that
answers through the plugin's own tools: prepare, stash approval, triage, fix, review, publish,
restore, feedback, rejected approvals, restart, dry run, cancellation and the repository lock.

## Verification checklist (manual, on a live DXcoder host)

1. `/fixora doctor`: services come from the host's tool list; the "ignored legacy options" section lists `worktree` when it is still in `opencode.jsonc`.
2. `/fixora`: a child session titled "Fixora · crash list" calls only read tools and submits once; the picker renders; a second `/fixora` within 5 minutes uses the cache; `--probe` shows raw replies.
3. `/fixora fix <ref>` on a clean checkout: the fixer session runs in the directory you have open; `git branch --show-current` in a terminal shows the `fixora/…` branch; no `.git/worktrees` entry appears.
4. Dirty checkout: the `fixora.stash` dialog appears before anything is stashed; decline → run blocked, tree untouched; accept → `git stash list` shows `fixora/<runId>`.
5. Triage: an `edit` attempt and a Jira write by the agent are refused by the hook ("read-only phase", "Jira writes need the ticket grant").
6. Ticket: the `fixora.ticket` dialog appears before the prompt; the agent's `jira_create_issue` call produces no second host dialog (if it does, the session rule for `<ns>_*` is not honoured by the host; add per-tool allow rules from `services.jira.toolIds`).
7. Fix: dependency install allowed; `git commit` refused in the fix phase; a submission without a required check is rejected with the command name; `diff.1.patch` written.
8. Review: separate session, cannot edit, can run the listed check command.
9. Publish: one `fixora.publish` dialog; `git log -1` shows the prepared message and trailers; push without force; draft MR via MCP, then `glab` / `gh`, else the compare URL in the report; a forced push or a push to `main` is refused by the hook.
10. Restore: after done, after a rejected gate and after `/fixora restart` mid-run, `git branch --show-current` is your previous branch and the stash is popped; kill the host during fix → `/fixora retry` → prepare keeps the branch already checked out; `/fixora clean <id> --remote` asks `fixora.delete-branch`.
11. `/fixora feedback`, `/fixora sync`, `/fixora fixed` go through ops prompts; `worker.shell = "ask"` makes the host prompt for shell calls, `"allow"` yields no prompts beyond the Fixora gates.
12. `/fixora recover --dry-run` after a `reset`: a session titled "Fixora recover · merge requests" runs only `git remote get-url` / `git fetch` / `git log` and the list tool or CLI, the table names every Fixora MR with its Jira key and MR state; `/fixora recover` then asks `fixora.recover` once, `/fixora status` lists the runs as `done`, and `/fixora` shows them as handled with their links.
