// Credentials + a small Jira Server/Data Center REST v2 client. No dependency on the DXcoder host
// so it can be exercised against test/mock-jira.ts.

export interface Credentials {
  baseUrl: string
  authHeader: string
  authKind: "pat" | "basic"
  insecure: boolean
  source: string
}

export interface CredentialSources {
  /** `ctx.options.jira` from opencode.jsonc */
  options?: unknown
  /** `environment` of the detected local mcp-atlassian server */
  mcpEnv?: Record<string, string | undefined>
  processEnv?: Record<string, string | undefined>
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const flag = (v: unknown) => {
  if (typeof v === "boolean") return v
  if (typeof v === "string") return !["false", "0", "no", "off"].includes(v.trim().toLowerCase())
  return undefined
}

function fromEnv(env: Record<string, string | undefined> | undefined, source: string): Credentials | undefined {
  if (!env) return undefined
  return build(
    {
      url: str(env.JIRA_URL),
      token: str(env.JIRA_PERSONAL_TOKEN),
      username: str(env.JIRA_USERNAME),
      password: str(env.JIRA_API_TOKEN) ?? str(env.JIRA_PASSWORD),
      sslVerify: flag(env.JIRA_SSL_VERIFY),
    },
    source,
  )
}

function build(
  c: { url?: string; token?: string; username?: string; password?: string; sslVerify?: boolean },
  source: string,
): Credentials | undefined {
  if (!c.url) return undefined
  const baseUrl = c.url.replace(/\/+$/, "")
  if (c.token) return { baseUrl, authHeader: `Bearer ${c.token}`, authKind: "pat", insecure: c.sslVerify === false, source }
  if (c.username && c.password) {
    const encoded = Buffer.from(`${c.username}:${c.password}`, "utf8").toString("base64")
    return { baseUrl, authHeader: `Basic ${encoded}`, authKind: "basic", insecure: c.sslVerify === false, source }
  }
  return undefined
}

/** Resolution order: plugin options → MCP server environment → process environment. */
export function resolveCredentials(sources: CredentialSources): Credentials | undefined {
  const o = sources.options
  if (o && typeof o === "object") {
    const r = o as Record<string, unknown>
    const fromOptions = build(
      { url: str(r.url), token: str(r.token), username: str(r.username), password: str(r.password), sslVerify: flag(r.sslVerify) },
      "plugin options",
    )
    if (fromOptions) return fromOptions
  }
  return fromEnv(sources.mcpEnv, "MCP server environment") ?? fromEnv(sources.processEnv, "process environment")
}

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly path: string,
  ) {
    super(message)
    this.name = "JiraError"
  }
  /** Field ids Jira complained about in a 400 response (`errors: { customfield_1: "..." }`). */
  get fieldErrors(): Record<string, string> {
    const b = this.body as { errors?: Record<string, string> } | undefined
    return b && typeof b === "object" && b.errors && typeof b.errors === "object" ? b.errors : {}
  }
  get messages(): string[] {
    const b = this.body as { errorMessages?: string[] } | undefined
    const list = b && typeof b === "object" && Array.isArray(b.errorMessages) ? b.errorMessages : []
    return [...list, ...Object.entries(this.fieldErrors).map(([k, v]) => `${k}: ${v}`)]
  }
}

export interface JiraField {
  id: string
  name: string
  custom?: boolean
}
export interface JiraIssueType {
  id: string
  name: string
  subtask?: boolean
}
export interface JiraAttachment {
  id: string
  filename: string
  size: number
  mimeType?: string
  content: string
  created?: string
  author?: { displayName?: string; name?: string }
}
export interface JiraComment {
  id: string
  body?: string
  created?: string
  author?: { displayName?: string; name?: string }
}
export interface JiraIssue {
  id: string
  key: string
  fields: Record<string, unknown> & {
    summary?: string
    description?: string | null
    issuetype?: JiraIssueType
    status?: { name?: string }
    priority?: { name?: string }
    labels?: string[]
    components?: Array<{ name?: string }>
    assignee?: { displayName?: string; name?: string } | null
    attachment?: JiraAttachment[]
    subtasks?: Array<{ id: string; key: string; fields?: { summary?: string; status?: { name?: string } } }>
    comment?: { comments?: JiraComment[] }
    issuelinks?: Array<{
      type?: { name?: string; inward?: string; outward?: string }
      inwardIssue?: { key: string; fields?: { summary?: string; status?: { name?: string } } }
      outwardIssue?: { key: string; fields?: { summary?: string; status?: { name?: string } } }
    }>
    parent?: { key: string; fields?: { summary?: string } }
  }
  renderedFields?: Record<string, unknown>
}

type FetchLike = typeof fetch

export class JiraClient {
  constructor(
    readonly credentials: Credentials,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly retries = 2,
  ) {}

  get host(): string {
    return new URL(this.credentials.baseUrl).host
  }

  private init(method: string, body?: unknown, accept = "application/json"): RequestInit {
    const headers: Record<string, string> = { Authorization: this.credentials.authHeader, Accept: accept }
    if (body !== undefined) headers["Content-Type"] = "application/json"
    const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    }
    // Honoured by Bun's fetch; ignored by Node's. JIRA_SSL_VERIFY=false on Node needs
    // NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment instead.
    if (this.credentials.insecure) init.tls = { rejectUnauthorized: false }
    return init
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.credentials.baseUrl}${path}`
    let attempt = 0
    for (;;) {
      let response: Response
      try {
        response = await this.fetchImpl(url, this.init(method, body))
      } catch (error) {
        if (attempt++ < this.retries) continue
        throw new JiraError(`Jira request failed: ${(error as Error).message}`, 0, undefined, path)
      }
      if ((response.status === 429 || response.status >= 502) && attempt++ < this.retries) {
        await new Promise((r) => setTimeout(r, 500 * attempt))
        continue
      }
      const text = await response.text()
      const parsed = text ? safeJson(text) : undefined
      if (!response.ok) {
        const detail =
          parsed && typeof parsed === "object"
            ? new JiraError("", response.status, parsed, path).messages.join("; ")
            : text.slice(0, 300)
        throw new JiraError(`Jira ${method} ${path} → ${response.status}${detail ? `: ${detail}` : ""}`, response.status, parsed ?? text, path)
      }
      return (parsed ?? (text as unknown)) as T
    }
  }

  myself() {
    return this.request<{ name?: string; displayName?: string; emailAddress?: string }>("GET", "/rest/api/2/myself")
  }
  fields() {
    return this.request<JiraField[]>("GET", "/rest/api/2/field")
  }
  issue(key: string, fields: string[], expand?: string[]) {
    const q = new URLSearchParams({ fields: fields.join(",") })
    if (expand?.length) q.set("expand", expand.join(","))
    return this.request<JiraIssue>("GET", `/rest/api/2/issue/${encodeURIComponent(key)}?${q}`)
  }
  async search(jql: string, fields: string[], max = 100) {
    const q = new URLSearchParams({ jql, fields: fields.join(","), maxResults: String(max) })
    const res = await this.request<{ issues?: JiraIssue[] }>("GET", `/rest/api/2/search?${q}`)
    return res.issues ?? []
  }
  project(key: string) {
    return this.request<{ id: string; key: string; issueTypes?: JiraIssueType[] }>("GET", `/rest/api/2/project/${encodeURIComponent(key)}`)
  }
  createIssue(fields: Record<string, unknown>) {
    return this.request<{ id: string; key: string; self?: string }>("POST", "/rest/api/2/issue", { fields })
  }
  updateIssue(key: string, fields: Record<string, unknown>) {
    return this.request<unknown>("PUT", `/rest/api/2/issue/${encodeURIComponent(key)}`, { fields })
  }
  addComment(key: string, body: string) {
    return this.request<{ id: string }>("POST", `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body })
  }

  /** Downloads an attachment. Only URLs on the Jira host are allowed (SSRF guard). */
  async download(url: string, maxBytes: number): Promise<Uint8Array> {
    const target = new URL(url, this.credentials.baseUrl)
    if (target.host !== this.host) throw new Error(`refusing to download from ${target.host} (not the Jira host ${this.host})`)
    const response = await this.fetchImpl(target.href, this.init("GET", undefined, "*/*"))
    if (!response.ok) throw new JiraError(`attachment download → ${response.status}`, response.status, undefined, target.pathname)
    const length = Number(response.headers.get("content-length") ?? "0")
    if (length > maxBytes) throw new Error(`attachment is ${length} bytes, above the ${maxBytes} byte limit`)
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) throw new Error(`attachment is ${buffer.byteLength} bytes, above the ${maxBytes} byte limit`)
    return buffer
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const DEFAULT_STORY_POINTS_NAMES = ["Story Points", "Story point estimate", "Story Point Estimate"]

export function findStoryPointsField(fields: JiraField[], opts: { id?: string; names?: string[] }): JiraField | undefined {
  if (opts.id) {
    const byId = fields.find((f) => f.id === opts.id)
    if (byId) return byId
  }
  const names = (opts.names ?? DEFAULT_STORY_POINTS_NAMES).map((n) => n.toLowerCase())
  return fields.find((f) => names.includes(f.name.toLowerCase()))
}

export function findSubtaskIssueType(types: JiraIssueType[], preferred?: string): { type?: JiraIssueType; candidates: JiraIssueType[] } {
  const candidates = types.filter((t) => t.subtask)
  if (preferred) {
    const byName = candidates.find((t) => t.name.toLowerCase() === preferred.toLowerCase())
    return { type: byName, candidates }
  }
  return { type: candidates.length === 1 ? candidates[0] : undefined, candidates }
}

export const projectKeyOf = (issueKey: string) => issueKey.slice(0, issueKey.lastIndexOf("-"))

export function storyPointsOf(issue: JiraIssue, fieldId: string | undefined): number | null {
  if (!fieldId) return null
  const v = issue.fields[fieldId]
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

export function personName(p: { displayName?: string; name?: string } | null | undefined) {
  return p?.displayName ?? p?.name ?? null
}
