import { describe, expect, test } from "bun:test"
import { addedLines, mask, maskSecrets, scanAddedLines } from "../src/secrets.js"

const diff = (lines: string[]) => ["diff --git a/src/x.ts b/src/x.ts", "--- a/src/x.ts", "+++ b/src/x.ts", "@@ -10,3 +10,5 @@", " context", ...lines, " more"].join("\n")

describe("addedLines", () => {
  test("tracks new-file line numbers across hunks", () => {
    const d = diff(["+a", "-removed", "+b"]) + "\n@@ -40,1 +42,2 @@\n+c"
    expect(addedLines(d)).toEqual([
      { file: "src/x.ts", line: 11, text: "a" },
      { file: "src/x.ts", line: 12, text: "b" },
      { file: "src/x.ts", line: 42, text: "c" },
    ])
  })
})

describe("scanAddedLines", () => {
  test("finds each pattern on added lines only", () => {
    const samples = [
      "+const k = 'AKIAIOSFODNN7EXAMPLE'",
      "+token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "+glpat-abcdefghij1234567890",
      "+xoxb-123456789-abcdefghij",
      "+key: AIzaSyA1234567890abcdefghijklmnopqrstuv",
      "+sk_live_abcdefghijklmnop1234",
      "+-----BEGIN RSA PRIVATE KEY-----",
      "+https://0123456789abcdef0123456789abcdef@o1.ingest.sentry.io/1",
      "+password = \"supersecretvalue123456\"",
      "-AKIAIOSFODNN7EXAMPLE removed line is ignored",
    ]
    const findings = scanAddedLines(diff(samples))
    expect(findings.map((f) => f.pattern)).toEqual(["AWS access key", "GitHub token", "GitLab token", "Slack token", "Google API key", "Stripe key", "private key", "Sentry DSN", "generic credential assignment"])
    expect(findings[0]!.masked).toBe("AKIA************EXAMPLE".slice(0, 4) + "*".repeat(12) + "MPLE")
    expect(findings.every((f) => f.file === "src/x.ts")).toBe(true)
  })

  test("allowlist and clean diffs", () => {
    expect(scanAddedLines(diff(["+const x = 1", "+const apiKeyName = 'API_KEY'"]))).toEqual([])
    expect(scanAddedLines(diff(["+const k = 'AKIAIOSFODNN7EXAMPLE' // fixture"]), ["fixture"])).toEqual([])
  })
})

describe("mask / maskSecrets", () => {
  test("masks values and auth material in free text", () => {
    expect(mask("short")).toBe("*****")
    expect(mask("AKIAIOSFODNN7EXAMPLE")).toBe("AKIA************MPLE")
    expect(maskSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toContain("Bearer [redacted]")
    expect(maskSecrets("https://user:s3cr3tpass@gitlab.example.com/x.git")).toBe("https://user:[redacted]@gitlab.example.com/x.git")
    expect(maskSecrets("token glpat-abcdefghij1234567890 here")).not.toContain("glpat-abcdefghij1234567890")
  })
})
