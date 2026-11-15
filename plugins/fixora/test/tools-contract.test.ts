// Every Fixora tool returns a structured `output` next to its content text. The host (core/src/tool/runtime.ts)
// kills such a call with "Tool result declared output without an output schema" unless the tool declares one,
// so this test fails as soon as a tool is registered without `output`, or a result stops carrying the content
// text in `output.message` (CodeMode scripts receive the output only, so STOP / CONTINUE must be in it).

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readOptions } from "../src/options.js"
import type { Runtime } from "../src/progress.js"
import { registerPluginTools } from "../src/tools.js"
import { mockCtx, toolCtx, type MockCtx } from "./mock-ctx.js"

let root: string
let mock: MockCtx

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fixora-tools-"))
  mock = mockCtx({ directory: root, worker: async () => {} })
  const opts = readOptions({})
  if (!opts.ok) throw new Error(opts.errors.join())
  const rt: Runtime = { ctx: mock.ctx, opts: opts.value, services: {}, emit: async () => {}, inflight: new Map() }
  await registerPluginTools(mock.ctx, { rt: () => rt, isWorkerSession: async () => false, start: async () => ({ started: [], errors: [] }) })
})
afterAll(() => rm(root, { recursive: true, force: true }))

describe("tool result contract", () => {
  test("every registered tool declares an output schema", () => {
    const tools = [...mock.tools.values()]
    expect(tools.length).toBeGreaterThanOrEqual(10)
    for (const t of tools) {
      expect({ tool: t.id, output: t.output }).toEqual({ tool: t.id, output: expect.objectContaining({ type: "object" }) })
    }
  })

  test("a refused call returns ok:false with the content text repeated in output.message", async () => {
    for (const t of [...mock.tools.values()].filter((x) => x.name !== "start")) {
      const r = await t.execute({ version: 1 }, toolCtx("not-a-worker-session"))
      const out = r.output as { ok?: boolean; errors?: string[]; message?: string }
      expect({ tool: t.id, ok: out.ok, errors: out.errors?.length, message: out.message }).toEqual({ tool: t.id, ok: false, errors: expect.any(Number), message: r.content })
    }
  })

  test("fixora_start returns its result as output", async () => {
    const start = mock.tools.get("fixora_start")!
    const r = await start.execute({ refs: ["sentry:1"] }, toolCtx("origin"))
    expect(r.output).toEqual({ started: [], errors: [] })
  })
})
