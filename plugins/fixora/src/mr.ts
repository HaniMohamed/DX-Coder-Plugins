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
        if (toolId) out.push({ provider, toolId, namespace: o.services.gitlab?.namespace, input: adaptInput(gitlabCreateInput(o.target, o.mr), o.toolProps(toolId), GITLAB_ALIASES) })
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
