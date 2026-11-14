// Detects crash sources, Jira and forge MCP servers from the tools the host registered, and calls
// their tools directly from plugin code. Namespaces are discovered, never hard-coded.

import type { Plugin } from "@opencode/plugin"
import type { DetectedService, ServiceId, Services } from "./types.js"

/** Mirrors `namespace()` in the host (`packages/core/src/tool/mcp.ts`). */
export const mcpNamespace = (server: string) => server.replace(/[^a-zA-Z0-9_-]/g, "_")

export interface ServerInfo {
  name: string
  status: { status: string } | string
}

export const statusOf = (s: ServerInfo) => (typeof s.status === "string" ? s.status : (s.status?.status ?? "unknown"))

export async function listServers(ctx: Plugin.Context): Promise<ServerInfo[]> {
  const res = (await ctx.mcp.list()) as unknown
  if (Array.isArray(res)) return res as ServerInfo[]
  if (res && typeof res === "object" && Array.isArray((res as { data?: unknown }).data)) return (res as { data: ServerInfo[] }).data
  return []
}

export async function readConfigs(ctx: Plugin.Context): Promise<Map<string, { type?: string; command?: string[]; url?: string; environment?: Record<string, string> }>> {
  const out = new Map<string, { type?: string; command?: string[]; url?: string; environment?: Record<string, string> }>()
  try {
    const reg = await ctx.mcp.transform((editor) => {
      for (const [name, config] of editor.list()) out.set(name, config as never)
    })
    await reg.dispose()
  } catch {
    // config access is optional
  }
  return out
}

/**
 * Capability probes per service. A tool id matches when it ends with `_<name>` (or equals it);
 * the prefix before the probe is the namespace. The first probe of a service is its "anchor".
 */
export const PROBES: Record<ServiceId, Record<string, RegExp>> = {
  sentry: {
    getIssue: /(^|_)get_issue_details$/,
    searchIssues: /(^|_)search_issues$/,
    searchErrors: /(^|_)search_errors$/,
    updateIssue: /(^|_)update_issue$/,
    findReleases: /(^|_)find_releases$/,
  },
  crashlytics: {
    getIssue: /(^|_)crashlytics_get_issue$/,
    getReport: /(^|_)crashlytics_get_report$/,
    listTopIssues: /(^|_)crashlytics_list_top_issues$/,
    batchGetEvents: /(^|_)crashlytics_batch_get_events$/,
    getSampleCrash: /(^|_)crashlytics_get_sample_crash(_for_issue)?$/,
    createNote: /(^|_)crashlytics_create_note$/,
    updateIssue: /(^|_)crashlytics_update_issue$/,
  },
  jira: {
    getIssue: /(^|_)jira_get_issue$/,
    search: /(^|_)jira_search$/,
    createIssue: /(^|_)jira_create_issue$/,
    addComment: /(^|_)jira_add_comment$/,
    getTransitions: /(^|_)jira_get_transitions$/,
    transition: /(^|_)jira_transition_issue$/,
    updateIssue: /(^|_)jira_update_issue$/,
  },
  gitlab: {
    createMr: /(^|_)create_merge_request$/,
    getMr: /(^|_)get_merge_request$/,
    updateMr: /(^|_)update_merge_request$/,
    listMrs: /(^|_)list_merge_requests$/,
  },
  github: {
    createPr: /(^|_)create_pull_request$/,
    getPr: /(^|_)get_pull_request$/,
    updatePr: /(^|_)update_pull_request$/,
    listPrs: /(^|_)list_pull_requests$/,
  },
}

const ANCHOR: Record<ServiceId, string[]> = {
  sentry: ["getIssue", "searchIssues"],
  crashlytics: ["getIssue", "batchGetEvents", "getReport", "listTopIssues"],
  jira: ["getIssue", "search", "createIssue"],
  gitlab: ["createMr"],
  github: ["createPr"],
}

function namespaceFor(toolId: string, probe: RegExp): string {
  const m = probe.exec(toolId)
  if (!m) return ""
  const suffixStart = m.index + (m[1] ? 1 : 0)
  return m[1] ? toolId.slice(0, suffixStart - 1) : ""
}

/** Pure: groups tool ids into services by probing names and resolves each namespace's server status. */
export function matchServices(toolIds: string[], servers: ServerInfo[], configs?: Map<string, { environment?: Record<string, string> }>): Services {
  const out: Services = {}
  for (const id of Object.keys(PROBES) as ServiceId[]) {
    const probes = PROBES[id]
    // Find the namespace from an anchor capability.
    let namespace: string | undefined
    for (const cap of ANCHOR[id]) {
      const probe = probes[cap]!
      const hit = toolIds.find((t) => probe.test(t))
      if (hit) {
        namespace = namespaceFor(hit, probe)
        break
      }
    }
    if (namespace === undefined) continue
    const prefix = namespace ? `${namespace}_` : ""
    const capabilities: Record<string, string> = {}
    for (const [cap, probe] of Object.entries(probes)) {
      const hit = toolIds.find((t) => t.startsWith(prefix) && probe.test(t) && namespaceFor(t, probe) === namespace)
      if (hit) capabilities[cap] = hit
    }
    const server = servers.find((s) => mcpNamespace(s.name) === namespace)
    out[id] = {
      id,
      namespace,
      serverName: server?.name ?? namespace,
      status: server ? statusOf(server) : "unknown",
      toolIds: toolIds.filter((t) => (prefix ? t.startsWith(prefix) : true) && Object.values(probes).some((p) => p.test(t))),
      capabilities,
      environment: configs?.get(server?.name ?? namespace)?.environment,
    }
  }
  return out
}

export async function detectServices(ctx: Plugin.Context): Promise<Services> {
  const [tools, servers, configs] = await Promise.all([ctx.tool.list(), listServers(ctx), readConfigs(ctx)])
  return matchServices(
    tools.map((t) => t.id),
    servers,
    configs,
  )
}

export const connected = (s: DetectedService | undefined): s is DetectedService => !!s && s.status === "connected"

// ---------- direct tool calls ----------

/** Pending plugin-originated calls: `<sessionID>:<toolId>`. The permission hook auto-allows these. */
export const pendingCalls = new Set<string>()
export const pendingKey = (sessionID: string, toolId: string) => `${sessionID}:${toolId}`

/** Pure: allow a permission evaluation when it is a plugin-originated call registered in `pending`. */
export function decideAutoAllow(event: { sessionID: string; action: string }, pending: Set<string>): "allow" | undefined {
  return pending.has(pendingKey(event.sessionID, event.action)) ? "allow" : undefined
}

export class ToolCallError extends Error {
  constructor(
    readonly toolId: string,
    message: string,
  ) {
    super(`${toolId}: ${message}`)
    this.name = "ToolCallError"
  }
}

const rand = () => Math.random().toString(36).slice(2, 10)

/**
 * Calls a host-registered tool (usually an MCP tool) from plugin code. The host asserts the
 * `<ns>_<tool>` permission for `sessionID`; `pendingCalls` lets the plugin's own evaluate hook allow it.
 * Returns the structured output when present, else parsed JSON text, else the raw text.
 */
export async function callTool(ctx: Plugin.Context, toolId: string, input: Record<string, unknown>, o: { sessionID: string; agent?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<unknown> {
  const tools = await ctx.tool.list()
  const tool = tools.find((t) => t.id === toolId)
  if (!tool) throw new ToolCallError(toolId, "tool not found (is the MCP server connected?)")
  const key = pendingKey(o.sessionID, toolId)
  pendingCalls.add(key)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 90_000)
  o.signal?.addEventListener("abort", () => controller.abort(), { once: true })
  try {
    const result = await tool.execute(input as never, {
      sessionID: o.sessionID as never,
      agent: (o.agent ?? "build") as never,
      messageID: `fixora-${rand()}` as never,
      id: `fixora-${rand()}` as never,
      signal: controller.signal,
      progress: async () => {},
    })
    return normalizeToolOutput(result)
  } catch (error) {
    throw new ToolCallError(toolId, error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
    pendingCalls.delete(key)
  }
}

export function normalizeToolOutput(result: unknown): unknown {
  if (!result || typeof result !== "object") return result
  const r = result as { output?: unknown; content?: unknown }
  if (r.output !== undefined && r.output !== null) {
    if (typeof r.output === "string") return tryJson(r.output)
    return r.output
  }
  if (typeof r.content === "string") return tryJson(r.content)
  if (Array.isArray(r.content)) {
    const text = r.content
      .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? (c as { text?: string }).text ?? "" : ""))
      .filter(Boolean)
      .join("\n")
    return tryJson(text)
  }
  return result
}

function tryJson(text: string): unknown {
  const t = text.trim()
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t)
    } catch {
      // fall through
    }
  }
  return text
}

export const INSTALL_SOURCES = `Fixora needs at least one crash source. None is configured. Options:

1. Sentry (remote MCP, OAuth): add to opencode.jsonc
   { "mcp": { "servers": { "sentry": { "type": "remote", "url": "https://mcp.sentry.dev/mcp" } } } }
   then connect it from /mcps.

2. Firebase Crashlytics (local MCP, needs firebase login):
   { "mcp": { "servers": { "firebase": { "type": "local", "command": ["npx", "-y", "firebase-tools@latest", "mcp", "--only", "crashlytics"] } } } }
   (--only crashlytics matters: firebase-tools hides its crashlytics_* tools unless it finds a Crashlytics app in its working directory)
   and set "crashlytics": { "appId": "1:1234567890:android:abcdef" } in the plugin options ("appIds": [..] when the
   same codebase ships to Android and iOS), or pass a Firebase console URL.

3. No MCP at all: save the stack trace to a file and run  /fixora paste <file>

Jira (mcp-atlassian) and GitLab / GitHub MCP servers are optional: without them Fixora skips the ticket and
falls back to the glab / gh CLI or a compare URL for the merge request.`

export const notConnectedInstructions = (s: DetectedService) =>
  `The ${s.id} MCP server "${s.serverName}" is configured but its status is "${s.status}". Connect it from /mcps (check its command/URL and credentials), then re-run /fixora.`

/**
 * `/fixora doctor`: what Fixora sees of the host's MCP servers and tools, so a missing crash source
 * can be traced to "server not connected", "server connected but the expected tools are not
 * exposed" (e.g. the Firebase MCP server hides its crashlytics_* tools unless started with
 * `--only crashlytics` or inside a folder with a Crashlytics app), or a naming mismatch.
 */
export function renderDoctor(o: { servers: ServerInfo[]; toolIds: string[]; services: Services; options: { sources: string[]; crashlytics: { appIds: string[] }; jira: { project?: string; parent?: string; issueType: string } } }): string {
  const L: string[] = ["## Fixora doctor", ""]
  L.push("### MCP servers", "")
  if (o.servers.length === 0) L.push("- none configured (`opencode.jsonc` → `mcp.servers`)")
  for (const s of o.servers) {
    const ns = mcpNamespace(s.name)
    const tools = o.toolIds.filter((t) => t.startsWith(`${ns}_`))
    const interesting = tools.filter((t) => /crashlytics|issue|merge_request|pull_request|jira/i.test(t))
    L.push(`- **${s.name}** (${statusOf(s)}) — ${tools.length} tool(s)${interesting.length ? `: ${interesting.slice(0, 12).map((t) => `\`${t}\``).join(", ")}${interesting.length > 12 ? ", …" : ""}` : tools.length ? " (none look like crash / ticket / MR tools)" : ""}`)
  }
  L.push("", "### Services Fixora recognised", "")
  const ids = ["sentry", "crashlytics", "jira", "gitlab", "github"] as const
  for (const id of ids) {
    const s = o.services[id]
    if (!s) {
      L.push(`- ${id}: not found${id === "crashlytics" ? " — expected tools ending in `crashlytics_get_issue` / `crashlytics_batch_get_events` / `crashlytics_get_report`" : id === "sentry" ? " — expected `get_issue_details` / `search_issues`" : id === "jira" ? " — expected `jira_get_issue` / `jira_search` / `jira_create_issue`" : id === "gitlab" ? " — expected `create_merge_request`" : " — expected `create_pull_request`"}`)
      continue
    }
    L.push(`- ${id}: server "${s.serverName}" (${s.status}) — ${Object.entries(s.capabilities).map(([k, v]) => `${k}→\`${v}\``).join(", ")}`)
  }
  L.push("", "### Options", "", `- sources: ${o.options.sources.join(", ") || "none"}`, `- crashlytics.appIds: ${o.options.crashlytics.appIds.join(", ") || "none"}`, `- jira: ${o.options.jira.project ? `${o.options.jira.project} / ${o.options.jira.issueType}${o.options.jira.parent ? ` under ${o.options.jira.parent}` : ""}` : "no project (tickets off)"}`)
  const fb = o.servers.find((s) => /firebase/i.test(s.name))
  if (fb && statusOf(fb) === "connected" && !o.services.crashlytics) {
    L.push("", "### Likely fix", "", `The Firebase MCP server "${fb.name}" is connected but exposes no \`crashlytics_*\` tools. firebase-tools only enables the Crashlytics feature group when it finds a Flutter / Android / iOS app with the Crashlytics SDK in its working directory, or when started with \`--only crashlytics\`. Change its command to:`, "", "```jsonc", `"${fb.name}": { "type": "local", "command": ["npx", "-y", "firebase-tools@latest", "mcp", "--only", "crashlytics"] }`, "```", "", "then reconnect it from /mcps and run `/fixora doctor` again. Make sure `firebase login` was done for the account that can see the project.")
  }
  return L.join("\n")
}
