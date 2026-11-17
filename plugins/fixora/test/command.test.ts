import { describe, expect, test } from "bun:test"
import { parseCommand, SUBCOMMANDS, tokenize, USAGE } from "../src/command.js"

const ok = (text: string) => {
  const r = parseCommand(text)
  if ("error" in r) throw new Error(r.error)
  return r
}
const err = (text: string) => {
  const r = parseCommand(text)
  if (!("error" in r)) throw new Error(`expected an error for "${text}"`)
  return r.error
}

describe("tokenize", () => {
  test("quotes, --key value and --key=value", () => {
    const t = tokenize('feedback sentry-1 "also guard the Google Pay path" --from fix --tests=full --dry-run')
    expect(t.positional).toEqual(["feedback", "sentry-1", "also guard the Google Pay path"])
    expect(t.flags.get("from")).toBe("fix")
    expect(t.flags.get("tests")).toBe("full")
    expect(t.flags.get("dry-run")).toBe(true)
  })
})

describe("subcommands", () => {
  test("every verb has a /fixora:<verb> command and the usage lists it", () => {
    const names = SUBCOMMANDS.map((c) => c.name)
    expect(names).toContain("fixora:status")
    expect(names).toContain("fixora:fix")
    expect(new Set(names).size).toBe(names.length)
    for (const c of SUBCOMMANDS) {
      expect(c.name).toBe(`fixora:${c.verb}`)
      if (c.verb !== "list") expect(USAGE).toContain(`/${c.name}`)
    }
    expect(USAGE).toContain("/fixora:retry <runId> [--from <step>] [--fresh]")
    expect(USAGE).toContain("the long form `/fixora <verb> …` works too")
    // The subcommand prefixes its verb to the user's text; the parser sees the long form.
    expect(parseCommand("status manual-7fcb3db2d5")).toEqual({ verb: "status", runId: "manual-7fcb3db2d5" })
    expect(parseCommand("list ")).toMatchObject({ verb: "list" })
    expect(parseCommand("help ")).toEqual({ verb: "help" })
  })
})

describe("parseCommand", () => {
  test("empty → list, shortcuts → fix", () => {
    expect(ok("").verb).toBe("list")
    expect(ok("   ").verb).toBe("list")
    expect(ok("sentry:12345")).toMatchObject({ verb: "fix", ref: "sentry:12345" })
    expect(ok("https://acme.sentry.io/issues/12345/")).toMatchObject({ verb: "fix", ref: "https://acme.sentry.io/issues/12345/" })
  })

  test("fix with flags", () => {
    const r = ok("fix crashlytics:abc --dry-run --no-ticket --no-mr --auto --force --test-first --base develop --model openai/gpt-5 --tests mapped")
    expect(r).toMatchObject({ verb: "fix", ref: "crashlytics:abc" })
    if (r.verb !== "fix") throw new Error()
    expect(r.flags).toMatchObject({ dryRun: true, ticket: false, mr: false, push: true, auto: true, force: true, testFirst: true, base: "develop", model: "openai/gpt-5", tests: "mapped" })
    expect(err("fix")).toContain("fix needs a crash reference")
    expect(err("fix sentry:1 --model gpt5")).toContain("--model must be")
  })

  test("paste, top, batch", () => {
    expect(ok('paste ./trace.txt --title "NPE in cart" --platform android')).toMatchObject({ verb: "paste", file: "./trace.txt", title: "NPE in cart", platform: "android" })
    expect(err("paste")).toContain("paste needs a file")
    expect(ok("top")).toMatchObject({ verb: "top", count: 1 })
    expect(ok("top 3")).toMatchObject({ verb: "top", count: 3 })
    expect(err("top 50")).toContain("between 1 and 20")
    expect(ok("batch --top 5 --min-users 10 --source sentry --minutes 30")).toMatchObject({ verb: "batch", top: 5, minUsers: 10, source: "sentry", minutes: 30 })
    expect(err("batch --source jira")).toContain("--source must be")
    expect(ok("list --platform ios")).toMatchObject({ verb: "list", platform: "ios" })
    expect(ok("list --platform=Android")).toMatchObject({ verb: "list", platform: "android" })
    expect(ok("list")).toEqual(expect.not.objectContaining({ platform: expect.anything() }))
    expect(ok("top 2 --platform ios")).toMatchObject({ verb: "top", count: 2, platform: "ios" })
    expect(ok("batch --top 3 --platform web")).toMatchObject({ verb: "batch", top: 3, platform: "web" })
    expect(err("list --platform windows")).toContain("--platform must be android, ios, web")
    expect(err("list --platform")).toContain("--platform must be")
  })

  test("status, retry, feedback, restart, fixed, report, clean, sync, help", () => {
    expect(ok("status")).toEqual({ verb: "status", runId: undefined })
    expect(ok("status sentry-123")).toEqual({ verb: "status", runId: "sentry-123" })
    expect(err("status nope")).toContain("not a run id")
    expect(ok("retry sentry-123 --from validate --fresh")).toMatchObject({ verb: "retry", runId: "sentry-123", from: "validate", fresh: true })
    expect(err("retry sentry-123 --from nowhere")).toContain("--from must be one of")
    expect(ok('feedback manual-abc123 "use the existing CartError enum"')).toEqual({ verb: "feedback", runId: "manual-abc123", message: "use the existing CartError enum" })
    expect(ok("feedback manual-abc123 use the enum please")).toMatchObject({ message: "use the enum please" })
    expect(err("feedback manual-abc123")).toContain("needs a message")
    expect(ok("restart crashlytics-x1")).toMatchObject({ verb: "restart", runId: "crashlytics-x1" })
    expect(ok("fixed sentry-1 --release 3.2.1 --platform ios")).toEqual({ verb: "fixed", runId: "sentry-1", release: "3.2.1", platform: "ios" })
    expect(err("fixed sentry-1")).toContain("--release")
    expect(ok("report --days 7")).toEqual({ verb: "report", days: 7 })
    expect(ok("report")).toEqual({ verb: "report", days: 30 })
    expect(ok("clean sentry-1 --remote")).toEqual({ verb: "clean", runId: "sentry-1", remote: true })
    expect(ok("sync")).toEqual({ verb: "sync" })
    expect(ok("reset")).toEqual({ verb: "reset", files: false })
    expect(ok("reset --files")).toEqual({ verb: "reset", files: true })
    expect(ok("help")).toEqual({ verb: "help" })
    expect(err("frobnicate")).toContain("unknown verb")
  })
})
