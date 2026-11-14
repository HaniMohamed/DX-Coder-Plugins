// Jira: prefer the mcp-atlassian MCP tools; fall back to a small REST v2 client (copied subset of
// jira-planner's) when credentials are available. Fixora never registers an MCP server itself.

import { callTool } from "./mcp.js"
import type { FixoraOptions } from "./options.js"
import type { DetectedService } from "./types.js"
import type { Plugin } from "@opencode/plugin"

export interface JiraIssueRef {
  key: string
  url?: string
  status?: string
  summary?: string
}

export interface JiraPort {
  kind: "mcp" | "rest"
  baseUrl?: string
  search(jql: string, max?: number): Promise<JiraIssueRef[]>
  create(fields: { project: string; issueType: string; summary: string; description: string; labels: string[]; parent?: string }): Promise<JiraIssueRef>
  comment(key: string, body: string): Promise<void>
  transitions(key: string): Promise<Array<{ id: string; name: string }>>
  transition(key: string, id: string): Promise<void>
}

// ---------- credentials + REST (subset of jira-planner/src/jira.ts) ----------

export interface Credentials {
  baseUrl: string
  authHeader: string
  authKind: "pat" | "basic"
  insecure: boolean
  source: string
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const flag = (v: unknown) => {
  if (typeof v === "boolean") return v
  if (typeof v === "string") return !["false", "0", "no", "off"].includes(v.trim().toLowerCase())
  return undefined
}

function build(c: { url?: string; token?: string; username?: string; password?: string; sslVerify?: boolean }, source: string): Credentials | undefined {
  if (!c.url) return undefined
  const baseUrl = c.url.replace(/\/+$/, "")
  if (c.token) return { baseUrl, authHeader: `Bearer ${c.token}`, authKind: "pat", insecure: c.sslVerify === false, source }
  if (c.username && c.password) return { baseUrl, authHeader: `Basic ${Buffer.from(`${c.username}:${c.password}`, "utf8").toString("base64")}`, authKind: "basic", insecure: c.sslVerify === false, source }
  return undefined
}

function fromEnv(env: Record<string, string | undefined> | undefined, source: string): Credentials | undefined {
  if (!env) return undefined
  return build({ url: str(env.JIRA_URL), token: str(env.JIRA_PERSONAL_TOKEN), username: str(env.JIRA_USERNAME), password: str(env.JIRA_API_TOKEN) ?? str(env.JIRA_PASSWORD), sslVerify: flag(env.JIRA_SSL_VERIFY) }, source)
}

/** Resolution order: plugin options → MCP server environment → process environment. */
export function resolveCredentials(sources: { options: FixoraOptions["jira"]; mcpEnv?: Record<string, string | undefined>; processEnv?: Record<string, string | undefined> }): Credentials | undefined {
  const o = sources.options
  return build({ url: o.url, token: o.token, username: o.username, password: o.password, sslVerify: o.sslVerify }, "plugin options") ?? fromEnv(sources.mcpEnv, "MCP server environment") ?? fromEnv(sources.processEnv, "process environment")
}

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
    this.name = "JiraError"
  }
}

export class JiraClient {
  constructor(
    readonly credentials: Credentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: this.credentials.authHeader, Accept: "application/json" }
    if (body !== undefined) headers["Content-Type"] = "application/json"
    const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" }
    if (this.credentials.insecure) init.tls = { rejectUnauthorized: false }
    let response: Response
    try {
      response = await this.fetchImpl(`${this.credentials.baseUrl}${path}`, init)
    } catch (error) {
      throw new JiraError(`Jira request failed: ${(error as Error).message}`, 0, undefined)
    }
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = text
    }
    if (!response.ok) {
      const b = parsed as { errorMessages?: string[]; errors?: Record<string, string> } | undefined
      const detail = b && typeof b === "object" ? [...(b.errorMessages ?? []), ...Object.entries(b.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join("; ") : text.slice(0, 300)
      throw new JiraError(`Jira ${method} ${path} → ${response.status}${detail ? `: ${detail}` : ""}`, response.status, parsed)
    }
    return parsed as T
  }
  myself() {
    return this.request<{ name?: string; displayName?: string }>("GET", "/rest/api/2/myself")
  }
  async search(jql: string, max = 20) {
    const q = new URLSearchParams({ jql, fields: "summary,status", maxResults: String(max) })
    const res = await this.request<{ issues?: Array<{ key: string; fields?: { summary?: string; status?: { name?: string } } }> }>("GET", `/rest/api/2/search?${q}`)
    return res.issues ?? []
  }
  createIssue(fields: Record<string, unknown>) {
    return this.request<{ id: string; key: string }>("POST", "/rest/api/2/issue", { fields })
  }
  addComment(key: string, body: string) {
    return this.request<{ id: string }>("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body })
  }
  transitions(key: string) {
    return this.request<{ transitions?: Array<{ id: string; name: string }> }>("GET", `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`)
  }
  transition(key: string, id: string) {
    return this.request<unknown>("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, { transition: { id } })
  }
}

export function restPort(client: JiraClient): JiraPort {
  const base = client.credentials.baseUrl
  return {
    kind: "rest",
    baseUrl: base,
    async search(jql, max) {
      return (await client.search(jql, max)).map((i) => ({ key: i.key, url: `${base}/browse/${i.key}`, status: i.fields?.status?.name, summary: i.fields?.summary }))
    },
    async create(f) {
      const res = await client.createIssue({ project: { key: f.project }, issuetype: { name: f.issueType }, summary: f.summary.slice(0, 255), description: f.description, labels: f.labels, ...(f.parent ? { parent: { key: f.parent } } : {}) })
      return { key: res.key, url: `${base}/browse/${res.key}` }
    },
    async comment(key, body) {
      await client.addComment(key, body)
    },
    async transitions(key) {
      return (await client.transitions(key)).transitions ?? []
    },
    async transition(key, id) {
      await client.transition(key, id)
    },
  }
}

// ---------- MCP port (mcp-atlassian tool shapes; tolerant) ----------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const s = (v: unknown) => (typeof v === "string" ? v : undefined)

export function mcpPort(ctx: Plugin.Context, service: DetectedService, o: { sessionID: string; baseUrl?: string }): JiraPort {
  const caps = service.capabilities
  const call = (cap: string, input: Record<string, unknown>) => {
    const tool = caps[cap]
    if (!tool) throw new Error(`the Jira MCP server exposes no ${cap} tool`)
    return callTool(ctx, tool, input, { sessionID: o.sessionID })
  }
  const browse = (key: string) => (o.baseUrl ? `${o.baseUrl}/browse/${key}` : undefined)
  const issuesOf = (raw: unknown): JiraIssueRef[] => {
    const list: unknown[] = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.issues) ? raw.issues : isRecord(raw) && Array.isArray(raw.results) ? raw.results : []
    return list.filter(isRecord).map((i) => {
      const fields = isRecord(i.fields) ? i.fields : i
      return { key: s(i.key) ?? "", url: s(i.url) ?? browse(s(i.key) ?? ""), status: isRecord(fields.status) ? s(fields.status.name) : s(fields.status), summary: s(fields.summary) }
    }).filter((i) => i.key)
  }
  return {
    kind: "mcp",
    baseUrl: o.baseUrl,
    async search(jql, max = 20) {
      return issuesOf(await call("search", { jql, limit: max, fields: "summary,status" }))
    },
    async create(f) {
      // mcp-atlassian takes the parent key in additional_fields (sub-tasks and parent links alike).
      const raw = await call("createIssue", { project_key: f.project, summary: f.summary.slice(0, 255), issue_type: f.issueType, description: f.description, additional_fields: { labels: f.labels, ...(f.parent ? { parent: f.parent } : {}) } })
      const r = isRecord(raw) && isRecord(raw.issue) ? raw.issue : isRecord(raw) ? raw : {}
      const key = s(r.key) ?? /\b[A-Z][A-Z0-9_]+-\d+\b/.exec(typeof raw === "string" ? raw : JSON.stringify(raw))?.[0]
      if (!key) throw new Error(`jira_create_issue returned no issue key: ${JSON.stringify(raw).slice(0, 300)}`)
      return { key, url: s(r.url) ?? browse(key) }
    },
    async comment(key, body) {
      await call("addComment", { issue_key: key, comment: body })
    },
    async transitions(key) {
      if (!caps.getTransitions) return []
      const raw = await call("getTransitions", { issue_key: key })
      const list: unknown[] = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.transitions) ? raw.transitions : []
      return list.filter(isRecord).map((t) => ({ id: String(t.id ?? ""), name: s(t.name) ?? (isRecord(t.to) ? s(t.to.name) : undefined) ?? "" })).filter((t) => t.id)
    },
    async transition(key, id) {
      await call("transition", { issue_key: key, transition_id: id })
    },
  }
}

export interface JiraConnection {
  port: JiraPort
  project?: string
}

/**
 * MCP port when the Jira server is connected and exposes create/search tools; REST port when
 * credentials resolve; otherwise undefined (ticket step is skipped with a notice).
 */
export async function connectJira(ctx: Plugin.Context, o: { service?: DetectedService; options: FixoraOptions; sessionID: string }): Promise<JiraConnection | undefined> {
  const creds = resolveCredentials({ options: o.options.jira, mcpEnv: o.service?.environment, processEnv: process.env })
  const baseUrl = creds?.baseUrl ?? o.service?.environment?.JIRA_URL?.replace(/\/+$/, "")
  if (o.service && o.service.status === "connected" && o.service.capabilities.createIssue && o.service.capabilities.search) {
    return { port: mcpPort(ctx, o.service, { sessionID: o.sessionID, baseUrl }), project: o.options.jira.project }
  }
  if (creds) return { port: restPort(new JiraClient(creds)), project: o.options.jira.project }
  return undefined
}

export const dedupeJql = (project: string | undefined, fingerprint: string) =>
  `${project ? `project = "${project}" AND ` : ""}(labels = "fixora" OR text ~ "fixora-fp") AND text ~ "fixora-fp:${fingerprint.slice(0, 12)}" ORDER BY created DESC`

/** Finds a transition whose name matches loosely ("In Review" ≈ "in-review" ≈ "Review"). */
export function pickTransition(transitions: Array<{ id: string; name: string }>, wanted: string): { id: string; name: string } | undefined {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "")
  const w = norm(wanted)
  return transitions.find((t) => norm(t.name) === w) ?? transitions.find((t) => norm(t.name).includes(w) || w.includes(norm(t.name)))
}
