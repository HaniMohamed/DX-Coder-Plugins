// Detects the Jira MCP server (mcp-atlassian) and reads its config so the REST client can reuse
// the same credentials. The plugin never registers an MCP server itself.

import type { Plugin } from "@opencode/plugin"

export interface DetectedJira {
  /** Tool-name prefix used by the host for this server's tools, e.g. "jira" or "atlassian". */
  namespace: string
  serverName: string
  status: string
  /** `environment` of a local server config, when readable. */
  environment?: Record<string, string>
  toolIds: string[]
}

export type Detection = { kind: "connected"; jira: DetectedJira } | { kind: "not-connected"; jira: DetectedJira } | { kind: "missing" }

/** Mirrors `namespace()` in the host (`packages/core/src/tool/mcp.ts`). */
export const mcpNamespace = (server: string) => server.replace(/[^a-zA-Z0-9_-]/g, "_")

const PROBE = /(^|_)jira_get_issue$/

interface ServerInfo {
  name: string
  status: { status: string } | string
}

const statusOf = (s: ServerInfo) => (typeof s.status === "string" ? s.status : s.status?.status ?? "unknown")

async function listServers(ctx: Plugin.Context): Promise<ServerInfo[]> {
  const res = (await ctx.mcp.list()) as unknown
  if (Array.isArray(res)) return res as ServerInfo[]
  if (res && typeof res === "object" && Array.isArray((res as { data?: unknown }).data)) return (res as { data: ServerInfo[] }).data
  return []
}

async function readConfigs(ctx: Plugin.Context): Promise<Map<string, { type?: string; command?: string[]; environment?: Record<string, string> }>> {
  const out = new Map<string, { type?: string; command?: string[]; environment?: Record<string, string> }>()
  const reg = await ctx.mcp.transform((editor) => {
    for (const [name, config] of editor.list()) out.set(name, config as never)
  })
  await reg.dispose()
  return out
}

export async function detectJira(ctx: Plugin.Context): Promise<Detection> {
  const [tools, servers, configs] = await Promise.all([ctx.tool.list(), listServers(ctx), readConfigs(ctx)])
  const probe = tools.filter((t) => PROBE.test(t.id))

  let namespace: string | undefined
  let server: ServerInfo | undefined
  if (probe.length > 0) {
    const id = probe[0]!.id
    namespace = id === "jira_get_issue" ? "jira" : id.slice(0, id.length - "jira_get_issue".length - 1)
    server = servers.find((s) => mcpNamespace(s.name) === namespace)
  }
  if (!server) {
    // Fall back to a configured (maybe not yet connected) mcp-atlassian server.
    for (const [name, config] of configs) {
      const command = (config.command ?? []).join(" ")
      if (/mcp[-_]?atlassian/i.test(command) || /jira|atlassian/i.test(name)) {
        server = servers.find((s) => s.name === name) ?? { name, status: "unknown" }
        namespace = namespace ?? mcpNamespace(name)
        break
      }
    }
  }
  if (!server || !namespace) return { kind: "missing" }

  const config = configs.get(server.name)
  const jira: DetectedJira = {
    namespace,
    serverName: server.name,
    status: statusOf(server),
    environment: config?.environment,
    toolIds: tools.filter((t) => t.id.startsWith(`${namespace}_`)).map((t) => t.id),
  }
  return probe.length > 0 && jira.status === "connected" ? { kind: "connected", jira } : { kind: "not-connected", jira }
}

export const INSTALL_INSTRUCTIONS = `Jira planner needs a local mcp-atlassian MCP server (Jira Server / Data Center). None is configured.

1. Install the server (Python):
   pip install mcp-atlassian        # or: pipx install mcp-atlassian  /  uv tool install mcp-atlassian

2. Add it to opencode.jsonc (project or global):
   {
     "mcp": {
       "servers": {
         "jira": {
           "type": "local",
           "command": ["mcp-atlassian"],
           "environment": {
             "JIRA_URL": "https://jira.example.com",
             "JIRA_PERSONAL_TOKEN": "<personal access token, Jira DC 8.14+>",
             // or instead of the PAT:  "JIRA_USERNAME": "<user>", "JIRA_API_TOKEN": "<password or token>",
             "JIRA_SSL_VERIFY": "true"
           }
         }
       }
     }
   }

3. Restart DXcoder (or connect the server from /mcps), then re-run /jira-planner <ISSUE-KEY>.`

export const notConnectedInstructions = (jira: DetectedJira) =>
  `The Jira MCP server "${jira.serverName}" is configured but its status is "${jira.status}". Connect it from /mcps (check the command, JIRA_URL and the token in its environment), then re-run /jira-planner.`

export interface WorkerPermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

/**
 * Permission rules for the planning worker session. The host evaluates rules with wildcard
 * matching and the LAST matching rule wins. File edits are left to the agent's defaults; the
 * "only inside the issue folder" rule is enforced by `guardWorkerWrite` (a tool hook) because the
 * host's permission resource format for files differs between builds.
 */
export function workerPermissions(input: { namespace: string; shell: "allow" | "deny" | "ask" }): WorkerPermissionRule[] {
  const ns = input.namespace
  return [
    { action: `${ns}_*`, resource: "*", effect: "deny" }, // all tools of the Jira MCP server…
    { action: `${ns}_*get*`, resource: "*", effect: "allow" }, // …except read-only ones
    { action: `${ns}_*search*`, resource: "*", effect: "allow" },
    { action: "*_jira_create*", resource: "*", effect: "deny" }, // belt and braces for other server names
    { action: "*_jira_update*", resource: "*", effect: "deny" },
    { action: "*_jira_delete*", resource: "*", effect: "deny" },
    { action: "*_jira_add*", resource: "*", effect: "deny" },
    { action: "*_jira_transition*", resource: "*", effect: "deny" },
    { action: "*_jira_download*", resource: "*", effect: "deny" },
    { action: "*_confluence_create*", resource: "*", effect: "deny" },
    { action: "*_confluence_update*", resource: "*", effect: "deny" },
    { action: "*_confluence_delete*", resource: "*", effect: "deny" },
    { action: "webfetch", resource: "*", effect: "deny" },
    { action: "websearch", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: input.shell },
  ]
}

export const WRITE_TOOLS = new Set(["write", "edit", "patch", "multiedit"])

/**
 * Returns an error message when a write/edit/patch call from a worker session targets a path
 * outside its issue folder, otherwise undefined. `patch` carries several paths in one call and is
 * refused outright. Paths are resolved against the session's project directory.
 */
export function guardWorkerWrite(input: { tool: string; input: unknown; folder: string; directory: string }): string | undefined {
  if (!WRITE_TOOLS.has(input.tool)) return undefined
  const folder = normalizePath(input.folder)
  if (input.tool === "patch") return `jira-planner worker: the patch tool is not allowed; use write or edit inside ${folder}`
  const raw = input.input as Record<string, unknown> | undefined
  const candidate = [raw?.path, raw?.filePath, raw?.file_path, raw?.file].find((v) => typeof v === "string") as string | undefined
  if (!candidate) return `jira-planner worker: ${input.tool} call without a path is not allowed`
  const absolute = normalizePath(isAbsolutePath(candidate) ? candidate : `${input.directory.replace(/[\\/]+$/, "")}/${candidate}`)
  if (absolute === folder || absolute.startsWith(`${folder}/`)) return undefined
  return `jira-planner worker: writing outside the issue folder is not allowed (${candidate}). Only ${folder} may be modified.`
}

const isAbsolutePath = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\")

function normalizePath(p: string): string {
  const parts: string[] = []
  const slashed = p.replace(/\\/g, "/")
  const drive = /^[A-Za-z]:/.exec(slashed)?.[0] ?? ""
  for (const part of slashed.slice(drive.length).split("/")) {
    if (!part || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `${drive}/${parts.join("/")}`.replace(/\/+$/, "") || "/"
}
