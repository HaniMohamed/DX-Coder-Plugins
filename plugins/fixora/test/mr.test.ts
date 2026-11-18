import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assertSafePush, branchFromTemplate, branchName, compareUrl, isProtectedBranch, parseRemote, slug, unknownBranchPlaceholders } from "../src/git.js"
import { cliCreateCommand, githubCreateInput, gitlabCreateInput, mrProviderOrder, renderLabelSteps, renderMrAttempts, renderMrOp, serviceMatchesHost, statusFromResult, urlFromResult } from "../src/mr.js"
import type { Services } from "../src/types.js"

const fixture = (p: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", p), "utf8")) as unknown

describe("git helpers (pure)", () => {
  test("parseRemote for ssh and https, gitlab and github", () => {
    expect(parseRemote("git@gitlab.example.com:mobile/apps/shop.git")).toEqual({ host: "gitlab.example.com", owner: "mobile/apps", repo: "shop", kind: "gitlab", web: "https://gitlab.example.com/mobile/apps/shop" })
    expect(parseRemote("https://github.com/acme/shop.git")).toMatchObject({ host: "github.com", owner: "acme", repo: "shop", kind: "github" })
    expect(parseRemote("ssh://git@git.corp.io:2222/team/app")).toMatchObject({ host: "git.corp.io", owner: "team", repo: "app", kind: "unknown" })
    expect(parseRemote("ssh://git@git.corp.io/team/app", "gitlab")?.kind).toBe("gitlab")
    expect(parseRemote("nonsense")).toBeUndefined()
  })

  test("compareUrl", () => {
    const gl = parseRemote("git@gitlab.example.com:mobile/shop.git")!
    expect(compareUrl(gl, "main", "fixora/x")).toBe("https://gitlab.example.com/mobile/shop/-/merge_requests/new?merge_request%5Bsource_branch%5D=fixora%2Fx&merge_request%5Btarget_branch%5D=main")
    const gh = parseRemote("https://github.com/acme/shop")!
    expect(compareUrl(gh, "main", "fixora/x")).toBe("https://github.com/acme/shop/compare/main...fixora%2Fx?expand=1")
  })

  test("branch names and push safety", () => {
    expect(slug("Null check operator used on a null value!!")).toBe("null-check-operator-used-on-a-null-value")
    const b = branchName("fixora/", "sentry-4523123", "TypeError: Cannot read properties of undefined (reading 'id')")
    expect(b.startsWith("fixora/sentry-4523123-typeerror-cannot-read")).toBe(true)
    expect(b.length).toBeLessThanOrEqual(80)
    expect(branchName("fixora/", "sentry-1", "x", 1)).toBe("fixora/sentry-1-x-r2")
    // The configured convention: `type/ticket-number-short-description` after the prefix.
    const vars = { type: "fix", ticket: "DE-456", slug: slug("Crash on startup: TypeError", 32), runId: "sentry-1", crashId: "4523123" }
    expect(branchFromTemplate("fixora/", "{type}/{ticket}-{slug}", vars)).toBe("fixora/fix/DE-456-crash-on-startup-typeerror")
    expect(branchFromTemplate("fix/", "{ticket}-{slug}", vars, 1)).toBe("fix/DE-456-crash-on-startup-typeerror-r2")
    expect(branchFromTemplate("fixora/", "{type}/{ticket}-{slug}", { ...vars, ticket: "<key>" })).toBe("fixora/fix/<key>-crash-on-startup-typeerror")
    expect(branchFromTemplate("fixora/", "/{crashId}--{runId}/", vars)).toBe("fixora/4523123-sentry-1")
    expect(unknownBranchPlaceholders("{type}/{ticket}-{slug}")).toEqual([])
    expect(unknownBranchPlaceholders("{kind}/{ticket}-{desc}")).toEqual(["kind", "desc"])
    expect(isProtectedBranch("main", "develop")).toBe(true)
    expect(isProtectedBranch("release/1.2", "main")).toBe(true)
    expect(isProtectedBranch("fixora/x", "main")).toBe(false)
    expect(() => assertSafePush("main", "main", [])).toThrow("protected")
    expect(() => assertSafePush("fixora/x", "main", ["push", "--force"])).toThrow("force")
    expect(() => assertSafePush("fixora/x", "main", ["push", "-f"])).toThrow("force")
    expect(() => assertSafePush("fixora/x", "main", ["push", "--delete"])).toThrow()
    expect(() => assertSafePush("bad..name", "main", [])).toThrow("invalid branch name")
    expect(() => assertSafePush("fixora/x", "main", ["push", "-u", "origin", "fixora/x:refs/heads/fixora/x"])).not.toThrow()
  })
})

describe("mr", () => {
  const remoteGl = parseRemote("git@gitlab.example.com:mobile/shop.git")!
  const remoteGh = parseRemote("https://github.com/acme/shop.git")!
  const services: Services = {
    gitlab: { id: "gitlab", namespace: "gitlab", serverName: "gitlab", status: "connected", toolIds: [], capabilities: { createMr: "gitlab_create_merge_request" }, environment: { GITLAB_API_URL: "https://gitlab.example.com/api/v4" } },
    github: { id: "github", namespace: "github", serverName: "github", status: "connected", toolIds: [], capabilities: { createPr: "github_create_pull_request" } },
  }

  test("provider order: MCP → CLI → URL, honouring the host", () => {
    expect(mrProviderOrder(services, remoteGl)).toEqual(["gitlab-mcp", "glab", "url"])
    expect(mrProviderOrder(services, remoteGh)).toEqual(["github-mcp", "gh", "url"])
    const other = { ...services, gitlab: { ...services.gitlab!, environment: { GITLAB_API_URL: "https://gitlab.other.com/api/v4" } } }
    expect(mrProviderOrder(other, remoteGl)).toEqual(["glab", "url"])
    expect(mrProviderOrder({}, remoteGh)).toEqual(["gh", "url"])
    expect(mrProviderOrder({}, parseRemote("ssh://git@git.corp.io/team/app")!)).toEqual(["url"])
    expect(mrProviderOrder(services, parseRemote("ssh://git@git.corp.io/team/app")!)).toEqual(["github-mcp", "url"]) // the GitLab server is pinned to another host
    expect(mrProviderOrder({ gitlab: services.gitlab }, parseRemote("ssh://git@git.corp.io/team/app")!, { forge: "gitlab" })).toEqual(["glab", "url"])
    expect(mrProviderOrder({ gitlab: { ...services.gitlab!, environment: {} } }, parseRemote("ssh://git@git.corp.io/team/app")!, { forge: "gitlab" })).toEqual(["gitlab-mcp", "glab", "url"])
    expect(serviceMatchesHost(services.gitlab, "gitlab.example.com")).toBe(true)
    expect(serviceMatchesHost(services.github, "github.com")).toBe(true)
  })

  test("attempts carry the adapted MCP input, the exact CLI line and the compare URL", () => {
    const target = { remote: remoteGl, base: "main", branch: "fixora/x" }
    const mr = { title: "Guard nil", body: "b", draft: true, labels: ["fixora"], reviewers: ["bob"] }
    const attempts = renderMrAttempts({ order: ["gitlab-mcp", "glab", "url"], target, mr, services, toolProps: () => ({ projectId: {}, sourceBranch: {}, targetBranch: {}, title: {}, body: {}, draft: {} }), bodyFile: "/run/mr.md" })
    expect(attempts[0]).toMatchObject({ provider: "gitlab-mcp", toolId: "gitlab_create_merge_request", input: { projectId: "mobile/shop", sourceBranch: "fixora/x", targetBranch: "main", title: "Draft: Guard nil", body: "b", draft: true } })
    // A create schema without a labels field drops the label (seen live): the label step adds it afterwards.
    expect(attempts[0]!.input).not.toHaveProperty("labels")
    const steps = renderLabelSteps({ order: ["gitlab-mcp", "glab", "url"], target, labels: ["fixora"], services, toolProps: () => ({}) })
    expect(steps).toEqual([{ provider: "gitlab-mcp", command: "glab mr update '<id>' --label fixora" }])
    // The schema's shape wins: array labels on create, `labels` on an update tool that has them.
    const withArray = renderMrAttempts({ order: ["gitlab-mcp"], target, mr, services, toolProps: () => ({ project_id: {}, source_branch: {}, target_branch: {}, title: {}, description: {}, labels: { type: "array" } }), bodyFile: "/run/mr.md" })
    expect(withArray[0]!.input).toMatchObject({ labels: ["fixora"], description: "b" })
    const withString = renderMrAttempts({ order: ["gitlab-mcp"], target, mr, services, toolProps: () => ({ project_id: {}, title: {}, label: { type: "string" } }), bodyFile: "/run/mr.md" })
    expect(withString[0]!.input).toMatchObject({ label: "fixora" })
    const svc = { gitlab: { ...services.gitlab!, capabilities: { ...services.gitlab!.capabilities, updateMr: "gitlab_update_merge_request" } }, github: services.github }
    const update = renderLabelSteps({ order: ["gitlab-mcp", "github-mcp"], target, labels: ["fixora", "crash"], services: svc, toolProps: (id) => (id === "gitlab_update_merge_request" ? { project_id: {}, merge_request_iid: {}, labels: { type: "array" } } : {}) })
    expect(update[0]).toMatchObject({ provider: "gitlab-mcp", toolId: "gitlab_update_merge_request", input: { project_id: "mobile/shop", merge_request_iid: "<id>", labels: ["fixora", "crash"] } })
    expect(update[1]).toEqual({ provider: "github-mcp", command: "gh pr edit '<id>' --add-label fixora --add-label crash" })
    expect(renderLabelSteps({ order: ["glab", "gh"], target, labels: ["fixora"], services, toolProps: () => ({}) })).toEqual([])
    expect(attempts[1]!.command).toBe("glab mr create --source-branch fixora/x --target-branch main --title 'Draft: Guard nil' --description-file /run/mr.md --yes --remove-source-branch --draft --label fixora --reviewer bob")
    expect(attempts[2]!.url).toContain("/-/merge_requests/new?")
    expect(cliCreateCommand("gh", { ...target, remote: remoteGh }, mr, "/run/mr.md")).toBe("gh pr create --head fixora/x --base main --title 'Guard nil' --body-file /run/mr.md --draft --label fixora --reviewer bob")
    const view = renderMrOp({ provider: "glab", op: "view", target, id: "418", url: "https://gitlab.example.com/mobile/shop/-/merge_requests/418", services, toolProps: () => ({}) })
    expect(view?.command).toBe("glab mr view 418 --output json")
    const close = renderMrOp({ provider: "gitlab-mcp", op: "close", target, id: "418", url: "x", services: { gitlab: { ...services.gitlab!, capabilities: { ...services.gitlab!.capabilities, updateMr: "gitlab_update_merge_request" } } }, toolProps: () => ({}) })
    expect(close).toMatchObject({ toolId: "gitlab_update_merge_request", input: { project_id: "mobile/shop", merge_request_iid: 418, state_event: "close" } })
    expect(renderMrOp({ provider: "url", op: "view", target, url: "x", services, toolProps: () => ({}) })).toBeUndefined()
  })

  test("input mapping and result parsing", () => {
    const t = { remote: remoteGl, base: "main", branch: "fixora/x" }
    expect(gitlabCreateInput(t, { title: "Guard nil", body: "b", draft: true, labels: ["fixora"], reviewers: [] })).toMatchObject({ project_id: "mobile/shop", source_branch: "fixora/x", target_branch: "main", title: "Draft: Guard nil", draft: true, labels: "fixora" })
    expect(githubCreateInput({ ...t, remote: remoteGh }, { title: "Draft: Guard nil", body: "b", draft: true })).toMatchObject({ owner: "acme", repo: "shop", head: "fixora/x", base: "main", title: "Guard nil", draft: true })
    expect(urlFromResult(fixture("forge/gitlab.create_mr.json"))).toEqual({ url: "https://gitlab.example.com/mobile/shop/-/merge_requests/418", id: "418" })
    expect(urlFromResult(fixture("forge/github.create_pr.json"))).toEqual({ url: "https://github.com/acme/shop/pull/77", id: "77" })
    expect(urlFromResult("Created merge request !418: https://gitlab.example.com/mobile/shop/-/merge_requests/418\n")).toMatchObject({ url: "https://gitlab.example.com/mobile/shop/-/merge_requests/418" })
    expect(urlFromResult("https://github.com/acme/shop/pull/77\n")).toMatchObject({ id: "77" })
    expect(statusFromResult(fixture("forge/gitlab.create_mr.json"))).toBe("draft")
    expect(statusFromResult({ state: "merged" })).toBe("merged")
    expect(statusFromResult({ state: "closed" })).toBe("closed")
    expect(statusFromResult({ state: "open", merged_at: null, draft: false })).toBe("open")
    // A merged MR keeps its "Draft:" title and may still carry draft:true — merged must still win.
    expect(statusFromResult({ state: "merged", title: "Draft: fix crash", draft: true })).toBe("merged")
    expect(statusFromResult({ title: "Draft: fix crash", merged_at: "2026-11-18T00:00:00Z", draft: true })).toBe("merged")
    // GitHub CLI shape (gh pr view --json state,isDraft,mergedAt).
    expect(statusFromResult({ state: "MERGED", isDraft: true, mergedAt: "2026-11-18T00:00:00Z" })).toBe("merged")
  })
})
