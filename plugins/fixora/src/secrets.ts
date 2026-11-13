// Secret scanning on added diff lines before anything is committed, plus masking for log output.

export interface SecretPattern {
  name: string
  regex: RegExp
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { name: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "GitHub fine-grained token", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "GitLab token", regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Slack token", regex: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "Stripe key", regex: /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "private key", regex: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "JWT", regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "Sentry DSN", regex: /https:\/\/[0-9a-f]{32}@/ },
  { name: "generic credential assignment", regex: /\b(api[_-]?key|secret|token|passwd|password)\b\s*[:=]\s*["'][A-Za-z0-9/+=_\-]{16,}["']/i },
]

export interface SecretFinding {
  file: string
  line: number
  pattern: string
  masked: string
}

export interface AddedLine {
  file: string
  line: number
  text: string
}

/** Extracts added lines (with new-file line numbers) from a unified diff. */
export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = []
  let file = ""
  let line = 0
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "").trim()
      continue
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff ") || raw.startsWith("index ")) continue
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (raw.startsWith("+")) {
      out.push({ file, line, text: raw.slice(1) })
      line++
    } else if (raw.startsWith("-") || raw.startsWith("\\")) {
      // removed line or "\ No newline at end of file": new-file line number unchanged
    } else line++
  }
  return out
}

export function mask(value: string): string {
  if (value.length <= 8) return "*".repeat(value.length)
  return `${value.slice(0, 4)}${"*".repeat(Math.min(value.length - 8, 24))}${value.slice(-4)}`
}

export function scanAddedLines(diff: string, allow: string[] = []): SecretFinding[] {
  const allowed = allow.map((a) => new RegExp(a))
  const findings: SecretFinding[] = []
  for (const added of addedLines(diff)) {
    for (const p of SECRET_PATTERNS) {
      const m = p.regex.exec(added.text)
      if (!m) continue
      if (allowed.some((a) => a.test(added.text))) continue
      findings.push({ file: added.file, line: added.line, pattern: p.name, masked: mask(m[0]) })
      break
    }
  }
  return findings
}

/** Masks anything that looks like a secret in free text (used before logging or showing errors). */
export function maskSecrets(text: string): string {
  let out = text
  for (const p of SECRET_PATTERNS) {
    out = out.replace(new RegExp(p.regex.source, `${p.regex.flags.replace("g", "")}g`), (m) => mask(m))
  }
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-=+/]{12,}/gi, (_m, pre: string) => `${pre}[redacted]`)
  out = out.replace(/(https?:\/\/)([^:@/\s]+):([^@/\s]+)@/g, (_m, proto: string, user: string) => `${proto}${user}:[redacted]@`)
  return out
}
