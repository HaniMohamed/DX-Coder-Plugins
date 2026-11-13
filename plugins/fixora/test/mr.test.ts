import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assertSafePush, branchName, compareUrl, isProtectedBranch, parseRemote, slug } from "../src/git.js"
import { githubCreateInput, gitlabCreateInput, pickMrProvider, serviceMatchesHost, statusFromResult, urlFromResult } from "../src/mr.js"
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

  test("provider order: MCP → CLI → URL, honouring the host", async () => {
    expect(await pickMrProvider(services, remoteGl, { cli: async () => true })).toBe("gitlab-mcp")
    expect(await pickMrProvider(services, remoteGh, { cli: async () => true })).toBe("github-mcp")
    const other = { ...services, gitlab: { ...services.gitlab!, environment: { GITLAB_API_URL: "https://gitlab.other.com/api/v4" } } }
    expect(await pickMrProvider(other, remoteGl, { cli: async (b) => b === "glab" })).toBe("glab")
    expect(await pickMrProvider(other, remoteGl, { cli: async () => false })).toBe("url")
    expect(await pickMrProvider({}, remoteGh, { cli: async (b) => b === "gh" })).toBe("gh")
    expect(await pickMrProvider({}, parseRemote("ssh://git@git.corp.io/team/app")!, { cli: async () => true })).toBe("url")
    expect(await pickMrProvider({ gitlab: services.gitlab }, parseRemote("ssh://git@git.corp.io/team/app")!, { forge: "gitlab", cli: async () => false })).toBe("url")
    expect(serviceMatchesHost(services.gitlab, "gitlab.example.com")).toBe(true)
    expect(serviceMatchesHost(services.github, "github.com")).toBe(true)
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
  })
})
