import { Plugin, Skill } from "@opencode/plugin"
import matter from "gray-matter"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { COMMAND, parseCommand, USAGE, type Flags } from "./src/command.js"
import { prepareRun, presentList, refreshServices, runClean, runFeedback, runFix, runFixed, runList, runPaste, runReport, runRestart, runRetry, runStatus, runSync, runTop, startPipeline } from "./src/flows.js"
import { ackGate, decideGate } from "./src/gate.js"
import { decideAutoAllow, pendingCalls } from "./src/mcp.js"
import { DEFAULTS, readOptions, type FixoraOptions } from "./src/options.js"
import { guardWorkerShell, guardWorkerWrite, SHELL_TOOLS, WRITE_TOOLS } from "./src/permissions.js"
import { FixoraStop, notify, tell, type Runtime } from "./src/progress.js"
import { FixoraRpc } from "./src/rpc.js"
import { funnel, listCrashIndex, listRuns, loadRun, loadWorker } from "./src/state.js"
import { registerPluginTools } from "./src/tools.js"
import { detectEcosystems } from "./src/toolchain.js"
import type { RunRecord } from "./src/types.js"

export { parseCommand }

const SKILLS = ["fixora-triage", "fixora-fix", "fixora-review"]

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
  worktree: r.worktree,
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
    const rt: Runtime = {
      ctx,
      opts: initial.ok ? initial.value : DEFAULTS,
      services: {},
      emit: async () => {},
      inflight: new Map(),
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

    // RPC contract for a TUI (pass 2). Events are emitted from progress.ts through rt.emit.
    try {
      const reg = await ctx.rpc.register(FixoraRpc, {
        "sources.list": async () => {
          await refreshServices(rt)
          return { sources: Object.values(rt.services).filter(Boolean).map((s) => ({ id: s!.id, status: s!.status, serverName: s!.serverName })) }
        },
        "crashes.list": async (input) => {
          const i = input as { source?: string; top?: number; minUsers?: number; sessionID?: string }
          try {
            const list = await runList(rt, { sessionID: i.sessionID ?? "", top: i.top, minUsers: i.minUsers, source: i.source as never })
            return { crashes: list.crashes, errors: [] }
          } catch (error) {
            return { crashes: [], errors: [error instanceof Error ? error.message : String(error)] }
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
            return c.error("invalid_ref", "invalid crash reference", { ref: `${i.ref}: ${error instanceof Error ? error.message : String(error)}` })
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
          const controller = rt.inflight.get(i.runId)
          controller?.abort()
          return { cancelled: !!controller }
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
      rt.emit = async (name, data) => {
        try {
          await (reg.events.emit as unknown as (n: string, d: Record<string, unknown>) => Promise<void>)(name, data)
        } catch {
          // a TUI may not be attached; events are best effort
        }
      }
    } catch {
      // RPC registration is optional (older hosts)
    }

    // Plugin tools: structured submissions from workers + fixora_start for the interactive picker.
    const ecosystemCache = new Map<string, Awaited<ReturnType<typeof detectEcosystems>>>()
    await registerPluginTools(ctx, {
      options: () => rt.opts,
      ecosystems: async (runId) => {
        const cached = ecosystemCache.get(runId)
        if (cached) return cached
        const run = await loadRun(ctx, runId)
        if (!run?.worktree) return []
        const eco = await detectEcosystems(run.worktree)
        ecosystemCache.set(runId, eco)
        return eco
      },
      hasTestRunner: async (runId) => {
        const run = await loadRun(ctx, runId)
        if (!run?.worktree) return false
        const eco = await detectEcosystems(run.worktree)
        return eco.some((e) => e.checks.some((c) => c.kind === "unit"))
      },
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
            errors.push(`${ref}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
          }
        }
        return { started, errors }
      },
    })

    // Confine worker sessions: writes only inside their worktree (and only in the fix phase), no
    // dangerous shell commands, nothing outside the worktree.
    const workers = new Map<string, Awaited<ReturnType<typeof loadWorker>> | null>()
    const workerOf = async (sessionID: string) => {
      let w = workers.get(sessionID)
      if (w === undefined) {
        w = (await loadWorker(ctx, sessionID)) ?? null
        workers.set(sessionID, w)
      }
      return w
    }
    await ctx.tool.hook("execute.before", async (event) => {
      if (!WRITE_TOOLS.has(event.tool) && !SHELL_TOOLS.has(event.tool)) return
      // Phase changes are frequent; re-read the worker record for writes so the triage phase stays read-only.
      const w = WRITE_TOOLS.has(event.tool) ? ((await loadWorker(ctx, event.sessionID)) ?? null) : await workerOf(event.sessionID)
      if (!w) return
      const problem = WRITE_TOOLS.has(event.tool)
        ? guardWorkerWrite({ tool: event.tool, input: event.input, worktree: w.worktree, directory: w.worktree, phase: w.phase, extraDeny: rt.opts.validate.denyPaths })
        : guardWorkerShell({ tool: event.tool, input: event.input, worktree: w.worktree, role: w.role })
      if (problem) throw new Error(problem)
    })

    // Plugin-originated MCP calls (crash fetch, Jira, MR) are pre-registered in `pendingCalls` and
    // allowed here; everything else keeps the session's rules.
    await ctx.permission.hook("evaluate", (event) => {
      if (decideAutoAllow({ sessionID: event.sessionID, action: event.action }, pendingCalls) === "allow") event.effect = "allow"
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: COMMAND,
        description: "Fix production crashes: pick a crash from Sentry / Crashlytics (or paste a trace), find the root cause on the base branch, fix and test it in a worktree, review it, and open a draft MR (with a Jira ticket when available)",
        execute: async (input) => {
          const sessionID = input.sessionID
          const parsed = parseCommand(input.prompt.text)
          if ("error" in parsed) {
            await notify(ctx, sessionID, `fixora: ${parsed.error.split("\n")[0]}`, parsed.error)
            return
          }
          try {
            rt.opts = readOpts()
            switch (parsed.verb) {
              case "help":
                await tell(ctx, sessionID, "fixora usage", `\`\`\`\n${USAGE}\n\`\`\``)
                break
              case "list": {
                const list = await runList(rt, { sessionID })
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
                const res = await runTop(rt, { sessionID, count: parsed.count, flags: parsed.flags })
                if (res.errors.length) await notify(ctx, sessionID, `fixora top: ${res.errors.join("; ")}`)
                break
              }
              case "batch": {
                const res = await runTop(rt, { sessionID, count: parsed.top ?? rt.opts.batch.top, minUsers: parsed.minUsers ?? rt.opts.batch.minUsers, source: parsed.source as never, maxMinutes: parsed.minutes ?? rt.opts.batch.maxMinutes, flags: parsed.flags })
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
            }
          } catch (error) {
            if (error instanceof FixoraStop) {
              await tell(ctx, sessionID, `fixora stopped: ${error.message.split("\n")[0]!.slice(0, 140)}`, error.message)
              return
            }
            const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
            await tell(ctx, sessionID, `fixora failed: ${message.slice(0, 140)}`, `The command failed:\n\n\`\`\`\n${message}\n\`\`\``)
          }
        },
      })
    })
  },
})
