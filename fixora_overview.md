# Fixora — high-level overview

## What the system does

Fixora turns production crashes into reviewed code fixes with almost no human effort. It reads fatal crashes from Firebase Crashlytics, finds the responsible code in the app repository, explains the root cause, writes a minimal fix, has that fix reviewed, and publishes it as a draft merge request. Optionally it opens a Jira ticket for the crash and links the merge request back to it.

Each crash becomes a tracked item with a status, a root-cause analysis, a diff, a branch, a merge request, and (optionally) a Jira key. Developers then review the merge request, chat with Fixora to refine the fix, mark the crash as fixed in a release, and get notified when the same crash reappears later.

## End-to-end flow (per crash)

1. **Fetch** — Pull the newest fatal crashes from Crashlytics (BigQuery export or Cloud Logging). Crashes already processed are skipped.
2. **Locate** — Map the stack trace to real files and lines in the app repository (Dart/Flutter, Kotlin/Java, Swift).
3. **Understand** — Collect the surrounding code, `git blame`, and recent commits for those lines, and flag whether a recent change likely introduced the problem.
4. **Analyze** — Produce a root cause, confidence score, and a fix suggestion.
5. **Ticket (optional)** — Create a Jira issue carrying the analysis and stack trace.
6. **Fix** — Write a minimal patch. A separate review pass checks it for correctness, scope and risk. If rejected, the fix is regenerated, up to three times.
7. **Publish** — Create a branch from the base branch, apply the patch, commit only the touched files, push, and open a **draft merge request** on GitLab with a generated title and description.
8. **Close the loop** — Add the merge request link to the Jira issue and move it to Done.

After publication, three follow-up features exist:

- **Fix Copilot (feedback chat)** — the developer asks questions about the fix or asks for changes; actionable requests regenerate the fix on the same branch and update the open merge request.
- **Force restart** — closes the current merge request, notes it on the Jira ticket, and starts a fresh fix cycle.
- **Release tracking and reopen detection** — a crash can be marked "fixed in release X"; if a crash with the same signature shows up later, it is flagged as **reopened** and Fixora explains the likely reason (incomplete fix, new code path, regression, or fix not shipped).

## Components

| Component | Purpose |
| --- | --- |
| Pipeline | Ordered steps above, run per crash, streaming progress events |
| Integrations | Crashlytics (BigQuery / Cloud Logging), Git + GitLab, Jira, LLM provider (Gemini, OpenAI-compatible, or an enterprise gateway) |
| Crash store | SQLite (single user) or Postgres (team); one row per crash with status, flags and the full result |
| HTTP API | Trigger runs, stream live events, browse crashes, analytics, settings, repo management |
| Web / macOS UI | Dashboard, crash inventory, live run view, merge requests, fixed crashes, settings, admin |

## UI pages

| Page | What it shows |
| --- | --- |
| **Dashboard** | KPIs, status mix, pipeline funnel, 30-day trend, merge request status, top platforms/versions/devices, recent activity |
| **Crashes** | Inventory of every crash with status, Jira key, MR link, reopened badge; detail view with exception, stack trace, root cause, suggested fix, generated diff, PR body, pipeline progress, raw state JSON, Crashlytics and MR deep links; actions: re-run, Fix Copilot, force restart |
| **Runs / Live Run** | Start a batch or single-crash run; watch each step live with timings |
| **Generated MRs** | All merge requests created by Fixora with their status (pending / merged / closed) and a sync action |
| **Fixed Crashes** | Crashes marked fixed in a release, with Android/iOS versions and reopen state |
| **Repositories / Settings / Admin / Logs / Help** | Repo registration (Crashlytics tables, Jira/GitLab project), credentials, users, backend logs |

## Dashboard and analytics data

The dashboard is driven by one analytics payload computed over the crash store (cached for five seconds).

**Totals**

| Field | Meaning |
| --- | --- |
| `all` | Crashes ever processed |
| `completed` / `in_progress` / `failed` / `skipped` | Status breakdown (skipped = stack trace could not be mapped to the repo) |
| `with_jira` | Crashes that have a Jira issue |
| `with_pr` | Crashes that have a merge request |
| `pipeline_complete` | Crashes that reached the merge request stage |

**Pipeline funnel** — how many crashes passed each stage: analysis done → Jira created → fix generated → fix validated → diff applied → branch created → MR opened. Shown alongside `step_success_rate` (each stage as a fraction of all crashes) and `completion_rate`.

**Timing** — `avg_pipeline_duration_seconds`, the average time from crash intake to merge request for completed runs.

**Trend** — `timeseries_daily`: for each of the last 30 days, crashes created, completed and failed.

**Merge request status** — counts of `pending`, `merged`, `closed` across all generated MRs.

**Release tracking** — `fixed.total` (crashes marked fixed), how many have an Android or iOS release version recorded, `reopened.count` and `reopened.rate`.

**Top breakdowns** — the ten most frequent `platforms`, `app_versions`, and `devices` among processed crashes.

**Recent activity** — the ten most recently updated crashes with their status, Jira key and MR link.

## Per-crash data stored

Each crash row keeps: crash id, status, timestamps, Jira issue key, MR URL and MR status, the seven pipeline flags above, feedback iteration count, restart count, fixed-in-release versions, who marked it fixed, crash fingerprint, reopened flag and count, and the full result (exception, stack trace, device, app version, mapped frames, root cause, confidence, fix rationale, risk, suggested tests, generated diff, branch, PR title and body, and any errors).
