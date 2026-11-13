# jira-planner

Adds a `/jira-planner` command to DXcoder for tech leads: fetch a Jira story (on-prem Jira Server /
Data Center), analyse it with its attachments, audit the current repository against it, break it into
subtasks with integer story points, compare with the subtasks already in Jira, and push the missing
ones after approval.

## Commands

| Command | What it does |
|---|---|
| `/jira-planner PROJ-123` | Fetch the story, download and convert attachments, run the planning worker, write the plan files and a gap report. Flags: `--force` (re-plan; previous output is moved to `.history/`), `--no-attachments`. |
| `/jira-planner audit PROJ-123` | Re-fetch the existing subtasks and recompute the gap and estimate report from the current `subtasks.json`. No model involved. |
| `/jira-planner push PROJ-123` | Preview, ask for approval, then create the missing subtasks (with story points) and add a summary comment to the story. `--dry-run` only writes the preview. |
| `/jira-planner status [PROJ-123]` | Show recorded runs and pushes. |

## Flow

1. **Detect the Jira MCP.** The command looks for a connected `mcp-atlassian` server (a tool ending in
   `jira_get_issue`). If none is configured it prints install instructions and stops; it never registers
   a server itself. Credentials for the REST calls are read, in order, from the plugin options, the MCP
   server's `environment` (`JIRA_URL`, `JIRA_PERSONAL_TOKEN` or `JIRA_USERNAME` + `JIRA_API_TOKEN`,
   `JIRA_SSL_VERIFY`) and the process environment.
2. **Fetch.** Story fields, description, comments, links, existing subtasks with their story points, and
   attachments (pdf, docx, xlsx, text) are written to `.dxcoder/jira-planner/<KEY>/` as `story.md`,
   `existing-subtasks.json` and `attachments/*.md`. Jira content is wrapped in "untrusted" banners.
3. **Plan.** A child worker session runs the bundled `jira-planner` skill and writes `requirements.md`,
   `repo-audit.md`, `plan.md` and `subtasks.json`. The worker cannot call Jira write tools or fetch the web
   (session permission rules), and a tool hook in the plugin rejects any write, edit or patch outside the
   issue folder; shell is denied unless `workerShell` says otherwise.
4. **Gap report.** `gap-report.md` lists planned subtasks missing in Jira, existing subtasks not covered by
   the plan, matched pairs, and estimate drift (more than 30% or at least 2 points apart).
5. **Edit, then push.** Edit `subtasks.json` or `plan.md` freely. `push` shows a preview, asks for approval
   (`jira-planner.push`), creates only the missing subtasks in dependency order, never modifies or deletes
   existing ones, remembers created keys so a re-run never duplicates, and comments on the story.

`.dxcoder/jira-planner/.gitignore` is created with `*` so BRDs are not committed (set `gitignore: false`
in the options to keep plans in git).

## Setup

Install the MCP server (Python) and add it to `opencode.jsonc`:

```jsonc
{
  "mcp": {
    "servers": {
      "jira": {
        "type": "local",
        "command": ["mcp-atlassian"],
        "environment": {
          "JIRA_URL": "https://jira.example.com",
          "JIRA_PERSONAL_TOKEN": "<personal access token>",
          "JIRA_SSL_VERIFY": "true"
        }
      }
    }
  },
  "plugins": [
    {
      "package": "git+https://<your-git-host>/<org>/dxcoder-plugins.git#path:plugins/jira-planner",
      "options": {
        // all optional
        "jira": { "url": "https://jira.example.com", "token": "<pat>" },
        "storyPointsFieldId": "customfield_10002",
        "storyPointsFieldNames": ["Story Points"],
        "subtaskIssueType": "Sub-task",
        "label": "dxcoder-planned",
        "summaryPrefix": "",
        "workerAgent": "build",
        "workerShell": "deny",
        "maxAttachmentMB": 25,
        "gitignore": true
      }
    }
  ]
}
```

Install the plugin:

```sh
dxcoder plugin add 'git+https://<your-git-host>/<org>/dxcoder-plugins.git#path:plugins/jira-planner'
```

## Offline / restricted machines: single-folder bundle

`bun run build` bundles `index.ts` and all npm dependencies (gray-matter, mammoth, exceljs, unpdf)
into `dist/`, keeping only `@opencode/plugin` and `effect` external because the host provides them.
The folder is self-contained: `index.js`, `package.json`, `skills/`, `README.md`. No `node_modules`
and no install step are needed where it runs.

On a machine with network access:

```sh
cd dxcoder-plugins && bun install
cd plugins/jira-planner && bun run pack       # writes dist/ and jira-planner-<version>-dist.tgz (+ .sha256)
```

`bun run build` alone writes only `dist/`. The tarball extracts to a `jira-planner/` folder that
contains `INSTALL.md` with the steps below.

On the restricted machine, extract the folder anywhere and reference it by absolute path in
`opencode.jsonc` (the `dxcoder plugin add` CLI accepts only npm or git specifiers, so local folders go
through the config file):

```jsonc
{
  "plugins": [{ "package": "/opt/dxcoder/jira-planner", "options": {} }]
}
```

Then restart DXcoder and run `/jira-planner status`. The Jira MCP server still has to be installed
separately (`pip download mcp-atlassian -d wheels` on the connected machine, then
`pip install --no-index --find-links wheels mcp-atlassian` on the target).

`dist/` is gitignored; commit it on a release branch if you want the bundle distributed via `git clone`.

## Development

```sh
bun install
bun run typecheck
bun test plugins/jira-planner
```

`test/mock-jira.ts` starts a fake Jira Server on a random port; point the plugin at it with
`"jira": { "url": "http://localhost:<port>", "token": "x" }` for a manual run.
