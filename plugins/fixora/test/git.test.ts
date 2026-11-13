// Git helpers against a real temporary repository with a bare "origin": branch, commit, push,
// reuse, force-with-lease refusal, rename following and diff summaries. No network.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { git, runGit } from "../src/git.js"
import { buildIndex, mapFrames } from "../src/mapper.js"
import { scanAddedLines } from "../src/secrets.js"
import { summarizeChanges } from "../src/validate.js"

let root: string
let remote: string
let clone: string
let wt: string

async function sh(cwd: string, args: string[]) {
  const r = await runGit(cwd, args)
  return r.stdout.trim()
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fixora-git-"))
  remote = join(root, "remote.git")
  clone = join(root, "clone")
  await runGit(root, ["init", "--bare", "--initial-branch=main", remote])
  await runGit(root, ["clone", "--quiet", remote, clone])
  await runGit(clone, ["config", "user.email", "test@example.com"])
  await runGit(clone, ["config", "user.name", "Test"])
  await mkdir(join(clone, "src", "cart"), { recursive: true })
  await writeFile(join(clone, "src", "cart", "service.ts"), "export function applyCoupon(c: { id: string } | undefined) {\n  return c.id\n}\n")
  await writeFile(join(clone, "src", "cart", "service.test.ts"), "import { test } from 'bun:test'\ntest('x', () => {})\n")
  await writeFile(join(clone, "README.md"), "# shop\n")
  await runGit(clone, ["add", "."])
  await runGit(clone, ["commit", "--quiet", "-m", "init"])
  await runGit(clone, ["push", "--quiet", "-u", "origin", "main"])
})
afterAll(() => rm(root, { recursive: true, force: true }))

describe("git end to end", () => {
  test("repo facts and base ref", async () => {
    expect(await git.isRepo(clone)).toBe(true)
    expect(await git.isRepo(root)).toBe(false)
    expect(await git.remoteUrl(clone, "origin")).toBe(remote)
    await git.fetch(clone, "origin", "main")
    expect(await git.branchExists(clone, "main", "origin")).toBe(true)
    expect(await git.headSha(clone, "origin/main")).toHaveLength(40)
    expect(await git.lsTree(clone, "origin/main")).toEqual(["README.md", "src/cart/service.test.ts", "src/cart/service.ts"])
    const index = buildIndex(await git.lsTree(clone, "origin/main"), "x")
    expect(mapFrames([{ raw: "", file: "cart/service.ts", line: 2, inApp: true }], index, { language: "js" })[0]!.candidates[0]!.path).toBe("src/cart/service.ts")
  })

  test("worktree branch, change summary, commit with trailers, push, reuse", async () => {
    wt = join(root, "wt")
    await runGit(clone, ["worktree", "add", "--quiet", "--detach", wt, "origin/main"])
    await runGit(wt, ["config", "user.email", "test@example.com"])
    await runGit(wt, ["config", "user.name", "Test"])
    await git.checkoutNewBranch(wt, "fixora/sentry-1-guard", "origin/main")
    expect(await git.currentBranch(wt)).toBe("fixora/sentry-1-guard")
    expect(await git.isClean(wt)).toBe(true)

    await writeFile(join(wt, "src", "cart", "service.ts"), "export function applyCoupon(c: { id: string } | undefined) {\n  if (!c) return undefined\n  return c.id\n}\n")
    await writeFile(join(wt, "src", "cart", "new.test.ts"), "import { test } from 'bun:test'\ntest('guard', () => {})\n")
    const summary = await summarizeChanges(wt, "origin/main")
    expect(summary.paths.sort()).toEqual(["src/cart/new.test.ts", "src/cart/service.ts"])
    expect(summary.added).toBe(3)
    expect(summary.deleted).toBe(0)
    expect(summary.diff).toContain("+  if (!c) return undefined")
    expect(summary.diffHash).toHaveLength(16)
    expect(scanAddedLines(summary.diff)).toEqual([])

    const msgFile = join(root, "msg.txt")
    await writeFile(msgFile, "fix(cart): guard undefined coupon\n\nFixora-Run: sentry-1\n")
    await git.add(wt, summary.paths)
    const sha = await git.commit(wt, msgFile)
    expect(sha).toHaveLength(40)
    expect(await sh(wt, ["log", "-1", "--format=%B"])).toContain("Fixora-Run: sentry-1")
    expect(await git.isClean(wt)).toBe(true)

    await git.push(wt, "origin", "fixora/sentry-1-guard", { base: "main" })
    expect(await git.remoteBranchSha(clone, "origin", "fixora/sentry-1-guard")).toBe(sha)
    // Second push of the same commit is a no-op and must not fail.
    await git.push(wt, "origin", "fixora/sentry-1-guard", { base: "main" })
    // Pushing to the base branch is refused before git runs.
    await expect(git.push(wt, "origin", "main", { base: "main" })).rejects.toThrow("protected")
  })

  test("log, blame, commitExists, rename following, numstat", async () => {
    const log = await git.log(wt, { path: "src/cart/service.ts", n: 2, follow: true })
    expect(log).toContain("guard undefined coupon")
    const blame = await git.blame(wt, "src/cart/service.ts", 2)
    expect(blame).toContain("if (!c) return undefined")
    expect(await git.commitExists(wt, "deadbeef")).toBe(false)
    expect(await git.commitExists(wt, (await git.headSha(wt))!)).toBe(true)
    await runGit(wt, ["mv", "src/cart/service.ts", "src/cart/coupon.ts"])
    await runGit(wt, ["commit", "--quiet", "-m", "rename"])
    expect(await git.renamedTo(wt, "src/cart/service.ts", "HEAD")).toBe("src/cart/coupon.ts")
    expect(await git.fileExistsAt(wt, "HEAD", "src/cart/coupon.ts")).toBe(true)
    expect(await git.fileExistsAt(wt, "HEAD", "src/cart/service.ts")).toBe(false)
    const numstat = await git.numstat(wt, "origin/main")
    expect(numstat.some((n) => n.path.includes("coupon.ts"))).toBe(true)
  })

  test("statusPorcelain classifies changes; deleteRemoteBranch refuses protected names", async () => {
    await writeFile(join(wt, "untracked.txt"), "x")
    await writeFile(join(wt, "README.md"), "# changed\n")
    const status = await git.statusPorcelain(wt)
    expect(status.find((s) => s.path === "untracked.txt")?.status).toBe("untracked")
    expect(status.find((s) => s.path === "README.md")?.status).toBe("modified")
    await expect(git.deleteRemoteBranch(wt, "origin", "main", "main")).rejects.toThrow("protected")
    await git.deleteRemoteBranch(wt, "origin", "fixora/sentry-1-guard", "main")
    expect(await git.remoteBranchSha(clone, "origin", "fixora/sentry-1-guard")).toBeUndefined()
  })
})
