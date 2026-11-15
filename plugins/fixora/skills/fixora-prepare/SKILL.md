---
name: fixora-prepare
description: Prepare the user's checkout for a Fixora crash fix - inspect it, stash only after approval, fetch the base branch, create and check out a fixora/ branch, detect the toolchain - and report through fixora_submit_prepare. Invoked by the /fixora command; not for general use.
disable-model-invocation: true
---

# Fixora prepare — the checkout, carefully

You work in the repository the user has open in DXcoder (your working directory). It is **their**
checkout: whatever you change here, Fixora restores at the end of the run (previous branch checked
out again, stash popped). Treat every command as visible to the user.

## Step 1 — inspect (always first)

```
git rev-parse --show-toplevel          # repoRoot; a failure means blocked: "not-a-repo"
git rev-parse --abbrev-ref HEAD        # previousBranch ("HEAD" when detached → use the commit id instead)
git rev-parse HEAD                     # previousHeadSha
git status --porcelain=v1 --untracked-files=all
```

The checkout is **dirty** when the status lists anything other than: entries under `.dxcoder/`,
lockfiles, `node_modules/`, `.dart_tool/`, `build/`, `dist/`, `Pods/` and similar generated paths.

- Dirty and the prompt did not say stashing was approved → **stop** and call `fixora_submit_prepare`
  with `stage: "inspect"`, `dirty: true`, the porcelain text in `status` and the file count in
  `dirtyFiles`. Do not stash, do not switch branches. Fixora asks the user and prompts you again.
- Clean → continue with step 2 in the same turn.
- Stashing approved (the prompt says so) → `git stash push -u -m "fixora/<runId>"`, then
  `git rev-parse stash@{0}` and keep that commit id for `stashRef`. Never `stash drop` / `stash clear`.

When the prompt carries recorded values from a previous attempt (previousBranch, stashRef) and the
checkout is already on the fix branch, report those recorded values again and do not stash twice.

### Re-entry (the prompt says the run already has its branch)

A retry or feedback round comes back to a branch that exists, often with the fix of this run still
uncommitted on it (Fixora keeps that branch checked out when a run stops mid-fix). Those changes are
the fix in progress, not a dirty checkout:

- never stash them, never report `dirty: true` for them, never discard or reset anything;
- already on the fix branch → nothing to switch; otherwise `git checkout <branch>` carries them along;
- git refuses the checkout because of them → `fixora_submit_prepare` with `stage: "inspect"`,
  `dirty: true`, the porcelain text in `status` and git's error in `notes`, then stop (Fixora tells the
  user what to do; it never stashes a fix in progress);
- then the fetch (a failure is a note), the toolchain scan, and `stage: "ready"` with `dirty: false`,
  `created: false`, the recorded `previousBranch` / `previousHeadSha` / `stashRef`.

## Step 2 — base and branch

1. `git fetch <remote> <base>` (no `--prune`). If the base branch exists neither on the remote nor
   locally, report `blocked: "base-missing"` with the fetch error in `blockedDetail`.
2. `baseRef` is `<remote>/<base>` when the fetch succeeded, else the local `<base>`; `baseSha` is
   `git rev-parse <baseRef>`; `remoteUrl` is `git remote get-url <remote>` (null when there is no remote).
3. Branch name:
   - The prompt names an existing branch for this run → `git checkout <branch>` (or
     `git checkout -b <branch> <remote>/<branch>` when it only exists on the remote). Never rename it.
   - The prompt gives the name "from the configured naming convention" → use it exactly as written.
     When the prompt has a Jira ticket step before the branch, do that step first (search, reuse or
     create, `fixora_submit_ticket`) and put the ticket key where the name says `<key>`; if no ticket
     could be created, use the fallback id the prompt names. Do not look for a convention yourself.
   - Otherwise run ONE `git branch -r --list | head -20`. If a convention is obvious from those names
     (ticket prefixes, kebab-case, `type/short-description`…), build a name that **starts with the
     prefix from the prompt** (`fixora/`) and follows the rest of it, e.g.
     `fixora/APP-1831-guard-coupon-null`. Otherwise use the fallback name from the prompt as is. Do not
     read CONTRIBUTING or other files for this. Then `git checkout -b <branch> <baseRef>`.
   - Never check out, reset or modify the base branch or any protected branch (main, master, develop,
     release/*, hotfix/*). Never `git reset`, `git clean`, `git checkout -- <file>`.

## Step 3 — toolchain (quick scan, no installs)

Detect the ecosystems from marker files only: the repository root plus the package(s) whose files
appear in the crash frames of `crash.md` (for a monorepo, the directory of such a file that holds a
marker file; never every package). Reading a marker file (`pubspec.yaml`, `package.json`, …) is all
this needs: do not open source files, do not run build tools, do not install anything here.

| Marker | ecosystem id | checks (kind: command) |
|---|---|---|
| `pubspec.yaml` with flutter | `flutter` | lint: `flutter analyze` · unit: `flutter test` (prefix both with `fvm ` when `.fvmrc` / `.fvm` exists) |
| `pubspec.yaml` without flutter | `dart` | lint: `dart analyze` · unit: `dart test` |
| `package.json` | `node` | lint: `<pm> run lint` when the script exists · typecheck: `<pm> run typecheck` or `npx tsc --noEmit` (optional) when `tsconfig.json` exists · unit: the `test` script (`bun test`, `npm test`, …) · integration: `test:integration` / `test:e2e` (optional). `<pm>` = bun / pnpm / yarn / npm from the lockfile |
| `gradlew` / `build.gradle(.kts)` | `gradle` | build: `./gradlew compileDebugKotlin compileDebugJavaWithJavac --quiet` (optional) · unit: `./gradlew testDebugUnitTest --quiet` · lint: `./gradlew lintDebug --quiet` (optional) |
| `pom.xml` | `maven` | build: `mvn -q -DskipTests compile` · unit: `mvn -q test` |
| `*.xcodeproj` / `*.xcworkspace` | `xcode` | build: `xcodebuild build -quiet CODE_SIGNING_ALLOWED=NO` (optional) |
| `Package.swift` | `spm` | build: `swift build` · unit: `swift test` |
| `pyproject.toml` / `setup.py` / `pytest.ini` / `requirements.txt` | `python` | lint: `ruff check .` when ruff is configured · typecheck: `mypy .` (optional) when configured · unit: `pytest -q` |
| `go.mod` | `go` | typecheck: `go vet ./...` · unit: `go test ./...` |
| `*.sln` / `*.csproj` | `dotnet` | build: `dotnet build --nologo -v q` · unit: `dotnet test --nologo -v q --no-build` |
| `Cargo.toml` | `rust` | typecheck: `cargo check --quiet` · unit: `cargo test --quiet` |

Each check carries `cwd` (the package directory, "" for the root) and `optional: true` when a missing
tool must not fail the run. For a monorepo, list the packages the crash's frames point to (the crash
title and run id are in the prompt) plus the root; not every package.

**Dependency setup is NOT part of this phase.** Leave `toolchain.setup` empty; the fix phase runs
the install command (`flutter pub get`, `bun install`, …) only when a check needs it.

List the convention documents present: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`,
`.github/CONTRIBUTING.md`, `docs/CONTRIBUTING.md`.

## Report (`fixora_submit_prepare`)

```json
{
  "version": 1,
  "runId": "sentry-4523123",
  "stage": "ready",
  "repoRoot": "/Users/me/shop",
  "previousBranch": "feature/checkout-v2",
  "previousHeadSha": "9fceb02a1b2c3d4e5f60718293a4b5c6d7e8f901",
  "dirty": true,
  "stashRef": "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
  "baseRef": "origin/main",
  "baseSha": "b7e21c0ffee1234567890abcdef1234567890abcd",
  "remoteUrl": "git@gitlab.example.com:mobile/shop.git",
  "branch": "fixora/APP-1831-guard-coupon-null",
  "created": true,
  "toolchain": {
    "ecosystems": [{ "id": "node", "root": "" }],
    "checks": [
      { "kind": "lint", "command": "bun run lint", "cwd": "" },
      { "kind": "typecheck", "command": "bun run typecheck", "cwd": "" },
      { "kind": "unit", "command": "bun test", "cwd": "" }
    ],
    "setup": []
  },
  "conventionFiles": ["CONTRIBUTING.md"],
  "notes": ["branch name follows the ticket-prefix convention seen on origin"]
}
```

Rules: `branch` must start with the prefix from the prompt (or be exactly the name the prompt gives)
and must not be a protected name; `dirty: true` with `stage: "ready"` needs a `stashRef` (without an
approved stash Fixora reads such a report as stage inspect and asks the user); `previousBranch` is
the branch you found in step 1, never the fix branch; shas are hex. A reply "was NOT accepted" lists
what to fix: correct only that and call the tool again, do not start over.
Call the tool once per stage; correct and resubmit on validation errors. The reply ends with
CONTINUE (go straight on to the analyse stage in this same turn, as the prompt lists it) or STOP.
