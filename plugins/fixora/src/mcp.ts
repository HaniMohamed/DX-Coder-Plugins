// Detects crash sources, Jira and forge MCP servers from the tools the host registered (read-only:
// the plugin lists tools, it never executes them). Namespaces are discovered, never hard-coded.

import type { Plugin } from "@opencode/plugin"
import yaml from "js-yaml"
import type { DetectedService, ServiceId, Services } from "./types.js"

const loadYaml = (text: string): unknown => ((yaml as { safeLoad?: typeof yaml.load }).safeLoad ?? yaml.load)(text, { json: true })

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
    listEvents: /(^|_)crashlytics_list_events$/,
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
    createMr: /(^|_)create_(merge_request|mr)$/,
    getMr: /(^|_)get_(merge_request|mr)$/,
    updateMr: /(^|_)update_(merge_request|mr)$/,
    listMrs: /(^|_)list_(merge_requests|mrs)$/,
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

/** Capabilities that change state on the remote service (need an explicit grant in the worker). */
export const WRITE_CAPABILITIES = new Set(["updateIssue", "createNote", "createIssue", "addComment", "transition", "createMr", "updateMr", "createPr", "updatePr"])

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
    // Exact namespace first; else the server whose namespace prefixes it (tools named `gitlab_create_mr`
    // on a server called "gitlab" give the id `gitlab_gitlab_create_mr`).
    const server =
      servers.find((s) => mcpNamespace(s.name) === namespace) ??
      servers.filter((s) => namespace.startsWith(`${mcpNamespace(s.name)}_`)).sort((a, b) => b.name.length - a.name.length)[0]
    // The CodeMode path is `tools.<server namespace>.<tool name>`: a server called "gitlab" whose tools
    // are named `gitlab_list_mrs` is reached as `tools.gitlab.gitlab_list_mrs`, not `tools.gitlab_gitlab.list_mrs`,
    // so the namespace is the server's whenever the server is known.
    out[id] = {
      id,
      namespace: server ? mcpNamespace(server.name) : namespace,
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

export interface ToolSchema {
  description?: string
  props: Record<string, unknown>
  required: string[]
}

/** Declared input schemas of every host tool, from the (read-only) tool list. */
export async function toolSchemas(ctx: Plugin.Context): Promise<Map<string, ToolSchema>> {
  const out = new Map<string, ToolSchema>()
  const tools = (await ctx.tool.list()) as unknown as Array<{ id: string; description?: string; input?: { properties?: Record<string, unknown>; required?: string[] } }>
  for (const t of tools) out.set(t.id, { description: t.description, props: t.input?.properties ?? {}, required: t.input?.required ?? [] })
  return out
}

/** Which service a tool id belongs to, by namespace prefix, plus the capability name when known. */
export function classifyTool(toolId: string, services: Services): { service: DetectedService; capability?: string } | undefined {
  const matches = Object.values(services).filter((s): s is DetectedService => !!s && (s.namespace ? toolId === s.namespace || toolId.startsWith(`${s.namespace}_`) : false))
  const service = matches.sort((a, b) => b.namespace.length - a.namespace.length)[0]
  if (!service) return undefined
  const capability = Object.entries(service.capabilities).find(([, id]) => id === toolId)?.[0]
  return { service, capability }
}

/** Does a tool (by capability name or id) change remote state? Unknown ids are judged by their name. */
export function isWriteTool(toolId: string, capability?: string): boolean {
  if (capability) return WRITE_CAPABILITIES.has(capability)
  const name = toolId.toLowerCase()
  if (/(^|_)(get|search|list|find|read|fetch|describe|batch_get)(_|$)/.test(name)) return false
  return /(create|update|delete|remove|add|set|transition|note|resolve|assign|merge|close|approve|comment|post|put|patch)/.test(name)
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

/** Text values an MCP server pre-formats for humans (stack traces, logs): never re-parsed as YAML. */
const TEXT_KEYS = new Set(["exceptions", "threads", "errors", "logs", "breadcrumbs", "stackTrace", "stacktrace", "text", "content", "usage", "description"])

/**
 * Parses a tool's text output: JSON, else YAML (firebase-tools 15 dumps every result as YAML, and
 * nests YAML documents as strings under each key), else the text itself. Nested YAML strings are
 * parsed too (two levels), scalars are trimmed.
 */
export function parseToolText(raw: unknown): unknown {
  if (typeof raw !== "string") return deepParse(raw, 0)
  return deepParse(tryJson(raw), 0)
}

function deepParse(value: unknown, depth: number, key?: string): unknown {
  if (value instanceof Date) return value.toISOString() // js-yaml turns unquoted timestamps into Dates
  if (typeof value === "string") {
    if (depth === 0 || (key && TEXT_KEYS.has(key))) return value
    const t = value.trim()
    if (!t) return t
    const looksStructured = t.includes("\n") ? /^(-\s|[\w.-]+:\s|[\w.-]+:$)/.test(t) : /^[{[]/.test(t)
    if (!looksStructured) return t
    try {
      const parsed = loadYaml(t)
      if (parsed && typeof parsed === "object") return deepParse(parsed, depth + 1)
      return typeof parsed === "string" ? parsed.trim() : t
    } catch {
      return t
    }
  }
  if (Array.isArray(value)) return value.map((v) => deepParse(v, depth, key))
  if (value && typeof value === "object") {
    if (depth > 3) return value
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = typeof v === "string" && depth === 0 ? deepParse(v, 1, k) : deepParse(v, depth === 0 ? 1 : depth, k)
    return out
  }
  return value
}

/**
 * Which spelling a tool's input schema uses: firebase-tools ≥ 15 declares `appId` / `issueId` /
 * `pageSize`, older releases `app_id` / `issue_id` / `page_size`. Unknown schema → camelCase.
 */
export function paramStyleOf(props: Record<string, unknown>): "camel" | "snake" {
  return Object.keys(props).some((k) => /^(app_id|issue_id|page_size)$/.test(k)) ? "snake" : "camel"
}

/**
 * Renames the keys of a tool input to the spelling its schema declares: exact match first, then the
 * camelCase form, then known aliases. Keys the schema does not know are dropped when the schema lists
 * any property at all (strict servers reject unknown fields); with an empty schema the input is kept.
 */
export function adaptInput(input: Record<string, unknown>, props: Record<string, unknown>, aliases: Record<string, string[]> = {}): Record<string, unknown> {
  const known = new Set(Object.keys(props))
  if (known.size === 0) return input
  const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    const target = [key, camel(key), ...(aliases[key] ?? []), ...(aliases[key] ?? []).map(camel)].find((k) => known.has(k))
    if (target) out[target] = value
  }
  return out
}

/** `/fixora doctor --tool <id>`: a tool's input schema, property by property. */
export function renderToolSchema(toolId: string, tool: { description?: string; input?: { properties?: Record<string, unknown>; required?: string[] } } | undefined): string {
  if (!tool) return `### Tool \`${toolId}\`\n\nnot found (run \`/fixora doctor --all\` for the ids)`
  const props = tool.input?.properties ?? {}
  const required = new Set(tool.input?.required ?? [])
  const L = [`### Tool \`${toolId}\``, "", tool.description ? `${tool.description.slice(0, 400)}` : "", "", "| Property | Type | Required | Description |", "|---|---|---|---|"]
  for (const [name, schema] of Object.entries(props)) {
    const s = (schema ?? {}) as { type?: string | string[]; enum?: unknown[]; description?: string; items?: { type?: string } }
    const type = Array.isArray(s.type) ? s.type.join("|") : (s.type ?? (s.enum ? "enum" : "?")) + (s.items?.type ? `<${s.items.type}>` : "") + (s.enum ? ` (${s.enum.map(String).join(", ").slice(0, 80)})` : "")
    L.push(`| \`${name}\` | ${type} | ${required.has(name) ? "yes" : ""} | ${(s.description ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 160)} |`)
  }
  if (Object.keys(props).length === 0) L.push("| (no properties declared) | | | |")
  return L.join("\n")
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
  if (/^[\w.-]+:(\s|$)|^-\s/m.test(t) && !/^(at |Error|Exception)/.test(t)) {
    try {
      const parsed = loadYaml(t)
      if (parsed && typeof parsed === "object") return parsed
    } catch {
      // not YAML
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
the agent falls back to the glab / gh CLI or a compare URL for the merge request.`

export const notConnectedInstructions = (s: DetectedService) =>
  `The ${s.id} MCP server "${s.serverName}" is configured but its status is "${s.status}". Connect it from /mcps (check its command/URL and credentials), then re-run /fixora.`

/**
 * `/fixora doctor`: what Fixora sees of the host's MCP servers and tools, so a missing crash source
 * can be traced to "server not connected", "server connected but the expected tools are not
 * exposed" (e.g. the Firebase MCP server hides its crashlytics_* tools unless started with
 * `--only crashlytics` or inside a folder with a Crashlytics app), or a naming mismatch.
 */
export function renderDoctor(o: { servers: ServerInfo[]; toolIds: string[]; services: Services; options: { sources: string[]; crashlytics: { appIds: string[] }; jira: { project?: string; parent?: string; issueType: string } }; all?: boolean; warnings?: string[]; version?: string; eventFailures?: string }): string {
  const L: string[] = [`## Fixora doctor${o.version ? ` (plugin ${o.version})` : ""}`, ""]
  if (o.eventFailures) L.push(`⚠ ${o.eventFailures}`, "")
  L.push("### MCP servers", "")
  if (o.servers.length === 0) L.push("- none configured (`opencode.jsonc` → `mcp.servers`)")
  for (const s of o.servers) {
    const ns = mcpNamespace(s.name)
    const tools = o.toolIds.filter((t) => t.startsWith(`${ns}_`))
    const interesting = o.all ? tools : tools.filter((t) => /crashlytics|issue|merge|_mr|pull|jira|sentry/i.test(t))
    const limit = o.all ? tools.length : 16
    L.push(`- **${s.name}** (${statusOf(s)}) — ${tools.length} tool(s)${interesting.length ? `: ${interesting.slice(0, limit).map((t) => `\`${t}\``).join(", ")}${interesting.length > limit ? `, … (${interesting.length - limit} more; \`/fixora doctor --all\` lists everything)` : ""}` : tools.length ? " (none look like crash / ticket / MR tools)" : ""}`)
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
  if (o.warnings?.length) L.push("", "### Ignored legacy options", "", ...o.warnings.map((w) => `- ${w}`))
  const fb = o.servers.find((s) => /firebase/i.test(s.name))
  if (fb && statusOf(fb) === "connected" && !o.services.crashlytics) {
    L.push("", "### Likely fix", "", `The Firebase MCP server "${fb.name}" is connected but exposes no \`crashlytics_*\` tools. firebase-tools only enables the Crashlytics feature group when it finds a Flutter / Android / iOS app with the Crashlytics SDK in its working directory, or when started with \`--only crashlytics\`. Change its command to:`, "", "```jsonc", `"${fb.name}": { "type": "local", "command": ["npx", "-y", "firebase-tools@latest", "mcp", "--only", "crashlytics"] }`, "```", "", "then reconnect it from /mcps and run `/fixora doctor` again. Make sure `firebase login` was done for the account that can see the project.")
  }
  L.push("", "_Fixora runs nothing itself: every git command, check and MCP call is made by the coding agent inside the session's checkout._")
  return L.join("\n")
}
