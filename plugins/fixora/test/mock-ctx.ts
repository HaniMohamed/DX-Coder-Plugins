// A fake DXcoder plugin context for orchestration tests: in-memory storage, recorded synthetic
// messages, scripted worker sessions that call the plugin's own tools, fake MCP tools (listed, never
// executed by the plugin), recorded permission requests and RPC events. No git, no processes.

import type { Plugin } from "@opencode/plugin"

export interface RegisteredTool {
  id: string
  name: string
  description: string
  input: unknown
  options?: { namespace?: string; codemode?: boolean }
  execute: (input: unknown, ctx: { sessionID: string; agent: string; messageID: string; id: string; signal: AbortSignal; progress: () => Promise<void> }) => Promise<{ output?: unknown; content?: string }>
}

export interface Synthetic {
  sessionID: string
  text: string
  description?: string
  resume?: boolean
}

export interface SessionRecord {
  id: string
  parentID?: string
  title?: string
  agent?: string
  location?: { directory: string }
  permissions?: unknown
  prompts: Array<{ text: string; skills?: Array<{ id: string }>; files?: Array<{ uri: string; name?: string }> }>
  interrupted: number
}

export type Worker = (prompt: { text: string; skills?: Array<{ id: string }> }, session: SessionRecord, tools: (name: string) => RegisteredTool) => Promise<void>

export interface MockCtx {
  ctx: Plugin.Context
  storage: Map<string, unknown>
  synthetics: Synthetic[]
  sessions: Map<string, SessionRecord>
  tools: Map<string, RegisteredTool>
  permissionRequests: Array<{ action: string; resources: string[]; metadata?: unknown }>
  rpcEvents: Array<{ name: string; data: unknown }>
  hooks: { toolBefore: Array<(e: unknown) => Promise<void> | void>; permissionEvaluate: Array<(e: { sessionID: string; action: string; effect: string }) => void> }
  worker: Worker
  rejectPermissions: Set<string>
  mcpTools: RegisteredTool[]
  mcpServers: Array<{ name: string; status: string }>
  /** Assistant text `session.context` returns (feedback answers). */
  assistantText: string
}

export const toolCtx = (sessionID: string) => ({ sessionID, agent: "build", messageID: "m", id: "c", signal: new AbortController().signal, progress: async () => {} })

export function mockCtx(o: { directory: string; options?: Record<string, unknown>; worker: Worker }): MockCtx {
  const storage = new Map<string, unknown>()
  const synthetics: Synthetic[] = []
  const sessions = new Map<string, SessionRecord>()
  const tools = new Map<string, RegisteredTool>()
  const permissionRequests: MockCtx["permissionRequests"] = []
  const rpcEvents: MockCtx["rpcEvents"] = []
  const hooks: MockCtx["hooks"] = { toolBefore: [], permissionEvaluate: [] }
  const rejectPermissions = new Set<string>()
  const mcpTools: RegisteredTool[] = []
  const mcpServers: MockCtx["mcpServers"] = []
  let counter = 0
  const box: { worker: Worker; assistantText: string } = { worker: o.worker, assistantText: "" }

  const toolById = (name: string) => {
    const t = [...tools.values(), ...mcpTools].find((x) => x.id === name || x.name === name)
    if (!t) throw new Error(`no tool ${name}`)
    return t
  }

  const ctx = {
    app: { name: "dxcoder", version: "test", channel: "test" },
    location: { directory: o.directory, project: { id: "proj_test", directory: o.directory, canonical: o.directory } },
    options: o.options ?? {},
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, JSON.parse(JSON.stringify(value))),
      remove: async (key: string) => void storage.delete(key),
      scan: async (opts: { prefix: string; limit?: number; after?: string }) => {
        const entries = [...storage.entries()].filter(([k]) => k.startsWith(opts.prefix) && (!opts.after || k > opts.after)).sort(([a], [b]) => (a < b ? -1 : 1))
        const page = entries.slice(0, opts.limit ?? 100)
        return { entries: page.map(([key, value]) => ({ key, value })), next: entries.length > page.length ? page[page.length - 1]![0] : undefined }
      },
    },
    session: {
      create: async (input: { parentID?: string; title?: string; agent?: string; location?: { directory: string }; permissions?: unknown }) => {
        const id = `ses_${++counter}`
        sessions.set(id, { id, parentID: input.parentID, title: input.title, agent: input.agent, location: input.location, permissions: input.permissions, prompts: [], interrupted: 0 })
        return { id }
      },
      get: async (input: { sessionID: string }) => {
        const s = sessions.get(input.sessionID)
        if (!s) throw new Error("not found")
        return { ...s, location: s.location ?? { directory: o.directory } }
      },
      prompt: async (input: { sessionID: string; text: string; skills?: Array<{ id: string }>; files?: Array<{ uri: string; name?: string }> }) => {
        const s = sessions.get(input.sessionID)
        if (!s) throw new Error(`no session ${input.sessionID}`)
        s.prompts.push({ text: input.text, skills: input.skills, files: input.files })
        await box.worker({ text: input.text, skills: input.skills }, s, toolById)
        return {}
      },
      wait: async () => {},
      synthetic: async (input: Synthetic) => void synthetics.push(input),
      interrupt: async (input: { sessionID: string }) => {
        const s = sessions.get(input.sessionID)
        if (s) s.interrupted++
        return { interrupted: true }
      },
      context: async () => (box.assistantText ? [{ role: "assistant", parts: [{ type: "text", text: box.assistantText }] }] : []),
      generate: async () => ({ text: "" }),
    },
    permission: {
      assert: async (input: { action: string; resources: string[]; metadata?: unknown }) => {
        permissionRequests.push(input)
        if (rejectPermissions.has(input.action)) throw new Error(`rejected ${input.action}`)
      },
      hook: async (_name: string, cb: (e: { sessionID: string; action: string; effect: string }) => void) => {
        hooks.permissionEvaluate.push(cb)
        return { dispose: async () => {} }
      },
    },
    tool: {
      list: async () => [...tools.values(), ...mcpTools],
      transform: async (cb: (editor: { add: (t: Omit<RegisteredTool, "id">) => void; list: () => RegisteredTool[] }) => void) => {
        cb({
          add: (t) => {
            // Mirrors the host: a namespaced tool's effective id is `<namespace>_<name>`.
            const id = t.options?.namespace ? `${t.options.namespace}_${t.name}` : t.name
            tools.set(id, { ...t, id })
          },
          list: () => [...tools.values()],
        })
        return { dispose: async () => {} }
      },
      hook: async (_name: string, cb: (e: unknown) => Promise<void> | void) => {
        hooks.toolBefore.push(cb)
        return { dispose: async () => {} }
      },
      reload: async () => {},
    },
    mcp: {
      list: async () => ({ data: mcpServers.map((s) => ({ name: s.name, status: { status: s.status } })) }),
      transform: async (cb: (editor: { list: () => Array<[string, unknown]> }) => void) => {
        cb({ list: () => [] })
        return { dispose: async () => {} }
      },
      reload: async () => {},
    },
    rpc: {
      register: async () => ({ events: { emit: async (name: string, data: unknown) => void rpcEvents.push({ name, data }) }, dispose: async () => {} }),
    },
    skill: { transform: async (cb: (editor: { get: () => undefined; add: () => void }) => void) => (cb({ get: () => undefined, add: () => {} }), { dispose: async () => {} }) },
    command: { transform: async () => ({ dispose: async () => {} }) },
    generate: { text: async () => ({ data: { text: "" } }) },
    event: { subscribe: async () => [] },
  }
  return {
    ctx: ctx as unknown as Plugin.Context,
    storage,
    synthetics,
    sessions,
    tools,
    permissionRequests,
    rpcEvents,
    hooks,
    rejectPermissions,
    mcpTools,
    mcpServers,
    get worker() {
      return box.worker
    },
    set worker(w: Worker) {
      box.worker = w
    },
    get assistantText() {
      return box.assistantText
    },
    set assistantText(t: string) {
      box.assistantText = t
    },
  }
}

/** A fake MCP tool that is only listed (the plugin never executes MCP tools itself). */
export const fakeMcpTool = (id: string, props: Record<string, unknown> = {}): RegisteredTool => ({
  id,
  name: id,
  description: `fake ${id}`,
  input: { type: "object", properties: props },
  execute: async () => ({ output: {} }),
})
