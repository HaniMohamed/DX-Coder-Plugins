// Merge request / pull request creation: GitLab or GitHub MCP → glab / gh CLI → compare URL.

import type { Plugin } from "@opencode/plugin"
import { compareUrl, type ParsedRemote } from "./git.js"
import { callTool } from "./mcp.js"
import type { FixoraOptions } from "./options.js"
import type { DetectedService, Services } from "./types.js"

export type MrProvider = "gitlab-mcp" | "github-mcp" | "glab" | "gh" | "url"

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

export async function cliAvailable(bin: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

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

export async function pickMrProvider(services: Services, remote: ParsedRemote, o: { forge?: FixoraOptions["mr"]["forge"]; cli?: (bin: string) => Promise<boolean> }): Promise<MrProvider> {
  const kind = o.forge ?? remote.kind
  const cli = o.cli ?? cliAvailable
  if (kind === "gitlab") {
    if (services.gitlab?.status === "connected" && services.gitlab.capabilities.createMr && serviceMatchesHost(services.gitlab, remote.host)) return "gitlab-mcp"
    if (await cli("glab")) return "glab"
  }
  if (kind === "github") {
    if (services.github?.status === "connected" && services.github.capabilities.createPr && serviceMatchesHost(services.github, remote.host)) return "github-mcp"
    if (await cli("gh")) return "gh"
  }
  if (kind === "unknown") {
    if (services.gitlab?.status === "connected" && services.gitlab.capabilities.createMr && serviceMatchesHost(services.gitlab, remote.host)) return "gitlab-mcp"
    if (services.github?.status === "connected" && services.github.capabilities.createPr && serviceMatchesHost(services.github, remote.host)) return "github-mcp"
  }
  return "url"
}

async function run(cmd: string[], cwd: string, timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" } })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  return { code, stdout, stderr }
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

export async function createMr(ctx: Plugin.Context, o: { provider: MrProvider; target: MrTarget; title: string; body: string; draft: boolean; labels: string[]; reviewers: string[]; services: Services; sessionID: string; cwd: string }): Promise<MrResult> {
  const t = o.target
  switch (o.provider) {
    case "gitlab-mcp": {
      const raw = await callTool(ctx, o.services.gitlab!.capabilities.createMr!, gitlabCreateInput(t, o), { sessionID: o.sessionID })
      const { url, id } = urlFromResult(raw)
      if (!url) throw new Error(`create_merge_request returned no URL: ${JSON.stringify(raw).slice(0, 300)}`)
      return { url, id, provider: "gitlab-mcp", status: o.draft ? "draft" : "open" }
    }
    case "github-mcp": {
      const raw = await callTool(ctx, o.services.github!.capabilities.createPr!, githubCreateInput(t, o), { sessionID: o.sessionID })
      const { url, id } = urlFromResult(raw)
      if (!url) throw new Error(`create_pull_request returned no URL: ${JSON.stringify(raw).slice(0, 300)}`)
      return { url, id, provider: "github-mcp", status: o.draft ? "draft" : "open" }
    }
    case "glab": {
      const args = ["glab", "mr", "create", "--source-branch", t.branch, "--target-branch", t.base, "--title", o.draft ? `Draft: ${o.title.replace(/^Draft:\s*/i, "")}` : o.title, "--description", o.body, "--yes", "--remove-source-branch"]
      if (o.draft) args.push("--draft")
      if (o.labels.length) args.push("--label", o.labels.join(","))
      for (const r of o.reviewers) args.push("--reviewer", r)
      const res = await run(args, o.cwd)
      const { url, id } = urlFromResult(`${res.stdout}\n${res.stderr}`)
      if (res.code !== 0 || !url) throw new Error(`glab mr create failed (${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 500)}`)
      return { url, id, provider: "glab", status: o.draft ? "draft" : "open" }
    }
    case "gh": {
      const args = ["gh", "pr", "create", "--head", t.branch, "--base", t.base, "--title", o.title.replace(/^Draft:\s*/i, ""), "--body", o.body]
      if (o.draft) args.push("--draft")
      for (const l of o.labels) args.push("--label", l)
      for (const r of o.reviewers) args.push("--reviewer", r)
      const res = await run(args, o.cwd)
      const { url, id } = urlFromResult(`${res.stdout}\n${res.stderr}`)
      if (res.code !== 0 || !url) throw new Error(`gh pr create failed (${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 500)}`)
      return { url, id, provider: "gh", status: o.draft ? "draft" : "open" }
    }
    case "url":
      return { url: compareUrl(t.remote, t.base, t.branch), provider: "url", status: "open" }
  }
}

export async function updateMr(ctx: Plugin.Context, o: { provider: MrProvider; target: MrTarget; id?: string; url: string; title?: string; body?: string; close?: boolean; services: Services; sessionID: string; cwd: string }): Promise<void> {
  switch (o.provider) {
    case "gitlab-mcp": {
      const tool = o.services.gitlab?.capabilities.updateMr
      if (!tool || !o.id) return
      await callTool(ctx, tool, { project_id: `${o.target.remote.owner}/${o.target.remote.repo}`, merge_request_iid: Number(o.id), ...(o.title ? { title: o.title } : {}), ...(o.body ? { description: o.body } : {}), ...(o.close ? { state_event: "close" } : {}) }, { sessionID: o.sessionID })
      return
    }
    case "github-mcp": {
      const tool = o.services.github?.capabilities.updatePr
      if (!tool || !o.id) return
      await callTool(ctx, tool, { owner: o.target.remote.owner, repo: o.target.remote.repo, pullNumber: Number(o.id), pull_number: Number(o.id), ...(o.title ? { title: o.title } : {}), ...(o.body ? { body: o.body } : {}), ...(o.close ? { state: "closed" } : {}) }, { sessionID: o.sessionID })
      return
    }
    case "glab": {
      if (o.close) await run(["glab", "mr", "close", o.id ?? o.url], o.cwd)
      else if (o.id) await run(["glab", "mr", "update", o.id, ...(o.title ? ["--title", o.title] : []), ...(o.body ? ["--description", o.body] : [])], o.cwd)
      return
    }
    case "gh": {
      if (o.close) await run(["gh", "pr", "close", o.id ?? o.url], o.cwd)
      else if (o.id) await run(["gh", "pr", "edit", o.id, ...(o.title ? ["--title", o.title] : []), ...(o.body ? ["--body", o.body] : [])], o.cwd)
      return
    }
    case "url":
      return
  }
}

export function statusFromResult(raw: unknown): "draft" | "open" | "merged" | "closed" | undefined {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "")
  const r = isRecord(raw) ? (isRecord(raw.merge_request) ? raw.merge_request : isRecord(raw.pull_request) ? raw.pull_request : raw) : {}
  const state = (str(r.state) ?? "").toLowerCase()
  const merged = r.merged === true || r.merged_at || /"state":\s*"merged"/i.test(text) || state === "merged"
  if (merged) return "merged"
  if (state === "closed") return "closed"
  if (r.draft === true || r.work_in_progress === true || /"draft":\s*true/.test(text)) return "draft"
  if (state === "opened" || state === "open") return "open"
  return undefined
}

export async function syncMrStatus(ctx: Plugin.Context, o: { provider: MrProvider; target: MrTarget; id?: string; url: string; services: Services; sessionID: string; cwd: string }): Promise<"draft" | "open" | "merged" | "closed" | undefined> {
  try {
    switch (o.provider) {
      case "gitlab-mcp": {
        const tool = o.services.gitlab?.capabilities.getMr
        if (!tool || !o.id) return undefined
        return statusFromResult(await callTool(ctx, tool, { project_id: `${o.target.remote.owner}/${o.target.remote.repo}`, merge_request_iid: Number(o.id) }, { sessionID: o.sessionID }))
      }
      case "github-mcp": {
        const tool = o.services.github?.capabilities.getPr
        if (!tool || !o.id) return undefined
        return statusFromResult(await callTool(ctx, tool, { owner: o.target.remote.owner, repo: o.target.remote.repo, pullNumber: Number(o.id), pull_number: Number(o.id) }, { sessionID: o.sessionID }))
      }
      case "glab": {
        const res = await run(["glab", "mr", "view", o.id ?? o.url, "--output", "json"], o.cwd)
        return res.code === 0 ? statusFromResult(JSON.parse(res.stdout)) : undefined
      }
      case "gh": {
        const res = await run(["gh", "pr", "view", o.id ?? o.url, "--json", "state,isDraft,mergedAt"], o.cwd)
        if (res.code !== 0) return undefined
        const j = JSON.parse(res.stdout) as { state?: string; isDraft?: boolean; mergedAt?: string }
        if (j.mergedAt || j.state === "MERGED") return "merged"
        if (j.state === "CLOSED") return "closed"
        return j.isDraft ? "draft" : "open"
      }
      case "url":
        return undefined
    }
  } catch {
    return undefined
  }
}
