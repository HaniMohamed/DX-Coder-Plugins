// Shared types for the per-issue files plus a hand-written validator for subtasks.json.
// Validation is deliberately dependency-free so error messages can be fed back to the
// worker verbatim and the module can be unit-tested without the DXcoder host.

export type Confidence = "high" | "medium" | "low"
export type MatchVerdict = "same" | "partial" | "superseded"

export interface MatchedExisting {
  key: string
  summary: string
  existingPoints: number | null
  verdict: MatchVerdict
}

export interface Subtask {
  id: string
  title: string
  description: string
  storyPoints: number
  dependsOn: string[]
  parallel: boolean
  assumptions: string[]
  confidence: Confidence
  files?: string[]
  matchedExisting: MatchedExisting | null
}

export interface SubtasksFile {
  version: 1
  issue: string
  generatedAt: string
  summary: string
  subtasks: Subtask[]
  notes?: string[]
}

/** Snapshot of a subtask that already exists in Jira (written to existing-subtasks.json). */
export interface ExistingSubtask {
  key: string
  summary: string
  status: string
  storyPoints: number | null
  description?: string
  assignee?: string | null
}

export type ValidationResult = { ok: true; value: SubtasksFile } | { ok: false; errors: string[] }

export interface ValidationContext {
  issue: string
  existingKeys: string[]
}

export const ID_PATTERN = /^S\d+$/
export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]+-\d+$/i
const CONFIDENCE: Confidence[] = ["high", "medium", "low"]
const VERDICT: MatchVerdict[] = ["same", "partial", "superseded"]

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string")

export function parseSubtasksJson(text: string, ctx: ValidationContext): ValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, errors: [`subtasks.json is not valid JSON: ${(error as Error).message}`] }
  }
  return validateSubtasksFile(parsed, ctx)
}

export function validateSubtasksFile(input: unknown, ctx: ValidationContext): ValidationResult {
  const errors: string[] = []
  if (!isRecord(input)) return { ok: false, errors: ["root must be an object"] }

  if (input.version !== 1) errors.push(`version must be 1 (got ${JSON.stringify(input.version)})`)
  if (typeof input.issue !== "string" || input.issue.toUpperCase() !== ctx.issue.toUpperCase())
    errors.push(`issue must be "${ctx.issue}" (got ${JSON.stringify(input.issue)})`)
  if (typeof input.generatedAt !== "string" || Number.isNaN(Date.parse(input.generatedAt)))
    errors.push("generatedAt must be an ISO-8601 timestamp string")
  if (typeof input.summary !== "string" || input.summary.trim().length < 10)
    errors.push("summary must be a string of at least 10 characters")
  if (input.notes !== undefined && !isStringArray(input.notes)) errors.push("notes must be an array of strings")
  if (!Array.isArray(input.subtasks) || input.subtasks.length === 0) {
    errors.push("subtasks must be a non-empty array")
    return { ok: false, errors }
  }

  const ids = new Set<string>()
  const matchedKeys = new Map<string, string>()
  const existing = new Set(ctx.existingKeys.map((k) => k.toUpperCase()))
  const subtasks: Subtask[] = []

  input.subtasks.forEach((raw, index) => {
    const at = `subtasks[${index}]`
    if (!isRecord(raw)) {
      errors.push(`${at} must be an object`)
      return
    }
    const id = raw.id
    if (typeof id !== "string" || !ID_PATTERN.test(id)) errors.push(`${at}.id must match ^S\\d+$ (got ${JSON.stringify(id)})`)
    else if (ids.has(id)) errors.push(`${at}.id "${id}" is duplicated`)
    else ids.add(id)

    if (typeof raw.title !== "string" || raw.title.trim().length < 5 || raw.title.length > 200)
      errors.push(`${at}.title must be a string of 5..200 characters`)
    if (typeof raw.description !== "string" || raw.description.trim().length === 0)
      errors.push(`${at}.description must be a non-empty string`)
    if (typeof raw.storyPoints !== "number" || !Number.isInteger(raw.storyPoints) || raw.storyPoints < 1)
      errors.push(`${at}.storyPoints must be an integer >= 1 (got ${JSON.stringify(raw.storyPoints)})`)
    if (!isStringArray(raw.dependsOn)) errors.push(`${at}.dependsOn must be an array of subtask ids (use [] for none)`)
    if (typeof raw.parallel !== "boolean") errors.push(`${at}.parallel must be a boolean`)
    if (!isStringArray(raw.assumptions)) errors.push(`${at}.assumptions must be an array of strings (use [] for none)`)
    if (!CONFIDENCE.includes(raw.confidence as Confidence))
      errors.push(`${at}.confidence must be one of ${CONFIDENCE.join(", ")}`)
    if (raw.files !== undefined && !isStringArray(raw.files)) errors.push(`${at}.files must be an array of strings`)

    if (raw.matchedExisting === undefined) errors.push(`${at}.matchedExisting is required (use null when nothing matches)`)
    else if (raw.matchedExisting !== null) {
      const m = raw.matchedExisting
      if (!isRecord(m)) errors.push(`${at}.matchedExisting must be null or an object`)
      else {
        if (typeof m.key !== "string" || !existing.has(m.key.toUpperCase()))
          errors.push(
            `${at}.matchedExisting.key must be one of the existing subtask keys [${ctx.existingKeys.join(", ")}] (got ${JSON.stringify(m.key)})`,
          )
        else if (matchedKeys.has(m.key.toUpperCase()))
          errors.push(`${at}.matchedExisting.key "${m.key}" is already matched by ${matchedKeys.get(m.key.toUpperCase())}`)
        else matchedKeys.set(m.key.toUpperCase(), typeof id === "string" ? id : at)
        if (typeof m.summary !== "string") errors.push(`${at}.matchedExisting.summary must be a string`)
        if (!(m.existingPoints === null || typeof m.existingPoints === "number"))
          errors.push(`${at}.matchedExisting.existingPoints must be a number or null`)
        if (!VERDICT.includes(m.verdict as MatchVerdict))
          errors.push(`${at}.matchedExisting.verdict must be one of ${VERDICT.join(", ")}`)
      }
    }
    subtasks.push(raw as unknown as Subtask)
  })

  // Dependency references and cycle detection run only when ids are sane.
  if (errors.length === 0) {
    for (const s of subtasks) {
      for (const dep of s.dependsOn) {
        if (!ids.has(dep)) errors.push(`${s.id}.dependsOn references unknown id "${dep}"`)
        if (dep === s.id) errors.push(`${s.id}.dependsOn references itself`)
      }
    }
    const cycle = findCycle(subtasks)
    if (cycle) errors.push(`dependsOn contains a cycle: ${cycle.join(" -> ")}`)
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      version: 1,
      issue: ctx.issue,
      generatedAt: input.generatedAt as string,
      summary: input.summary as string,
      subtasks: subtasks.map((s) => ({ ...s, matchedExisting: s.matchedExisting ?? null })),
      ...(input.notes ? { notes: input.notes as string[] } : {}),
    },
  }
}

function findCycle(subtasks: Subtask[]): string[] | undefined {
  const graph = new Map(subtasks.map((s) => [s.id, s.dependsOn]))
  const state = new Map<string, "visiting" | "done">()
  const stack: string[] = []
  const visit = (id: string): string[] | undefined => {
    const current = state.get(id)
    if (current === "done") return undefined
    if (current === "visiting") return [...stack.slice(stack.indexOf(id)), id]
    state.set(id, "visiting")
    stack.push(id)
    for (const dep of graph.get(id) ?? []) {
      if (!graph.has(dep)) continue
      const found = visit(dep)
      if (found) return found
    }
    stack.pop()
    state.set(id, "done")
    return undefined
  }
  for (const s of subtasks) {
    const found = visit(s.id)
    if (found) return found
  }
  return undefined
}

/** Subtasks ordered so every dependency comes before its dependents (stable for ties). */
export function topologicalOrder(subtasks: Subtask[]): Subtask[] {
  const byId = new Map(subtasks.map((s) => [s.id, s]))
  const done = new Set<string>()
  const out: Subtask[] = []
  const visit = (s: Subtask) => {
    if (done.has(s.id)) return
    done.add(s.id)
    for (const dep of s.dependsOn) {
      const d = byId.get(dep)
      if (d) visit(d)
    }
    out.push(s)
  }
  subtasks.forEach(visit)
  return out
}

export const totalPoints = (subtasks: Pick<Subtask, "storyPoints">[]) =>
  subtasks.reduce((sum, s) => sum + s.storyPoints, 0)
