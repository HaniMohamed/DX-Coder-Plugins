// Keeps the skills and the validators in sync: every SKILL.md parses, is not auto-invoked, and its
// JSON example passes the plugin's validator.

import { describe, expect, test } from "bun:test"
import matter from "gray-matter"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CATEGORIES, CLASSIFICATIONS, FINDING_CATEGORIES, OPS, validateFix, validateOps, validatePrepare, validatePublish, validateReview, validateTriage } from "../src/contracts.js"
import { FORBIDDEN_GLOBS } from "../src/permissions.js"

const read = (id: string) => matter(readFileSync(join(import.meta.dir, "..", "skills", id, "SKILL.md"), "utf8"))
const example = (content: string) => JSON.parse(/```json\n([\s\S]*?)```/.exec(content)![1]!) as Record<string, unknown>

describe("skills", () => {
  test("frontmatter", () => {
    for (const id of ["fixora-crashes", "fixora-prepare", "fixora-triage", "fixora-fix", "fixora-review", "fixora-publish", "fixora-ops"]) {
      const md = read(id)
      expect(md.data.name).toBe(id)
      expect(md.data["disable-model-invocation"]).toBe(true)
      expect(String(md.data.description)).toContain("/fixora")
    }
  })

  test("triage example validates and mentions every classification and category", () => {
    const md = read("fixora-triage")
    const r = validateTriage(example(md.content), { runId: "sentry-4523123", fileExists: () => true })
    expect(r.ok).toBe(true)
    for (const c of CLASSIFICATIONS) expect(md.content).toContain(`\`${c}\``)
    for (const c of CATEGORIES) expect(md.content).toContain(c)
    expect(md.content).toContain("fixora_submit_triage")
  })

  test("fix example validates and lists the forbidden categories", () => {
    const md = read("fixora-fix")
    const ex = example(md.content)
    const r = validateFix(ex, { runId: "sentry-4523123", attempt: 1, changedFiles: ex.filesChanged as string[], forbidden: () => undefined, maxFilesChanged: 10, hasTestRunner: true, requireTestChange: true, isTestFile: (p) => /\.test\./.test(p), testFirst: false, requiredChecks: ["bun test src/cart", "bun run typecheck"] })
    expect(r.ok).toBe(true)
    expect(typeof ex.status).toBe("string")
    expect(typeof ex.diff).toBe("string")
    for (const word of ["lockfiles", "generated", "CI", ".dxcoder", "git commit", "curl", "git add -N", "git diff HEAD"]) expect(md.content).toContain(word)
    expect(md.content).toContain("fixora_submit_fix")
    expect(FORBIDDEN_GLOBS.length).toBeGreaterThan(20)
  })

  test("prepare example validates; the skill names every ecosystem and the stash rule", () => {
    const md = read("fixora-prepare")
    const r = validatePrepare(example(md.content), { runId: "sentry-4523123", branchPrefix: "fixora/", baseBranch: "main" })
    if (!r.ok) throw new Error(r.errors.join("; "))
    expect(r.value.stage).toBe("ready")
    expect(r.value.stashRef).toBeDefined()
    for (const id of ["flutter", "node", "gradle", "python", "go", "dotnet", "rust", "spm"]) expect(md.content).toContain(`\`${id}\``)
    expect(md.content).toContain("git stash push -u -m")
    expect(md.content).toContain("fixora_submit_prepare")
  })

  test("publish example validates and forbids the dangerous git flags", () => {
    const md = read("fixora-publish")
    const r = validatePublish(example(md.content), { runId: "sentry-4523123", grants: { commit: true, push: true, mr: true }, branch: "fixora/sentry-4523123-guard-coupon", remote: "origin" })
    if (!r.ok) throw new Error(r.errors.join("; "))
    expect(r.value.mr?.provider).toBe("gitlab-mcp")
    for (const word of ["--no-verify", "--amend", "--force", "git add -A", "fixora_submit_publish"]) expect(md.content).toContain(word)
  })

  test("ops example validates and every op is described", () => {
    const md = read("fixora-ops")
    const r = validateOps(example(md.content), { runId: "sentry-4523123" })
    if (!r.ok) throw new Error(r.errors.join("; "))
    expect(r.value.op).toBe("restore")
    for (const op of OPS) expect(md.content).toContain(`**${op}**`)
  })

  test("crashes skill describes both submit tools", () => {
    const md = read("fixora-crashes")
    expect(md.content).toContain("fixora_submit_crashes")
    expect(md.content).toContain("fixora_submit_crash")
    expect(md.content).toContain("verbatim")
  })

  test("review example validates and lists every finding category", () => {
    const md = read("fixora-review")
    const r = validateReview(example(md.content), { runId: "sentry-4523123", attempt: 1, knownFiles: ["src/cart/service.ts", "src/cart/service.test.ts"] })
    expect(r.ok).toBe(true)
    for (const c of FINDING_CATEGORIES) expect(md.content).toContain(`**${c}**`)
    expect(md.content).toContain("fixora_submit_review")
  })
})
