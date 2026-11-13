// Keeps the skills and the validators in sync: every SKILL.md parses, is not auto-invoked, and its
// JSON example passes the plugin's validator.

import { describe, expect, test } from "bun:test"
import matter from "gray-matter"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CATEGORIES, CLASSIFICATIONS, FINDING_CATEGORIES, validateFix, validateReview, validateTriage } from "../src/contracts.js"
import { FORBIDDEN_GLOBS } from "../src/permissions.js"

const read = (id: string) => matter(readFileSync(join(import.meta.dir, "..", "skills", id, "SKILL.md"), "utf8"))
const example = (content: string) => JSON.parse(/```json\n([\s\S]*?)```/.exec(content)![1]!) as Record<string, unknown>

describe("skills", () => {
  test("frontmatter", () => {
    for (const id of ["fixora-triage", "fixora-fix", "fixora-review"]) {
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
    const r = validateFix(ex, { runId: "sentry-4523123", attempt: 1, changedFiles: ex.filesChanged as string[], forbidden: () => undefined, maxFilesChanged: 10, hasTestRunner: true, requireTestChange: true, isTestFile: (p) => /\.test\./.test(p), testFirst: false })
    expect(r.ok).toBe(true)
    for (const word of ["lockfiles", "generated", "CI", ".dxcoder", "git commit", "curl"]) expect(md.content).toContain(word)
    expect(md.content).toContain("fixora_submit_fix")
    expect(FORBIDDEN_GLOBS.length).toBeGreaterThan(20)
  })

  test("review example validates and lists every finding category", () => {
    const md = read("fixora-review")
    const r = validateReview(example(md.content), { runId: "sentry-4523123", attempt: 1, knownFiles: ["src/cart/service.ts", "src/cart/service.test.ts"] })
    expect(r.ok).toBe(true)
    for (const c of FINDING_CATEGORIES) expect(md.content).toContain(`**${c}**`)
    expect(md.content).toContain("fixora_submit_review")
  })
})
