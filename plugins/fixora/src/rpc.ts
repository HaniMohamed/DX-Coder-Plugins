// Shared RPC contract between the server plugin and a TUI entry (pass 2). Schemas are plain JSON
// Schema objects so both sides can import this file without extra dependencies.

import { Rpc } from "@opencode/plugin/rpc"

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, properties, required, additionalProperties: true })
const S = { type: "string" } as const
const N = { type: "number" } as const
const B = { type: "boolean" } as const
const arr = (items: unknown) => ({ type: "array" as const, items })
const any = {} as const

export const RunSummarySchema = obj(
  {
    runId: S,
    source: S,
    crashId: S,
    title: S,
    step: S,
    status: S,
    confidence: N,
    jiraKey: S,
    mrUrl: S,
    mrStatus: S,
    branch: S,
    createdAt: S,
    updatedAt: S,
    totalMs: N,
    counters: obj({ fixRounds: N, reviewRounds: N, feedback: N, restarts: N }),
  },
  ["runId", "source", "crashId", "title", "step", "status", "createdAt", "updatedAt"],
)

export const CrashSummarySchema = obj({ source: S, id: S, title: S, userCount: N, eventCount: N, lastSeen: S, appVersion: S, url: S, fingerprint: S, state: S, runId: S }, ["source", "id", "title"])

export const FixoraRpc = Rpc.define({
  id: "gosi.fixora",
  methods: {
    "sources.list": { input: obj({}), output: obj({ sources: arr(obj({ id: S, status: S, serverName: S, hint: S }, ["id", "status"])) }) },
    "crashes.list": { input: obj({ source: S, top: N, minUsers: N, sessionID: S }), output: obj({ crashes: arr(CrashSummarySchema), errors: arr(S) }), errors: { source_unavailable: obj({ message: S }) } },
    "runs.list": { input: obj({ status: arr(S), limit: N }), output: obj({ runs: arr(RunSummarySchema) }) },
    "runs.get": { input: obj({ runId: S }, ["runId"]), output: obj({ run: any }), errors: { not_found: obj({ runId: S }) } },
    "run.start": { input: obj({ ref: S, sessionID: S, flags: any }, ["ref", "sessionID"]), output: obj({ runId: S }), errors: { busy: obj({ runId: S }), invalid_ref: obj({ ref: S }) } },
    "run.retry": { input: obj({ runId: S, sessionID: S, from: S, fresh: B }, ["runId", "sessionID"]), output: obj({ runId: S }), errors: { not_found: obj({ runId: S }), busy: obj({ runId: S }) } },
    "run.restart": { input: obj({ runId: S, sessionID: S }, ["runId", "sessionID"]), output: obj({ runId: S }), errors: { not_found: obj({ runId: S }), busy: obj({ runId: S }) } },
    "run.feedback": { input: obj({ runId: S, sessionID: S, message: S }, ["runId", "sessionID", "message"]), output: obj({ runId: S }), errors: { not_found: obj({ runId: S }), busy: obj({ runId: S }) } },
    "run.cancel": { input: obj({ runId: S }, ["runId"]), output: obj({ cancelled: B }) },
    "crash.markFixed": { input: obj({ runId: S, release: S, platform: S }, ["runId", "release"]), output: obj({ ok: B }), errors: { not_found: obj({ runId: S }) } },
    "mr.sync": { input: obj({ sessionID: S }), output: obj({ updated: N }) },
    "report.get": { input: obj({ days: N }), output: any },
  },
  events: {
    "run.started": { schema: obj({ runId: S, sessionID: S, title: S }, ["runId", "sessionID"]) },
    "run.stage": { schema: obj({ runId: S, sessionID: S, step: S, status: S, durationMs: N, attempt: N, detail: S }, ["runId", "sessionID", "step", "status"]) },
    "run.progress": { schema: obj({ runId: S, sessionID: S, step: S, message: S }, ["runId", "sessionID", "step", "message"]) },
    "run.awaiting": { schema: obj({ runId: S, sessionID: S, kind: S, summary: S }, ["runId", "sessionID", "kind"]) },
    "run.gate.resolved": { schema: obj({ runId: S, sessionID: S, kind: S, decision: S }, ["runId", "sessionID", "kind", "decision"]) },
    "run.done": { schema: obj({ runId: S, sessionID: S, mrUrl: S, jiraKey: S, branch: S, totalMs: N, report: S }, ["runId", "sessionID"]) },
    "run.failed": { schema: obj({ runId: S, sessionID: S, step: S, status: S, error: S }, ["runId", "sessionID", "step", "status"]) },
    "crash.reopened": { schema: obj({ runId: S, fingerprint: S, reason: S, previousRunId: S }, ["runId", "fingerprint"]) },
  },
})

export type FixoraRpcDefinition = typeof FixoraRpc
