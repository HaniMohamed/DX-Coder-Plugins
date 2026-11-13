/** @jsxImportSource @opentui/solid */
// Fixora TUI entry: a thin, reactive view over the server plugin's state. The server is the source
// of truth; this entry subscribes to its RPC events, renders the live pipeline panel, the crash
// picker, the approval dialog, the runs/report pages and small status surfaces.

import { Plugin } from "@opencode/plugin/tui"
import type { Route } from "@opencode/plugin/tui/context"
import { createSignal, Show } from "solid-js"
import { ComposerStrip, FooterChip, GateDialog, ReportPage, RunPanel, RunsPage, SidebarBadge, type Fixora } from "./src/tui/components.js"
import { currentSession, parseSlash, pickCrash, startRuns } from "./src/tui/commands.js"
import { FixoraRpc, type RunSummary } from "./src/rpc.js"
import type { FunnelStats } from "./src/state.js"
import { applyEvent, applyRecord, applySummary, awaitingGates, initialState, type GateView, type RunView, type TuiState } from "./src/tui/store.js"
import type { RunRecord } from "./src/types.js"

const PANEL = "fixora"
const RUNS_ROUTE = "fixora.runs"
const REPORT_ROUTE = "fixora.report"

export default Plugin.define({
  id: "gosi.fixora",
  async setup(context) {
    const [state, mutate] = context.storage.memory<TuiState>("state", { initial: initialState() })
    const [prefs] = context.storage.store<{ panelAutoOpen: boolean }>("prefs", { initial: { panelAutoOpen: true } })
    const rpc = context.client.rpc(FixoraRpc) as unknown as Record<string, (input: unknown) => Promise<unknown>> & { events: { on: (name: string, handler: (e: { data: Record<string, unknown> }) => void) => () => void } }
    const toast = context.ui.toast
    let previous: Route = { type: "home" }
    const [stats, setStats] = createSignal<FunnelStats | undefined>(undefined)

    const navigateTo = (name: string) => {
      const current = context.ui.router.current()
      if (!(current.type === "plugin" && (current.name === RUNS_ROUTE || current.name === REPORT_ROUTE))) previous = current
      context.ui.router.navigate({ type: "plugin", name })
    }

    const fx: Fixora = {
      context,
      state,
      mutate,
      actions: {
        async hydrate(runId) {
          try {
            if (runId) {
              const res = (await rpc["runs.get"]({ runId })) as { run: RunRecord }
              mutate((d) => void applyRecord(d, res.run))
              return
            }
            const res = (await rpc["runs.list"]({ limit: 50 })) as { runs: RunSummary[] }
            mutate((d) => {
              for (const s of res.runs) applySummary(d, s)
            })
          } catch {
            // server entry not loaded yet; the panel shows an empty state
          }
        },
        async openGate(gate) {
          try {
            const res = (await rpc["run.ack"]({ runId: gate.runId, gateId: gate.gateId })) as { accepted: boolean }
            if (!res.accepted) {
              mutate((d) => void delete d.gates[gate.gateId])
              toast.show({ message: "That approval was already answered (or is in the permission prompt).", variant: "info" })
              return
            }
          } catch {
            return
          }
          mutate((d) => {
            const g = d.gates[gate.gateId]
            if (g) {
              g.acked = true
              g.dialogOpen = true
            }
          })
          context.ui.dialog.show(
            () => <GateDialog fx={fx} gate={gate} />,
            () => mutate((d) => void (d.gates[gate.gateId] && (d.gates[gate.gateId]!.dialogOpen = false))),
          )
          context.ui.dialog.set({ size: "large", centered: true })
        },
        async approve(gate) {
          context.ui.dialog.clear()
          await rpc["run.approve"]({ runId: gate.runId, gateId: gate.gateId }).catch((e: Error) => toast.show({ message: e.message, variant: "error" }))
        },
        async reject(gate) {
          context.ui.dialog.clear()
          const feedback = await context.ui.dialog.prompt({ title: "Fixora · reject", description: "What should change? (sent to the worker when you retry; leave empty to just stop)", placeholder: "e.g. guard the Google Pay path too" })
          await rpc["run.reject"]({ runId: gate.runId, gateId: gate.gateId, feedback: feedback || undefined }).catch((e: Error) => toast.show({ message: e.message, variant: "error" }))
        },
        async retry(runId, from) {
          const sessionID = state.runs[runId]?.sessionID || currentSession(fx)
          if (!sessionID) return
          await rpc["run.retry"]({ runId, sessionID, from }).then(() => toast.show({ message: `Fixora retrying ${runId}`, variant: "info" }), (e: { message?: string }) => toast.show({ message: e.message ?? "retry failed", variant: "warning" }))
        },
        async restart(runId) {
          const ok = await context.ui.dialog.confirm({ title: "Fixora · restart", message: `Close the merge request of ${runId} (if any) and start a fresh fix cycle on a new branch?`, label: { confirm: "Restart", cancel: "Keep" } })
          if (!ok) return
          const sessionID = state.runs[runId]?.sessionID || currentSession(fx)
          if (!sessionID) return
          await rpc["run.restart"]({ runId, sessionID }).catch((e: { message?: string }) => toast.show({ message: e.message ?? "restart failed", variant: "warning" }))
        },
        async cancel(runId) {
          await rpc["run.cancel"]({ runId }).catch(() => {})
          toast.show({ message: `Fixora cancelling ${runId}`, variant: "info" })
        },
        async feedback(runId, text) {
          const message = text ?? (await context.ui.dialog.prompt({ title: `Fixora · feedback on ${runId}`, description: "Ask a question about the fix or request a change; changes are re-reviewed, pushed and the MR is updated", placeholder: "also guard the null case and add a test" }))
          if (!message) return
          const sessionID = state.runs[runId]?.sessionID || currentSession(fx)
          if (!sessionID) return
          await rpc["run.feedback"]({ runId, sessionID, message }).then(() => toast.show({ message: `Fixora: feedback sent to ${runId}`, variant: "info" }), (e: { message?: string }) => toast.show({ message: e.message ?? "feedback failed", variant: "warning" }))
        },
        focusWorker(run) {
          if (!run.fixerSessionID) return
          if (!(context.ui.tabs.enabled() && context.ui.tabs.focus(run.fixerSessionID))) context.ui.router.navigate({ type: "session", sessionID: run.fixerSessionID })
        },
        openRuns() {
          void fx.actions.hydrate()
          navigateTo(RUNS_ROUTE)
        },
        openReport() {
          void loadReport()
          navigateTo(REPORT_ROUTE)
        },
        async sync() {
          const res = (await rpc["mr.sync"]({ sessionID: currentSession(fx) }).catch(() => ({ updated: 0 }))) as { updated: number }
          toast.show({ message: `Fixora: ${res.updated} MR status change(s)`, variant: "info" })
          await fx.actions.hydrate()
        },
        async markFixed(runId) {
          const release = await context.ui.dialog.prompt({ title: `Fixora · mark ${runId} fixed`, description: "Release version that ships the fix", placeholder: "3.2.2" })
          if (!release) return
          await rpc["crash.markFixed"]({ runId, release }).then(() => toast.show({ message: `${runId} marked fixed in ${release}`, variant: "success" }), (e: { message?: string }) => toast.show({ message: e.message ?? "failed", variant: "warning" }))
        },
        async copy(text) {
          try {
            const proc = Bun.spawn([process.platform === "darwin" ? "pbcopy" : "xclip"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
            proc.stdin.write(text)
            proc.stdin.end()
            await proc.exited
            toast.show({ message: "Copied", variant: "success", duration: 1200 })
          } catch {
            toast.show({ message: text, variant: "info", duration: 6000 })
          }
        },
        back() {
          context.ui.router.navigate(previous)
        },
      },
    }

    const loadReport = async () => {
      try {
        setStats((await rpc["report.get"]({ days: 30 })) as FunnelStats)
      } catch {
        setStats(undefined)
      }
    }

    // ---------- events → store, toasts, attention ----------
    const unsubscribe: Array<() => void> = []
    const on = (name: string, after?: (data: Record<string, unknown>) => void) =>
      unsubscribe.push(
        rpc.events.on(name, (e) => {
          mutate((d) => void applyEvent(d, name, e.data))
          after?.(e.data)
        }),
      )
    on("run.started", (data) => {
      const sessionID = String(data.sessionID ?? "")
      const route = context.ui.router.current()
      if (prefs.panelAutoOpen && route.type === "session" && route.sessionID === sessionID && !context.ui.panel.current()) context.ui.panel.open(PANEL)
      else toast.show({ message: `Fixora started ${data.runId}`, variant: "info", sessionID })
    })
    on("run.stage")
    on("run.progress")
    on("run.card")
    on("run.awaiting", (data) => {
      const gate = state.gates[String(data.gateId)]
      const sessionID = String(data.sessionID ?? "")
      const route = context.ui.router.current()
      void context.attention.notify({ title: "Fixora", message: `Decision needed: ${data.summary}`, notification: { when: "blurred" }, sound: { name: "question" } })
      if (gate && route.type === "session" && route.sessionID === sessionID) void fx.actions.openGate(gate)
      else toast.show({ title: "Fixora needs a decision", message: String(data.summary ?? ""), variant: "warning", sessionID, duration: 8000 })
    })
    on("run.gate.resolved", (data) => {
      if (data.by === "permission") toast.show({ message: `Fixora: ${data.kind} ${data.decision} via the permission prompt`, variant: "info" })
    })
    on("run.done", (data) => {
      const sessionID = String(data.sessionID ?? "")
      const message = data.mrUrl ? `Draft MR ready · ${String(data.mrUrl)}` : `Run ${data.runId} finished`
      toast.show({ title: "Fixora", message, variant: "success", sessionID, duration: 8000 })
      void context.attention.notify({ title: "Fixora", message, notification: { when: "blurred" }, sound: { name: "done" } })
      void fx.actions.hydrate(String(data.runId))
    })
    on("run.failed", (data) => {
      const sessionID = String(data.sessionID ?? "")
      toast.show({ title: "Fixora", message: `${data.runId}: ${data.status} at ${data.step}${data.error ? ` — ${String(data.error).slice(0, 120)}` : ""}`, variant: data.status === "skipped" ? "warning" : "error", sessionID, duration: 8000 })
      if (data.status !== "skipped") void context.attention.notify({ title: "Fixora", message: `${data.runId} ${data.status}`, notification: { when: "blurred" }, sound: { name: "error" } })
    })
    on("crash.reopened", (data) => toast.show({ title: "Fixora · reopened crash", message: `${data.runId}: seen again after the fix (${data.reason ?? "unknown reason"})`, variant: "warning", duration: 8000 }))

    const ticker = setInterval(() => mutate((d) => void (d.now = Date.now())), 1000)
    void fx.actions.hydrate()

    // ---------- surfaces ----------
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <RunPanel fx={fx} panel={panel} />
        </Show>
      ),
    })
    context.ui.slot({ append: "sidebar.content", render: (p) => <SidebarBadge fx={fx} sessionID={p.sessionID} /> })
    context.ui.slot({ append: "prompt.footer.status", render: () => <FooterChip fx={fx} /> })
    context.ui.slot({ append: "home.footer.status", render: () => <FooterChip fx={fx} /> })
    context.ui.slot({ append: "session.composer.top", render: (p) => <ComposerStrip fx={fx} sessionID={p.sessionID} /> })
    context.ui.router.register({ name: RUNS_ROUTE, render: () => <RunsPage fx={fx} /> })
    context.ui.router.register({ name: REPORT_ROUTE, render: () => <ReportPage fx={fx} stats={stats} reload={() => void loadReport()} /> })

    // ---------- commands ----------
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "fixora.open",
          title: "Fixora: pick a crash to fix",
          description: "List the top crashes from Sentry / Crashlytics and start a fix",
          group: "Fixora",
          palette: true,
          slash: { name: "fixora", aliases: ["fx"], arguments: true },
          async run(input) {
            const { verb, rest } = parseSlash(input)
            const sessionID = currentSession(fx)
            switch (verb) {
              case "":
              case "list":
                return pickCrash(fx, rpc as never)
              case "top": {
                if (!sessionID) return toast.show({ message: "Open a session first", variant: "warning" })
                const n = Math.max(1, Math.min(20, Number(rest) || 1))
                const list = (await rpc["crashes.list"]({ sessionID, top: n * 3 })) as { crashes: Array<{ source: string; id: string; state?: string }> }
                const refs = list.crashes.filter((c) => !c.state || c.state === "new" || c.state === "failed" || c.state === "reopened").slice(0, n).map((c) => `${c.source}:${c.id}`)
                if (refs.length === 0) return toast.show({ message: "No new crashes to fix", variant: "info" })
                return startRuns(fx, rpc, sessionID, refs)
              }
              case "status":
              case "runs":
                if (rest && sessionID) {
                  await fx.actions.hydrate(rest)
                  context.ui.panel.open(PANEL)
                  return
                }
                if (sessionID && state.order.some((id) => state.runs[id]!.sessionID === sessionID) && !rest) {
                  context.ui.panel.open(PANEL)
                  return
                }
                return fx.actions.openRuns()
              case "report":
                return fx.actions.openReport()
              case "feedback": {
                const [runId, ...words] = rest.split(/\s+/)
                if (!runId) return toast.show({ message: "Usage: /fixora feedback <runId> <message>", variant: "warning" })
                return fx.actions.feedback(runId, words.join(" ").replace(/^"|"$/g, "") || undefined)
              }
              case "retry": {
                const [runId, ...flags] = rest.split(/\s+/)
                if (!runId) return toast.show({ message: "Usage: /fixora retry <runId> [--from <step>]", variant: "warning" })
                const from = flags[flags.indexOf("--from") + 1]
                return fx.actions.retry(runId, flags.includes("--from") ? from : undefined)
              }
              case "restart":
                if (!rest) return toast.show({ message: "Usage: /fixora restart <runId>", variant: "warning" })
                return fx.actions.restart(rest.split(/\s+/)[0]!)
              case "cancel":
                if (!rest) return toast.show({ message: "Usage: /fixora cancel <runId>", variant: "warning" })
                return fx.actions.cancel(rest.split(/\s+/)[0]!)
              case "sync":
                return fx.actions.sync()
              case "panel":
                return void (context.ui.panel.current()?.name === PANEL ? context.ui.panel.close() : context.ui.panel.open(PANEL))
              default:
                // fix / paste / fixed / clean / batch / help and raw refs: the server command handles them.
                if (!sessionID) return toast.show({ message: "Open a session first", variant: "warning" })
                await context.client.session.command({ sessionID, name: "fixora", text: input ?? "" } as never)
                setTimeout(() => void fx.actions.hydrate(), 1500)
            }
          },
        },
        { id: "fixora.top", title: "Fixora: fix the top crash now", group: "Fixora", palette: true, run: () => context.keymap.dispatch("fixora.open", "top 1") },
        { id: "fixora.panel", title: "Fixora: toggle run panel", group: "Fixora", palette: true, enabled: () => !!currentSession(fx), run: () => context.keymap.dispatch("fixora.open", "panel") },
        { id: "fixora.runs", title: "Fixora: all runs", group: "Fixora", palette: true, run: () => fx.actions.openRuns() },
        { id: "fixora.report", title: "Fixora: report", group: "Fixora", palette: true, run: () => fx.actions.openReport() },
        {
          id: "fixora.approve",
          title: "Fixora: answer pending approval",
          group: "Fixora",
          palette: true,
          enabled: () => awaitingGates(state).length > 0,
          run: () => {
            const gate: GateView | undefined = awaitingGates(state)[0]
            if (gate) void fx.actions.openGate(gate)
          },
        },
        { id: "fixora.sync", title: "Fixora: sync MR statuses", group: "Fixora", palette: true, run: () => void fx.actions.sync() },
      ],
    }))

    return () => {
      clearInterval(ticker)
      for (const u of unsubscribe) u()
    }
  },
})

export type { RunView }
