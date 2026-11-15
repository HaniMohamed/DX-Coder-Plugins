// `/fixora ...` command grammar. Pure and unit-tested; refs are resolved later by sources/index.ts.

import { STEPS, type Step } from "./types.js"

export const COMMAND = "fixora"

export interface Flags {
  dryRun: boolean
  ticket: boolean
  mr: boolean
  push: boolean
  auto: boolean
  force: boolean
  forceTriage: boolean
  testFirst?: boolean
  base?: string
  model?: string
  tests?: "full" | "mapped" | "skip"
}

export type Parsed =
  | { verb: "list"; flags: Flags }
  | { verb: "fix"; ref: string; flags: Flags }
  | { verb: "paste"; file: string; title?: string; platform?: string; language?: string; flags: Flags }
  | { verb: "top"; count: number; flags: Flags }
  | { verb: "batch"; top?: number; minUsers?: number; source?: string; minutes?: number; flags: Flags }
  | { verb: "status"; runId?: string }
  | { verb: "retry"; runId: string; from?: Step; fresh: boolean; flags: Flags }
  | { verb: "feedback"; runId: string; message: string }
  | { verb: "restart"; runId: string; flags: Flags }
  | { verb: "fixed"; runId: string; release: string; platform?: string }
  | { verb: "report"; days: number }
  | { verb: "clean"; runId: string; remote: boolean }
  | { verb: "sync" }
  | { verb: "reset"; files: boolean }
  | { verb: "doctor"; all: boolean; probe: boolean; tool?: string }
  | { verb: "help" }

export type ParseResult = Parsed | { error: string }

export const RUN_ID_PATTERN = /^(sentry|crashlytics|manual)-[A-Za-z0-9._-]{1,64}$/

export type Verb = Parsed["verb"]

export interface Subcommand {
  verb: Verb
  /** The host command name (`/fixora:status`). */
  name: string
  /** Arguments as shown in the usage text. */
  args: string
  description: string
}

/**
 * Every verb is also its own host command (`/fixora:status …`) so the command palette lists them
 * next to `/fixora`; `/fixora status …` keeps working as the long form.
 */
export const SUBCOMMANDS: Subcommand[] = [
  { verb: "list", name: `${COMMAND}:list`, args: "", description: "list the top crashes from every detected source" },
  { verb: "fix", name: `${COMMAND}:fix`, args: "<source>:<id> | <crash url>", description: "fix one crash (e.g. sentry:12345, crashlytics:abc, or a Sentry / Firebase console URL)" },
  { verb: "paste", name: `${COMMAND}:paste`, args: '<file> [--title ".."] [--platform ..] [--language ..]', description: "fix a pasted stack trace saved in a file" },
  { verb: "top", name: `${COMMAND}:top`, args: "[N]", description: "fix the top N new crashes (default 1)" },
  { verb: "batch", name: `${COMMAND}:batch`, args: "[--top N] [--min-users N] [--source s] [--minutes M]", description: "batch mode with a time budget" },
  { verb: "status", name: `${COMMAND}:status`, args: "[<runId>]", description: "runs table or one run's detail" },
  { verb: "retry", name: `${COMMAND}:retry`, args: "<runId> [--from <step>] [--fresh]", description: "resume a stopped run; --fresh forgets the worker sessions and redoes prepare" },
  { verb: "feedback", name: `${COMMAND}:feedback`, args: '<runId> "<message>"', description: "ask for a change or a question on the fix (same branch, MR updated)" },
  { verb: "restart", name: `${COMMAND}:restart`, args: "<runId>", description: "close the MR and start a fresh fix cycle" },
  { verb: "fixed", name: `${COMMAND}:fixed`, args: "<runId> --release <X> [--platform android|ios|web]", description: "record the release that ships the fix (reopen tracking)" },
  { verb: "report", name: `${COMMAND}:report`, args: "[--days 30]", description: "funnel, timings, MR status, reopen rate" },
  { verb: "clean", name: `${COMMAND}:clean`, args: "<runId> [--remote]", description: "restore the checkout, delete the local branch (and, after approval, the remote branch)" },
  { verb: "sync", name: `${COMMAND}:sync`, args: "", description: "refresh MR statuses" },
  { verb: "reset", name: `${COMMAND}:reset`, args: "[--files]", description: "forget every run, crash and cache record (after approval); --files also deletes <repo>/.dxcoder/fixora" },
  { verb: "doctor", name: `${COMMAND}:doctor`, args: "[--all] [--probe] [--tool <id>]", description: "MCP servers / tools Fixora detects; --probe calls the crash source; --tool prints a tool's input schema" },
  { verb: "help", name: `${COMMAND}:help`, args: "", description: "show this usage" },
]

const pad = (s: string, n: number) => (s.length >= n ? `${s}  ` : s.padEnd(n))

export const USAGE = [
  "Usage:",
  pad(`  /${COMMAND}`, 54) + "list the top crashes from every detected source",
  ...SUBCOMMANDS.filter((c) => c.verb !== "list").map((c) => pad(`  /${c.name} ${c.args}`.trimEnd(), 54) + c.description),
  `(the long form \`/${COMMAND} <verb> …\` works too)`,
  "Flags: --dry-run --no-ticket --no-mr --no-push --auto --force --test-first --base <branch>",
  "       --model <providerID/modelID> --tests full|mapped|skip",
].join("\n")

interface Tokens {
  positional: string[]
  flags: Map<string, string | true>
}

const VALUE_FLAGS = new Set(["from", "base", "model", "tests", "title", "platform", "language", "top", "min-users", "source", "minutes", "release", "days"])

/** Splits on whitespace, honouring double-quoted strings, `--key value` and `--key=value`. */
export function tokenize(text: string): Tokens {
  const words: string[] = []
  let current = ""
  let quoted = false
  let had = false
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted
      had = true
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (current || had) words.push(current)
      current = ""
      had = false
      continue
    }
    current += ch
  }
  if (current || had) words.push(current)

  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (!w.startsWith("--")) {
      positional.push(w)
      continue
    }
    const eq = w.indexOf("=")
    if (eq > 0) {
      flags.set(w.slice(2, eq).toLowerCase(), w.slice(eq + 1))
      continue
    }
    const key = w.slice(2).toLowerCase()
    const next = words[i + 1]
    if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
      flags.set(key, next)
      i++
    } else flags.set(key, true)
  }
  return { positional, flags }
}

function readFlags(t: Tokens): { flags: Flags; errors: string[] } {
  const errors: string[] = []
  const s = (k: string) => {
    const v = t.flags.get(k)
    return typeof v === "string" ? v : undefined
  }
  const tests = s("tests")
  if (tests && !["full", "mapped", "skip"].includes(tests)) errors.push("--tests must be full, mapped or skip")
  const model = s("model")
  if (model && !/^[^/\s]+\/[^\s]+$/.test(model)) errors.push("--model must be <providerID>/<modelID>")
  return {
    flags: {
      dryRun: t.flags.has("dry-run"),
      ticket: !t.flags.has("no-ticket"),
      mr: !t.flags.has("no-mr"),
      push: !t.flags.has("no-push"),
      auto: t.flags.has("auto"),
      force: t.flags.has("force"),
      forceTriage: t.flags.has("force-triage"),
      testFirst: t.flags.has("test-first") ? true : undefined,
      base: s("base"),
      model,
      tests: tests as Flags["tests"],
    },
    errors,
  }
}

const runIdAt = (t: Tokens, i: number): string | undefined => {
  const v = t.positional[i]
  return v && RUN_ID_PATTERN.test(v) ? v : undefined
}
const int = (v: string | true | undefined, name: string, errors: string[], o: { min: number }): number | undefined => {
  if (v === undefined || v === true) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < o.min) {
    errors.push(`--${name} must be an integer >= ${o.min}`)
    return undefined
  }
  return n
}

export function parseCommand(text: string): ParseResult {
  const t = tokenize(text)
  const verb = (t.positional[0] ?? "").toLowerCase()
  const { flags, errors } = readFlags(t)
  const fail = (msg: string): ParseResult => ({ error: `${msg}\n\n${USAGE}` })
  if (errors.length > 0) return fail(errors.join("; "))

  if (t.positional.length === 0) return { verb: "list", flags }
  switch (verb) {
    case "help":
    case "--help":
      return { verb: "help" }
    case "list":
      return { verb: "list", flags }
    case "fix": {
      const ref = t.positional[1]
      if (!ref) return fail("fix needs a crash reference (source:id or a crash URL)")
      return { verb: "fix", ref, flags }
    }
    case "paste": {
      const file = t.positional[1]
      if (!file) return fail("paste needs a file path containing the stack trace")
      const str = (k: string) => (typeof t.flags.get(k) === "string" ? (t.flags.get(k) as string) : undefined)
      return { verb: "paste", file, title: str("title"), platform: str("platform"), language: str("language"), flags }
    }
    case "top": {
      const raw = t.positional[1]
      const count = raw === undefined ? 1 : Number(raw)
      if (!Number.isInteger(count) || count < 1 || count > 20) return fail("top takes an integer between 1 and 20")
      return { verb: "top", count, flags }
    }
    case "batch": {
      const errs: string[] = []
      const top = int(t.flags.get("top"), "top", errs, { min: 1 })
      const minUsers = int(t.flags.get("min-users"), "min-users", errs, { min: 0 })
      const minutes = int(t.flags.get("minutes"), "minutes", errs, { min: 1 })
      const source = typeof t.flags.get("source") === "string" ? (t.flags.get("source") as string) : undefined
      if (source && source !== "sentry" && source !== "crashlytics") errs.push("--source must be sentry or crashlytics")
      if (errs.length > 0) return fail(errs.join("; "))
      return { verb: "batch", top, minUsers, source, minutes, flags }
    }
    case "status": {
      const raw = t.positional[1]
      if (raw && !RUN_ID_PATTERN.test(raw)) return fail(`"${raw}" is not a run id (expected e.g. sentry-12345)`)
      return { verb: "status", runId: raw }
    }
    case "retry": {
      const runId = runIdAt(t, 1)
      if (!runId) return fail("retry needs a run id (see /fixora status)")
      const fromRaw = t.flags.get("from")
      let from: Step | undefined
      if (typeof fromRaw === "string") {
        if (!(STEPS as readonly string[]).includes(fromRaw)) return fail(`--from must be one of ${STEPS.join(", ")}`)
        from = fromRaw as Step
      }
      return { verb: "retry", runId, from, fresh: t.flags.has("fresh"), flags }
    }
    case "feedback": {
      const runId = runIdAt(t, 1)
      if (!runId) return fail("feedback needs a run id and a message")
      const message = t.positional.slice(2).join(" ").trim()
      if (!message) return fail('feedback needs a message, e.g. /fixora feedback sentry-123 "also guard the Google Pay path"')
      return { verb: "feedback", runId, message }
    }
    case "restart": {
      const runId = runIdAt(t, 1)
      if (!runId) return fail("restart needs a run id")
      return { verb: "restart", runId, flags }
    }
    case "fixed": {
      const runId = runIdAt(t, 1)
      if (!runId) return fail("fixed needs a run id")
      const release = t.flags.get("release")
      if (typeof release !== "string") return fail("fixed needs --release <version>")
      const platform = t.flags.get("platform")
      if (platform !== undefined && !["android", "ios", "web"].includes(String(platform))) return fail("--platform must be android, ios or web")
      return { verb: "fixed", runId, release, platform: typeof platform === "string" ? platform : undefined }
    }
    case "report": {
      const errs: string[] = []
      const days = int(t.flags.get("days"), "days", errs, { min: 1 }) ?? 30
      if (errs.length > 0) return fail(errs.join("; "))
      return { verb: "report", days }
    }
    case "clean": {
      const runId = runIdAt(t, 1)
      if (!runId) return fail("clean needs a run id")
      return { verb: "clean", runId, remote: t.flags.has("remote") }
    }
    case "sync":
      return { verb: "sync" }
    case "reset":
      return { verb: "reset", files: t.flags.has("files") }
    case "doctor":
      return { verb: "doctor", all: t.flags.has("all"), probe: t.flags.has("probe"), tool: typeof t.flags.get("tool") === "string" ? (t.flags.get("tool") as string) : undefined }
    default:
      // `/fixora sentry:123` and `/fixora https://...` are shortcuts for `fix`.
      if (/^[a-z]+:\S+$/i.test(t.positional[0]!) || /^https?:\/\//i.test(t.positional[0]!)) return { verb: "fix", ref: t.positional[0]!, flags }
      return fail(`unknown verb "${t.positional[0]}"`)
  }
}
