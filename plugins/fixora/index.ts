import { Plugin, Skill } from "@opencode/plugin"
import matter from "gray-matter"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { COMMAND, parseCommand, SUBCOMMANDS, USAGE, type Flags, type Parsed } from "./src/command.js"
import { describeError } from "./src/errors.js"
import { prepareRun, presentList, refreshServices, runClean, runDoctor, runFeedback, runFix, runFixed, runList, runPaste, runReport, runReset, runRestart, runRetry, runStatus, runSync, runTop, startPipeline, warnLegacyOnce } from "./src/flows.js"
import { ackGate, decideGate } from "./src/gate.js"
import { DEFAULTS, readOptions, type FixoraOptions } from "./src/options.js"
import { guardWorkerTool, SHELL_TOOLS, WRITE_TOOLS } from "./src/permissions.js"
import { describeToolCall, FixoraStop, notify, progress, tell, type Runtime } from "./src/progress.js"
import { eventEmitter, FixoraRpc, prunedHandlers } from "./src/rpc.js"
import { funnel, listCrashIndex, listRuns, loadRun, loadWorker } from "./src/state.js"
import { registerPluginTools } from "./src/tools.js"
import type { RunRecord } from "./src/types.js"

export { parseCommand }

const SKILLS = ["fixora-crashes", "fixora-prepare", "fixora-triage", "fixora-fix", "fixora-review", "fixora-publish", "fixora-ops"]

const DEFAULT_FLAGS: Flags = { dryRun: false, ticket: true, mr: true, push: true, auto: false, force: false, forceTriage: false }

const summary = (r: RunRecord) => ({
  runId: r.runId,
  source: r.source,
  crashId: r.crashId,
  title: r.title,
  step: r.step,
  status: r.status,
  confidence: r.triage?.confidence,
  jiraKey: r.jiraKey,
  jiraUrl: r.jiraUrl,
  mrUrl: r.mrUrl,
  mrStatus: r.mrStatus,
  branch: r.branch,
  originSessionID: r.originSessionID,
  fixerSessionID: r.sessions.fixer,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  totalMs: r.totalMs,
  error: r.error,
  counters: { fixRounds: r.counters.fixRounds, reviewRounds: r.counters.reviewRounds, feedback: r.counters.feedback, restarts: r.counters.restarts },
})

export default Plugin.define({
  id: "gosi.fixora",
  async setup(ctx) {
    // Options are validated on every command so a bad opencode.jsonc gives a readable error.
    const readOpts = (): FixoraOptions => {
      const r = readOptions(ctx.options)
      if (!r.ok) throw new FixoraStop(`Fixora options are invalid:\n- ${r.errors.join("\n- ")}`)
      return r.value
    }
    const initial = readOptions(ctx.options)
    const version = await readFile(new URL("./package.json", import.meta.url), "utf8")
      .then((t) => String((JSON.parse(t) as { version?: string }).version ?? "unknown"))
      .catch(() => "unknown")
    const rt: Runtime = {
      ctx,
      opts: initial.ok ? initial.value : DEFAULTS,
      services: {},
      emit: async () => {},
      inflight: new Map(),
      version,
    }

    // Bundled worker skills, loaded the same way the Figma and jira-planner plugins load theirs.
    for (const id of SKILLS) {
      const file = new URL(`./skills/${id}/SKILL.md`, import.meta.url)
      const markdown = matter(await readFile(file, "utf8"))
      const skill = Skill.Info.make({
        id: Skill.ID.make(id),
        name: Skill.Name.make(markdown.data.name ?? id),
        description: markdown.data.description,
        autoinvoke: markdown.data["disable-model-invocation"] !== true,
        path: Skill.Info.fields.path.make(fileURLToPath(file)),
        content: markdown.content,
      })
      await ctx.skill.transform((editor) => {
        if (!editor.get(skill.id)) editor.add(skill)
      })
    }

    // RPC contract for the TUI. Events are emitted from progress.ts through rt.emit.
    try {
      // Every reply is pruned of undefined keys: the host validates outputs in-process and rejects them.
      const register: typeof ctx.rpc.register = (definition, handlers) => ctx.rpc.register(definition, prunedHandlers(handlers as never) as never)
      const reg = await register(FixoraRpc, {
        "sources.list": async () => {
          await refreshServices(rt)
          return { sources: Object.values(rt.services).filter(Boolean).map((s) => ({ id: s!.id, status: s!.status, serverName: s!.serverName })) }
        },
        "crashes.list": async (input) => {
          const i = input as { source?: string; platform?: string; top?: number; minUsers?: number; sessionID?: string; refresh?: boolean }
          try {
            rt.opts = readOpts()
            const list = await runList(rt, { sessionID: i.sessionID ?? "", top: i.top, minUsers: i.minUsers, source: i.source as never, platform: i.platform, refresh: i.refresh })
            return { crashes: list.crashes, errors: list.errors }
          } catch (error) {
            return { crashes: [], errors: [describeError(error)] }
          }
        },
        "runs.list": async (input) => {
          const i = input as { status?: string[]; limit?: number }
          const runs = (await listRuns(ctx)).filter((r) => !i.status?.length || i.status.includes(r.status)).slice(0, i.limit ?? 50)
          for (const r of runs) if (rt.inflight.has(r.runId)) r.status = "running"
          return { runs: runs.map(summary) }
        },
        "runs.get": async (input, c) => {
          const run = await loadRun(ctx, (input as { runId: string }).runId)
          if (!run) return c.error("not_found", "run not found", { runId: (input as { runId: string }).runId })
          return { run: run as unknown as Record<string, unknown> }
        },
        "run.start": async (input, c) => {
          const i = input as { ref: string; sessionID: string; flags?: Partial<Flags> }
          try {
            rt.opts = readOpts()
            const run = await prepareRun(rt, { sessionID: i.sessionID, ref: i.ref, flags: { ...DEFAULT_FLAGS, ...(i.flags ?? {}) } })
            void startPipeline(rt, run, { from: "detect" }).catch(() => {})
            return { runId: run.runId }
          } catch (error) {
            if (error instanceof FixoraStop && /already in progress/.test(error.message)) return c.error("busy", "run already in progress", { runId: i.ref })
            return c.error("invalid_ref", "invalid crash reference", { ref: `${i.ref}: ${describeError(error)}` })
          }
        },
        "run.retry": async (input, c) => {
          const i = input as { runId: string; sessionID: string; from?: string; fresh?: boolean }
          const run = await loadRun(ctx, i.runId)
          if (!run) return c.error("not_found", "run not found", { runId: i.runId })
          if (rt.inflight.has(i.runId)) return c.error("busy", "run already in progress", { runId: i.runId })
          rt.opts = readOpts()
          void runRetry(rt, { sessionID: i.sessionID, runId: i.runId, from: i.from as never, fresh: !!i.fresh, flags: DEFAULT_FLAGS }).catch(() => {})
          return { runId: i.runId }
        },
        "run.restart": async (input, c) => {
          const i = input as { runId: string; sessionID: string }
          const run = await loadRun(ctx, i.runId)
          if (!run) return c.error("not_found", "run not found", { runId: i.runId })
          rt.opts = readOpts()
          void runRestart(rt, { sessionID: i.sessionID, runId: i.runId, flags: DEFAULT_FLAGS }).catch(() => {})
          return { runId: i.runId }
        },
        "run.feedback": async (input, c) => {
          const i = input as { runId: string; sessionID: string; message: string }
          const run = await loadRun(ctx, i.runId)
          if (!run) return c.error("not_found", "run not found", { runId: i.runId })
          if (rt.inflight.has(i.runId)) return c.error("busy", "run already in progress", { runId: i.runId })
          rt.opts = readOpts()
          void runFeedback(rt, { sessionID: i.sessionID, runId: i.runId, message: i.message }).catch(() => {})
          return { runId: i.runId }
        },
        "run.cancel": async (input) => {
          const i = input as { runId: string }
          const inflight = rt.inflight.get(i.runId)
          inflight?.controller.abort()
          return { cancelled: !!inflight }
        },
        "run.ack": async (input) => {
          const i = input as { runId: string; gateId: string }
          return { accepted: ackGate(i.gateId, i.runId) }
        },
        "run.approve": async (input) => {
          const i = input as { runId: string; gateId: string }
          return { accepted: decideGate(i.gateId, i.runId, { approved: true }) }
        },
        "run.reject": async (input) => {
          const i = input as { runId: string; gateId: string; feedback?: string }
          return { accepted: decideGate(i.gateId, i.runId, { approved: false, feedback: i.feedback }) }
        },
        "crash.markFixed": async (input, c) => {
          const i = input as { runId: string; release: string; platform?: string }
          const run = await loadRun(ctx, i.runId)
          if (!run) return c.error("not_found", "run not found", { runId: i.runId })
          await runFixed(rt, { sessionID: run.originSessionID, runId: i.runId, release: i.release, platform: i.platform })
          return { ok: true }
        },
        "mr.sync": async (input) => ({ updated: await runSync(rt, { sessionID: (input as { sessionID?: string }).sessionID ?? "" }) }),
        "report.get": async (input) => {
          const [runs, crashes] = await Promise.all([listRuns(ctx), listCrashIndex(ctx)])
          return funnel(runs, crashes, { days: (input as { days?: number }).days ?? 30 }) as unknown as Record<string, unknown>
        },
      })
      rt.emit = eventEmitter(
        (name, data) => (reg.events.emit as unknown as (n: string, d: Record<string, unknown>) => Promise<void>)(name, data),
        (error) => {
          rt.emitFailures = (rt.emitFailures ?? 0) + 1
          rt.lastEmitError = describeError(error).slice(0, 300)
        },
      )
    } catch {
      // RPC registration is optional (older hosts)
    }

    // Plugin tools: structured submissions from workers + fixora_start for the interactive picker.
    await registerPluginTools(ctx, {
      rt: () => rt,
      isWorkerSession: async (sessionID) => !!(await loadWorker(ctx, sessionID)),
      start: async ({ sessionID, refs, flags }) => {
        rt.opts = readOpts()
        const started: string[] = []
        const errors: string[] = []
        for (const ref of refs) {
          try {
            const run = await prepareRun(rt, { sessionID, ref, flags: { ...DEFAULT_FLAGS, ...((flags ?? {}) as Partial<Flags>) } })
            started.push(run.runId)
            void startPipeline(rt, run, { from: "detect" }).catch(() => {})
          } catch (error) {
            errors.push(`${ref}: ${describeError(error).split("\n")[0]}`)
          }
        }
        return { started, errors }
      },
    })

    // Confine worker sessions per phase: which files, git verbs, MCP tools and CLIs are allowed right now.
    // The worker record is re-read on every call because phases and grants change between prompts.
    await ctx.tool.hook("execute.before", async (event) => {
      const w = await loadWorker(ctx, event.sessionID)
      if (!w) return
      const run = w.runId && (WRITE_TOOLS.has(event.tool) || SHELL_TOOLS.has(event.tool)) ? await loadRun(ctx, w.runId) : undefined
      const problem = guardWorkerTool({ tool: event.tool, input: event.input, worker: w, services: rt.services, extraDeny: rt.opts.validate.denyPaths, checks: run?.toolchain?.checks })
      if (problem) throw new Error(problem)
    })

    // Live worker activity: every tool call a Fixora worker session makes becomes a progress line
    // ("reading lib/cart/service.dart", "$ flutter test …") so long phases are not silent.
    void (async () => {
      const lastAt = new Map<string, number>()
      const workers = new Map<string, { runId?: string; role: string; at: number }>()
      try {
        for await (const event of await ctx.event.subscribe()) {
          const e = event as { type?: string; data?: { sessionID?: string; input?: Record<string, unknown> } }
          if (e.type !== "session.tool.called" || !e.data?.sessionID) continue
          let w = workers.get(e.data.sessionID)
          if (!w || Date.now() - w.at > 30_000) {
            const info = await loadWorker(ctx, e.data.sessionID)
            if (!info) continue
            w = { runId: info.runId, role: info.role, at: Date.now() }
            workers.set(e.data.sessionID, w)
          }
          if (!w.runId) continue
          const now = Date.now()
          if (now - (lastAt.get(w.runId) ?? 0) < 700) continue
          lastAt.set(w.runId, now)
          const run = await loadRun(ctx, w.runId)
          if (!run || (run.status !== "running" && run.status !== "awaiting-approval")) continue
          await progress(rt, run, `${w.role === "reviewer" ? "reviewer" : "agent"}: ${describeToolCall(e.data.input)}`, { quiet: true })
        }
      } catch {
        // event stream unavailable on this host: the panel still shows stage-level progress
      }
    })()

    /** One dispatcher for `/fixora <verb> …` and every `/fixora:<verb> …` command. */
    const dispatch = async (sessionID: string, text: string) => {
          const parsed = parseCommand(text)
          if ("error" in parsed) {
            await notify(ctx, sessionID, `fixora: ${parsed.error.split("\n")[0]}`, parsed.error)
            return
          }
          try {
            rt.opts = readOpts()
            await warnLegacyOnce(rt, sessionID)
            await runVerb(sessionID, parsed)
          } catch (error) {
            if (error instanceof FixoraStop) {
              await tell(ctx, sessionID, `fixora stopped: ${error.message.split("\n")[0]!.slice(0, 140)}`, error.message)
              return
            }
            const message = error instanceof Error ? `${error.name}: ${error.message}` : describeError(error)
            await tell(ctx, sessionID, `fixora failed: ${message.slice(0, 140)}`, `The command failed:\n\n\`\`\`\n${message}\n\`\`\``)
          }
    }
    const runVerb = async (sessionID: string, parsed: Parsed) => {
            switch (parsed.verb) {
              case "help":
                await tell(ctx, sessionID, "fixora usage", `\`\`\`\n${USAGE}\n\`\`\``)
                break
              case "list": {
                const list = await runList(rt, { sessionID, platform: parsed.platform })
                await presentList(rt, sessionID, list)
                break
              }
              case "fix":
                await runFix(rt, { sessionID, ref: parsed.ref, flags: parsed.flags })
                break
              case "paste":
                await runPaste(rt, { sessionID, file: parsed.file, title: parsed.title, platform: parsed.platform, language: parsed.language, flags: parsed.flags })
                break
              case "top": {
                const res = await runTop(rt, { sessionID, count: parsed.count, platform: parsed.platform, flags: parsed.flags })
                if (res.errors.length) await notify(ctx, sessionID, `fixora top: ${res.errors.join("; ")}`)
                break
              }
              case "batch": {
                const res = await runTop(rt, { sessionID, count: parsed.top ?? rt.opts.batch.top, minUsers: parsed.minUsers ?? rt.opts.batch.minUsers, source: parsed.source as never, platform: parsed.platform, maxMinutes: parsed.minutes ?? rt.opts.batch.maxMinutes, flags: parsed.flags })
                await tell(ctx, sessionID, "fixora batch finished", `Batch finished.\n\nStarted: ${res.started.map((s) => `\`${s}\``).join(", ") || "none"}${res.errors.length ? `\n\nSkipped: ${res.errors.join("; ")}` : ""}\n\nRun \`/fixora status\` for details.`)
                break
              }
              case "status":
                await runStatus(rt, { sessionID, runId: parsed.runId })
                break
              case "retry":
                await runRetry(rt, { sessionID, runId: parsed.runId, from: parsed.from, fresh: parsed.fresh, flags: parsed.flags })
                break
              case "feedback":
                await runFeedback(rt, { sessionID, runId: parsed.runId, message: parsed.message })
                break
              case "restart":
                await runRestart(rt, { sessionID, runId: parsed.runId, flags: parsed.flags })
                break
              case "fixed":
                await runFixed(rt, { sessionID, runId: parsed.runId, release: parsed.release, platform: parsed.platform })
                break
              case "report":
                await runReport(rt, { sessionID, days: parsed.days })
                break
              case "clean":
                await runClean(rt, { sessionID, runId: parsed.runId, remote: parsed.remote })
                break
              case "sync":
                await runSync(rt, { sessionID })
                break
              case "reset":
                await runReset(rt, { sessionID, files: parsed.files })
                break
              case "doctor":
                await runDoctor(rt, { sessionID, all: parsed.all, probe: parsed.probe, tool: parsed.tool })
                break
            }
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: COMMAND,
        description: "Fix production crashes: pick a crash from Sentry / Crashlytics (or paste a trace); the coding agent then finds the root cause in this checkout, fixes and tests it on a fixora/ branch, a second agent session reviews it, and after your approval the agent pushes and opens a draft MR (with a Jira ticket when available). Your branch and local changes are restored afterwards. Verbs: fix, paste, top, batch, status, retry, feedback, restart, fixed, report, clean, sync, reset, doctor (each also a /fixora:<verb> command).",
        execute: (input) => dispatch(input.sessionID, input.prompt.text),
      })
      // Every verb as its own command so the palette lists `/fixora:status`, `/fixora:fix`, …
      for (const sub of SUBCOMMANDS) {
        editor.add({
          name: sub.name,
          description: `${sub.description}${sub.args ? ` — /${sub.name} ${sub.args}` : ""}`,
          execute: (input) => dispatch(input.sessionID, `${sub.verb} ${input.prompt.text}`),
        })
      }
    })
  },
})
