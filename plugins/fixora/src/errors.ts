// Turns anything a host API, an MCP tool or an RPC call rejects with into a readable line. The host
// bridges Effect failures to promises as plain objects ({ _tag, message, ... }) rather than Error
// instances, so `String(error)` would only ever print "[object Object]".

export function describeError(error: unknown, depth = 0): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    const extra = depth < 2 && cause !== undefined && cause !== error ? ` (cause: ${describeError(cause, depth + 1)})` : ""
    return `${error.message || error.name}${extra}`
  }
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const o = error as Record<string, unknown>
    const tag = [o._tag, o.type, o.name, o.code].find((t) => typeof t === "string" && t) as string | undefined
    for (const key of ["message", "reason", "error", "description", "detail"]) {
      const v = o[key]
      if (typeof v === "string" && v.trim()) return tag && !v.includes(tag) ? `${v} [${tag}]` : v
      if (v && typeof v === "object" && depth < 2) return describeError(v, depth + 1)
    }
    try {
      const json = JSON.stringify(error)
      if (json && json !== "{}") return `${tag ? `${tag}: ` : ""}${json.slice(0, 400)}`
    } catch {
      // circular
    }
    return tag ?? "unknown error"
  }
  return String(error)
}
