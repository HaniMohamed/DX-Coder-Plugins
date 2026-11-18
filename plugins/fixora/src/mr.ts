// Merge request / pull request creation: GitLab or GitHub MCP → glab / gh CLI → compare URL. The
// plugin decides the order and renders the exact inputs / commands; the worker session executes them.

import { compareUrl, shellQuote, type ParsedRemote } from "./git.js"
import { adaptInput } from "./mcp.js"
import type { FixoraOptions } from "./options.js"
import type { DetectedService, Services } from "./types.js"

export type MrProvider = "gitlab-mcp" | "github-mcp" | "glab" | "gh" | "url"

export const MR_PROVIDERS: MrProvider[] = ["gitlab-mcp", "github-mcp", "glab", "gh", "url"]

export interface MrTarget {
  remote: ParsedRemote
  base: string
  branch: string
}

export interface MrResult {
  url: string
  id?: string
  provider: MrProvider
  status: "draft" | "open"
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined)

/** Does the MCP server point at the same host as the remote (when we can tell)? */
export function serviceMatchesHost(service: DetectedService | undefined, host: string): boolean {
  if (!service) return false
  const env = service.environment ?? {}
  const configured = [env.GITLAB_API_URL, env.GITLAB_URL, env.GITLAB_HOST, env.GITHUB_HOST, env.GH_HOST, env.GITHUB_API_URL].find((v) => typeof v === "string" && v.trim())
  if (!configured) return true
  try {
    const h = /^https?:\/\//.test(configured) ? new URL(configured).host : configured.replace(/\/.*$/, "")
    return h.toLowerCase() === host.toLowerCase()
  } catch {
    return true
  }
}

/** Providers to try, in order: the matching MCP server, then the CLI, then the compare URL. */
export function mrProviderOrder(services: Services, remote: ParsedRemote, o: { forge?: FixoraOptions["mr"]["forge"] } = {}): MrProvider[] {
  const kind = o.forge ?? remote.kind
  const gl = services.gitlab?.status === "connected" && !!services.gitlab.capabilities.createMr && serviceMatchesHost(services.gitlab, remote.host)
  const gh = services.github?.status === "connected" && !!services.github.capabilities.createPr && serviceMatchesHost(services.github, remote.host)
  const out: MrProvider[] = []
  if (kind === "gitlab") {
    if (gl) out.push("gitlab-mcp")
    out.push("glab")
  } else if (kind === "github") {
    if (gh) out.push("github-mcp")
    out.push("gh")
  } else {
    if (gl) out.push("gitlab-mcp")
    if (gh) out.push("github-mcp")
  }
  out.push("url")
  return out
}

/** Spellings GitLab MCP servers use for the same fields (zereight: snake_case; others: `projectId`, `mrIid`, `body`…). */
export const GITLAB_ALIASES: Record<string, string[]> = {
  project_id: ["projectId", "project", "project_path", "projectPath", "id"],
  source_branch: ["sourceBranch", "source", "branch", "head"],
  target_branch: ["targetBranch", "target", "base"],
  description: ["body", "desc"],
  merge_request_iid: ["mergeRequestIid", "mr_iid", "mrIid", "iid", "merge_request_id", "mergeRequestId", "mr_id", "mrId"],
  remove_source_branch: ["removeSourceBranch", "delete_source_branch", "deleteSourceBranch"],
  state_event: ["stateEvent", "state"],
  labels: ["label"],
  reviewer_ids: ["reviewerIds", "reviewers"],
}

export interface MrBody {
  title: string
  body: string
  draft: boolean
  labels: string[]
  reviewers: string[]
}

export function gitlabCreateInput(t: MrTarget, mr: { title: string; body: string; draft: boolean; labels: string[]; reviewers: string[] }): Record<string, unknown> {
  return {
    project_id: `${t.remote.owner}/${t.remote.repo}`,
    source_branch: t.branch,
    target_branch: t.base,
    title: mr.draft && !/^draft:/i.test(mr.title) ? `Draft: ${mr.title}` : mr.title,
    description: mr.body,
    draft: mr.draft,
    labels: mr.labels.length ? mr.labels.join(",") : undefined,
    remove_source_branch: true,
    ...(mr.reviewers.length ? { reviewer_ids: mr.reviewers } : {}),
  }
}

export function githubCreateInput(t: MrTarget, mr: { title: string; body: string; draft: boolean }): Record<string, unknown> {
  return { owner: t.remote.owner, repo: t.remote.repo, head: t.branch, base: t.base, title: mr.title.replace(/^Draft:\s*/i, ""), body: mr.body, draft: mr.draft }
}

export function gitlabUpdateInput(t: MrTarget, id: string, o: { title?: string; body?: string; close?: boolean }): Record<string, unknown> {
  return { project_id: `${t.remote.owner}/${t.remote.repo}`, merge_request_iid: Number(id), ...(o.title ? { title: o.title } : {}), ...(o.body ? { description: o.body } : {}), ...(o.close ? { state_event: "close" } : {}) }
}

export function githubUpdateInput(t: MrTarget, id: string, o: { title?: string; body?: string; close?: boolean }): Record<string, unknown> {
  return { owner: t.remote.owner, repo: t.remote.repo, pullNumber: Number(id), pull_number: Number(id), ...(o.title ? { title: o.title } : {}), ...(o.body ? { body: o.body } : {}), ...(o.close ? { state: "closed" } : {}) }
}

/** The glab / gh command line that creates the MR (the body is read from a file so quoting stays sane). */
export function cliCreateCommand(provider: "glab" | "gh", t: MrTarget, mr: MrBody, bodyFile: string): string {
  if (provider === "glab") {
    const args = ["glab", "mr", "create", "--source-branch", t.branch, "--target-branch", t.base, "--title", mr.draft ? `Draft: ${mr.title.replace(/^Draft:\s*/i, "")}` : mr.title, "--description-file", bodyFile, "--yes", "--remove-source-branch"]
    if (mr.draft) args.push("--draft")
    if (mr.labels.length) args.push("--label", mr.labels.join(","))
    for (const r of mr.reviewers) args.push("--reviewer", r)
    return args.map(shellQuote).join(" ")
  }
  const args = ["gh", "pr", "create", "--head", t.branch, "--base", t.base, "--title", mr.title.replace(/^Draft:\s*/i, ""), "--body-file", bodyFile]
  if (mr.draft) args.push("--draft")
  for (const l of mr.labels) args.push("--label", l)
  for (const r of mr.reviewers) args.push("--reviewer", r)
  return args.map(shellQuote).join(" ")
}

export function cliUpdateCommand(provider: "glab" | "gh", id: string, o: { title?: string; bodyFile?: string; close?: boolean }): string {
  if (o.close) return provider === "glab" ? `glab mr close ${shellQuote(id)}` : `gh pr close ${shellQuote(id)}`
  if (provider === "glab") return ["glab", "mr", "update", id, ...(o.title ? ["--title", o.title] : []), ...(o.bodyFile ? ["--description-file", o.bodyFile] : [])].map(shellQuote).join(" ")
  return ["gh", "pr", "edit", id, ...(o.title ? ["--title", o.title] : []), ...(o.bodyFile ? ["--body-file", o.bodyFile] : [])].map(shellQuote).join(" ")
}

export const cliViewCommand = (provider: "glab" | "gh", id: string) => (provider === "glab" ? `glab mr view ${shellQuote(id)} --output json` : `gh pr view ${shellQuote(id)} --json state,isDraft,mergedAt,url`)

export interface MrAttempt {
  provider: MrProvider
  /** For MCP providers: the tool id, its server namespace and the exact input. */
  toolId?: string
  namespace?: string
  input?: Record<string, unknown>
  /** For CLI providers: the exact command line (run in the repository root). */
  command?: string
  /** For "url": the compare page to report as `mrSkipped.compareUrl`. */
  url?: string
}

const LABEL_KEYS = ["labels", "label", "add_labels", "addLabels"]

/** The labels field of a tool schema (name + whether it takes an array), when it has one. */
export function labelsField(props: Record<string, unknown>): { key: string; array: boolean } | undefined {
  const key = LABEL_KEYS.find((k) => k in props)
  if (!key) return undefined
  const type = (props[key] as { type?: string | string[] } | undefined)?.type
  return { key, array: Array.isArray(type) ? type.includes("array") : type === "array" }
}

/**
 * Labels in the spelling and shape the schema declares (array or comma string). An unknown schema
 * (no properties listed) gets the GitLab API form `labels: "a,b"`; a schema without a labels field
 * gets none, and the label step after creation adds them.
 */
function withLabels(input: Record<string, unknown>, props: Record<string, unknown>, labels: string[]): Record<string, unknown> {
  if (labels.length === 0) return input
  const field = labelsField(props)
  if (!field) return Object.keys(props).length === 0 ? { ...input, labels: input.labels ?? labels.join(",") } : input
  return { ...input, [field.key]: field.array ? labels : labels.join(",") }
}

/**
 * One attempt per provider in order, with the exact tool input (adapted to the server's schema) or
 * command line. The worker tries them top to bottom and stops at the first success.
 */
export function renderMrAttempts(o: { order: MrProvider[]; target: MrTarget; mr: MrBody; services: Services; toolProps: (toolId: string) => Record<string, unknown>; bodyFile: string }): MrAttempt[] {
  const out: MrAttempt[] = []
  for (const provider of o.order) {
    switch (provider) {
      case "gitlab-mcp": {
        const toolId = o.services.gitlab?.capabilities.createMr
        if (toolId) {
          const props = o.toolProps(toolId)
          out.push({ provider, toolId, namespace: o.services.gitlab?.namespace, input: withLabels(adaptInput(gitlabCreateInput(o.target, o.mr), props, GITLAB_ALIASES), props, o.mr.labels) })
        }
        break
      }
      case "github-mcp": {
        const toolId = o.services.github?.capabilities.createPr
        if (toolId) out.push({ provider, toolId, namespace: o.services.github?.namespace, input: adaptInput(githubCreateInput(o.target, o.mr), o.toolProps(toolId)) })
        break
      }
      case "glab":
      case "gh":
        out.push({ provider, command: cliCreateCommand(provider, o.target, o.mr, o.bodyFile) })
        break
      case "url":
        out.push({ provider, url: compareUrl(o.target.remote, o.target.base, o.target.branch) })
        break
    }
  }
  return out
}

/**
 * How the worker adds the configured labels to a merge request the MCP tool created without them
 * (a create tool whose schema has no labels field, or GitHub, whose create call never takes labels):
 * the update tool when its schema has a labels field, else the CLI. `<id>` is the MR iid / PR number.
 * CLI providers pass `--label` on create and need nothing.
 */
export function renderLabelSteps(o: { order: MrProvider[]; target: MrTarget; labels: string[]; services: Services; toolProps: (toolId: string) => Record<string, unknown> }): MrAttempt[] {
  if (o.labels.length === 0) return []
  const out: MrAttempt[] = []
  const project = `${o.target.remote.owner}/${o.target.remote.repo}`
  for (const provider of o.order) {
    if (provider === "gitlab-mcp") {
      const toolId = o.services.gitlab?.capabilities.updateMr
      const props = toolId ? o.toolProps(toolId) : {}
      if (toolId && labelsField(props)) out.push({ provider, toolId, namespace: o.services.gitlab?.namespace, input: withLabels(adaptInput({ project_id: project, merge_request_iid: "<id>" }, props, GITLAB_ALIASES), props, o.labels) })
      else out.push({ provider, command: ["glab", "mr", "update", "<id>", "--label", o.labels.join(",")].map(shellQuote).join(" ") })
    } else if (provider === "github-mcp") {
      out.push({ provider, command: ["gh", "pr", "edit", "<id>", ...o.labels.flatMap((l) => ["--add-label", l])].map(shellQuote).join(" ") })
    }
  }
  return out
}

/** The update / close / view instruction for an existing MR, by its provider. */
export function renderMrOp(o: { provider: MrProvider; op: "update" | "close" | "view"; target: MrTarget; id?: string; url: string; title?: string; bodyFile?: string; services: Services; toolProps: (toolId: string) => Record<string, unknown> }): MrAttempt | undefined {
  const id = o.id ?? o.url.split("/").pop() ?? ""
  switch (o.provider) {
    case "gitlab-mcp": {
      const toolId = o.op === "view" ? o.services.gitlab?.capabilities.getMr : o.services.gitlab?.capabilities.updateMr
      if (!toolId) return undefined
      const input = o.op === "view" ? { project_id: `${o.target.remote.owner}/${o.target.remote.repo}`, merge_request_iid: Number(id) } : gitlabUpdateInput(o.target, id, { title: o.title, body: o.bodyFile ? `<contents of ${o.bodyFile}>` : undefined, close: o.op === "close" })
      return { provider: o.provider, toolId, namespace: o.services.gitlab?.namespace, input: adaptInput(input, o.toolProps(toolId), GITLAB_ALIASES) }
    }
    case "github-mcp": {
      const toolId = o.op === "view" ? o.services.github?.capabilities.getPr : o.services.github?.capabilities.updatePr
      if (!toolId) return undefined
      const input = o.op === "view" ? { owner: o.target.remote.owner, repo: o.target.remote.repo, pullNumber: Number(id), pull_number: Number(id) } : githubUpdateInput(o.target, id, { title: o.title, body: o.bodyFile ? `<contents of ${o.bodyFile}>` : undefined, close: o.op === "close" })
      return { provider: o.provider, toolId, namespace: o.services.github?.namespace, input: adaptInput(input, o.toolProps(toolId)) }
    }
    case "glab":
    case "gh":
      return { provider: o.provider, command: o.op === "view" ? cliViewCommand(o.provider, id || o.url) : cliUpdateCommand(o.provider, id || o.url, { title: o.title, bodyFile: o.bodyFile, close: o.op === "close" }) }
    case "url":
      return undefined
  }
}

// ---------- listing (recover) ----------

export type MrListState = "all" | "open" | "merged" | "closed"
export type MrListProvider = Exclude<MrProvider, "url">

/** Providers that can LIST merge requests, in order: the matching MCP server (with a list tool), then the CLI. */
export function mrListProviderOrder(services: Services, remote: ParsedRemote | undefined, o: { forge?: FixoraOptions["mr"]["forge"] } = {}): MrListProvider[] {
  const kind = o.forge ?? remote?.kind ?? "unknown"
  const host = remote?.host ?? ""
  const gl = services.gitlab?.status === "connected" && !!services.gitlab.capabilities.listMrs && (!host || serviceMatchesHost(services.gitlab, host))
  const gh = services.github?.status === "connected" && !!services.github.capabilities.listPrs && (!host || serviceMatchesHost(services.github, host))
  const out: MrListProvider[] = []
  if (kind === "gitlab") {
    if (gl) out.push("gitlab-mcp")
    out.push("glab")
  } else if (kind === "github") {
    if (gh) out.push("github-mcp")
    out.push("gh")
  } else {
    if (gl) out.push("gitlab-mcp")
    if (gh) out.push("github-mcp")
    out.push("glab", "gh")
  }
  return out
}

export interface MrListPlan {
  provider: MrListProvider
  /** MCP: the list tool, its namespace and the page-1 input (`page` is incremented by the worker). */
  toolId?: string
  namespace?: string
  input?: Record<string, unknown>
  /** CLI: the exact command; its JSON output goes to `outFile` (page `n` → `<outFile>.<n>.json` for glab). */
  command?: string
  /** The page size the input asks for; a shorter page ends the listing. */
  perPage: number
  /** CLI pages are numbered files; gh pages by itself. */
  pagedFiles: boolean
}

export const LIST_PER_PAGE = 100

/** Every Fixora MR title ends with this; it narrows an unlabelled listing where the forge can search titles. */
export const FIXORA_TITLE_SEARCH = "fixes crash"

/**
 * The exact tool input / command line that lists the merge requests carrying `label` (or, without a
 * label, every merge request — narrowed to Fixora titles where the forge can search). The project
 * path comes from the remote when the plugin could read it, else the placeholder `<owner/repo>` the
 * prompt tells the worker to fill in from `git remote get-url`.
 */
export function renderMrList(o: { provider: MrListProvider; remote?: ParsedRemote; label?: string; state: MrListState; limit: number; services: Services; toolProps: (toolId: string) => Record<string, unknown>; outFile: string }): MrListPlan | undefined {
  const project = o.remote ? `${o.remote.owner}/${o.remote.repo}` : "<owner/repo>"
  const owner = o.remote?.owner ?? "<owner>"
  const repo = o.remote?.repo ?? "<repo>"
  const perPage = Math.min(LIST_PER_PAGE, Math.max(1, o.limit))
  switch (o.provider) {
    case "gitlab-mcp": {
      const toolId = o.services.gitlab?.capabilities.listMrs
      if (!toolId) return undefined
      const props = o.toolProps(toolId)
      const base = { project_id: project, state: o.state === "open" ? "opened" : o.state, per_page: perPage, page: 1, order_by: "updated_at", sort: "desc", ...(o.label ? {} : { search: FIXORA_TITLE_SEARCH, in: "title" }) }
      const input = withLabels(adaptInput(base, props, GITLAB_ALIASES), props, o.label ? [o.label] : [])
      return { provider: o.provider, toolId, namespace: o.services.gitlab?.namespace, input, perPage, pagedFiles: false }
    }
    case "github-mcp": {
      const toolId = o.services.github?.capabilities.listPrs
      if (!toolId) return undefined
      const input = adaptInput({ owner, repo, state: o.state === "open" ? "open" : o.state === "all" ? "all" : "closed", per_page: perPage, page: 1, sort: "updated", direction: "desc" }, o.toolProps(toolId))
      return { provider: o.provider, toolId, namespace: o.services.github?.namespace, input, perPage, pagedFiles: false }
    }
    case "glab": {
      const state = o.state === "all" ? ["--all"] : o.state === "merged" ? ["--merged"] : o.state === "closed" ? ["--closed"] : []
      const args = ["glab", "mr", "list", ...(o.label ? ["--label", o.label] : []), ...state, "--output", "json", "--per-page", String(perPage), "--page", "1"]
      return { provider: o.provider, command: `${args.map(shellQuote).join(" ")} > ${shellQuote(`${o.outFile}.1.json`)}`, perPage, pagedFiles: true }
    }
    case "gh": {
      const fields = "number,title,body,state,isDraft,url,headRefName,baseRefName,createdAt,updatedAt,mergedAt,closedAt,labels,headRefOid,mergeCommit,author"
      const args = ["gh", "pr", "list", ...(o.label ? ["--label", o.label] : ["--search", `"${FIXORA_TITLE_SEARCH}" in:title`]), "--state", o.state, "--limit", String(Math.max(1, o.limit)), "--json", fields]
      return { provider: o.provider, command: `${args.map(shellQuote).join(" ")} > ${shellQuote(`${o.outFile}.1.json`)}`, perPage: Math.max(1, o.limit), pagedFiles: false }
    }
  }
}

export function urlFromResult(raw: unknown): { url?: string; id?: string } {
  if (typeof raw === "string") {
    const url = /https?:\/\/\S+\/(?:-\/merge_requests|merge_requests|pull)\/\d+/.exec(raw)?.[0]
    return { url, id: url?.split("/").pop() }
  }
  if (!isRecord(raw)) return {}
  const r = isRecord(raw.merge_request) ? raw.merge_request : isRecord(raw.pull_request) ? raw.pull_request : raw
  const url = str(r.web_url) ?? str(r.html_url) ?? str(r.url)
  const id = str(r.iid) ?? str(r.number) ?? str(r.id)
  return { url, id }
}

export const isMrUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\/\S+\/(?:-\/merge_requests|merge_requests|pull)\/\d+\/?$/.test(v)

export function statusFromResult(raw: unknown): "draft" | "open" | "merged" | "closed" | undefined {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "")
  const r = isRecord(raw) ? (isRecord(raw.merge_request) ? raw.merge_request : isRecord(raw.pull_request) ? raw.pull_request : raw) : {}
  const state = (str(r.state) ?? "").toLowerCase()
  const merged = r.merged === true || r.merged_at || r.mergedAt || /"state":\s*"merged"/i.test(text) || state === "merged"
  if (merged) return "merged"
  if (state === "closed") return "closed"
  if (r.draft === true || r.isDraft === true || r.work_in_progress === true || /"draft":\s*true/.test(text)) return "draft"
  if (state === "opened" || state === "open") return "open"
  return undefined
}
