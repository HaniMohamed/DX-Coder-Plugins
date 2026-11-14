/** @jsxImportSource @opentui/solid */
// Solid components for the Fixora TUI. Everything renders inside DXcoder's session panel (docked
// next to the conversation, or fullscreen with `f`): the live run view, the runs list and the
// report are views of that one panel. Dialogs (picker, approval) are the host's modal dialogs.

import type { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import type { RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { createMemo, createSignal, For, Show, Switch, Match } from "solid-js"
import type { Store } from "solid-js/store"
import { bar, fmtDuration, fmtPct, sparkline } from "../render.js"
import { awaitingGates, fmtClock, fmtShort, meter, panelRun, relTime, runsForSession, SPINNER, STAGE_TITLES, STATUS_GLYPH, truncate, type GateView, type PanelView, type RunView, type TuiState } from "./store.js"

export interface Fixora {
  context: Plugin.Context
  state: Store<TuiState>
  mutate: (fn: (draft: TuiState) => void) => void
  actions: {
    openGate(gate: GateView): Promise<void>
    approve(gate: GateView): Promise<void>
    reject(gate: GateView, feedback?: string): Promise<void>
    retry(runId: string, from?: string): Promise<void>
    restart(runId: string): Promise<void>
    cancel(runId: string): Promise<void>
    feedback(runId: string, text?: string): Promise<void>
    focusWorker(run: RunView): void
    /** Switches the panel view (and opens the panel when needed). */
    show(view: PanelView, runId?: string): void
    sync(): Promise<void>
    markFixed(runId: string): Promise<void>
    copy(text: string): Promise<void>
    hydrate(runId?: string): Promise<void>
    loadReport(): Promise<void>
  }
}

const STATUS_LABEL: Record<string, string> = { running: "running", "awaiting-approval": "awaiting you", done: "done", failed: "failed", rejected: "rejected", skipped: "skipped", blocked: "blocked", "review-exhausted": "review exhausted", timeout: "timed out", cancelled: "cancelled" }

export function tone(fx: Fixora, status: string) {
  const t = fx.context.theme
  switch (status) {
    case "ok":
    case "done":
      return t.text.feedback.success.base
    case "running":
      return t.hue.accent[200]
    case "awaiting-approval":
      return t.text.feedback.warning.base
    case "failed":
    case "rejected":
    case "blocked":
    case "review-exhausted":
    case "timeout":
      return t.text.feedback.error.base
    default:
      return t.text.muted
  }
}

export const confidenceTone = (fx: Fixora, c: number) => (c >= 0.75 ? fx.context.theme.text.feedback.success.base : c >= 0.5 ? fx.context.theme.text.feedback.warning.base : fx.context.theme.text.feedback.error.base)

const glyphOf = (fx: Fixora, status: string) => (status === "running" ? SPINNER[Math.floor(fx.state.now / 250) % SPINNER.length]! : status === "awaiting-approval" ? "⏸" : status === "done" ? "✓" : status === "skipped" || status === "cancelled" ? "–" : "✗")

/** Inline coloured text: OpenTUI spans take their colour through `style`. */
function S(props: { fg?: RGBA; children?: JSX.Element }) {
  return <span style={{ fg: props.fg }}>{props.children}</span>
}

function Keys(props: { fx: Fixora; items: Array<[string, string]> }) {
  const t = props.fx.context.theme
  return (
    <box flexDirection="row" gap={2} flexWrap="wrap">
      <For each={props.items}>
        {([key, label]) => (
          <text>
            <S fg={t.text.base}>
              <b>{key}</b>
            </S>
            <S fg={t.text.muted}> {label}</S>
          </text>
        )}
      </For>
    </box>
  )
}

function Rule(props: { fx: Fixora; width: number }) {
  return <text fg={props.fx.context.theme.border.base}>{"─".repeat(Math.max(1, props.width))}</text>
}

function Tabs(props: { fx: Fixora }) {
  const t = props.fx.context.theme
  const tab = (view: PanelView, label: string) => (
    <S fg={props.fx.state.view === view ? t.text.base : t.text.muted}>{props.fx.state.view === view ? <b>{label}</b> : label}</S>
  )
  return (
    <text>
      {tab("run", "run")}
      <S fg={t.text.muted}> · </S>
      {tab("runs", "runs")}
      <S fg={t.text.muted}> · </S>
      {tab("report", "report")}
    </text>
  )
}

// ---------- the panel: one host panel, three views ----------

export function FixoraPanel(props: { fx: Fixora; panel: PanelInput }) {
  const fx = props.fx
  const t = fx.context.theme
  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1} backgroundColor={props.panel.presentation === "panel" ? t.background.raised.base : t.background.base}>
      <Switch>
        <Match when={fx.state.view === "runs"}>
          <RunsView fx={fx} panel={props.panel} />
        </Match>
        <Match when={fx.state.view === "report"}>
          <ReportView fx={fx} panel={props.panel} />
        </Match>
        <Match when={true}>
          <RunDetail fx={fx} panel={props.panel} />
        </Match>
      </Switch>
    </box>
  )
}

function RunDetail(props: { fx: Fixora; panel: PanelInput }) {
  const fx = props.fx
  const t = fx.context.theme
  const run = createMemo(() => panelRun(fx.state, props.panel.sessionID))
  const r = () => run()!
  const width = () => Math.max(40, props.panel.width - 2)
  const elapsed = createMemo(() => {
    const x = run()
    if (!x) return ""
    if (x.totalMs !== undefined && x.status === "done") return fmtDuration(x.totalMs)
    if (x.status !== "running" && x.status !== "awaiting-approval") return relTime(x.updatedAt)
    return fmtClock(fx.state.now - x.startedAt)
  })
  const gate = createMemo(() => {
    const x = run()
    return x?.gateId ? fx.state.gates[x.gateId] : undefined
  })

  fx.context.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    commands: [
      {
        bind: "a",
        title: "Answer approval",
        enabled: () => !!gate(),
        run: () => {
          const g = gate()
          if (g) void fx.actions.openGate(g)
        },
      },
      { bind: "r", title: "Retry", enabled: () => !!run() && run()!.status !== "running", run: () => void fx.actions.retry(run()!.runId) },
      { bind: "shift+r", title: "Restart", enabled: () => !!run(), run: () => void fx.actions.restart(run()!.runId) },
      { bind: "c", title: "Cancel", enabled: () => run()?.status === "running", run: () => void fx.actions.cancel(run()!.runId) },
      { bind: "w", title: "Worker session", enabled: () => !!run()?.fixerSessionID, run: () => fx.actions.focusWorker(run()!) },
      { bind: "d", title: "Feedback", enabled: () => !!run() && run()!.status !== "running", run: () => void fx.actions.feedback(run()!.runId) },
      { bind: "y", title: "Copy MR URL", enabled: () => !!run()?.mrUrl, run: () => void fx.actions.copy(run()!.mrUrl!) },
      { bind: "l", title: "All runs", run: () => fx.actions.show("runs") },
      { bind: "g", title: "Report", run: () => fx.actions.show("report") },
      { bind: "f", title: "Fullscreen", run: () => props.panel.toggleFullscreen() },
      { bind: "escape", title: "Close", run: () => props.panel.close() },
    ],
  }))

  return (
    <>
      <box flexDirection="row" justifyContent="space-between">
        <text>
          <S fg={t.text.base}>
            <b>Fixora</b>
          </S>
          <S fg={t.text.muted}> · </S>
          <Tabs fx={fx} />
        </text>
        <Show when={run()}>
          <text fg={t.text.muted}>
            {STATUS_LABEL[r().status] ?? r().status} {elapsed()}
          </text>
        </Show>
      </box>
      <Rule fx={fx} width={width()} />
      <Show when={run()} fallback={<text fg={t.text.muted}>No Fixora run yet. Type /fixora to pick a crash, or /fixora paste {"<file>"} for a stack trace. l lists all runs.</text>}>
        {
          <>
            <text>
              <S fg={tone(fx, r().status)}>{glyphOf(fx, r().status)} </S>
              <S fg={t.text.base}>
                <b>{r().runId}</b>
              </S>
              <S fg={t.text.muted}> · {truncate(r().title, Math.max(10, width() - r().runId.length - 6))}</S>
            </text>
            <scrollbox flexGrow={1} scrollY>
              <box flexDirection="column">
                <For each={r().stages}>
                  {(stage) => {
                    const glyph = () => (stage.status === "running" ? SPINNER[Math.floor(fx.state.now / 250) % SPINNER.length]! : STATUS_GLYPH[stage.status])
                    const right = () => (stage.status === "running" && stage.startedAt ? fmtClock(fx.state.now - stage.startedAt) : fmtShort(stage.durationMs))
                    const detail = () => (stage.status === "running" ? (r().progress ?? stage.detail ?? "") : (stage.detail ?? ""))
                    return (
                      <box flexDirection="row" justifyContent="space-between">
                        <text>
                          <S fg={tone(fx, stage.status)}>{glyph()} </S>
                          <S fg={stage.status === "pending" ? t.text.muted : t.text.base}>{STAGE_TITLES[stage.step].padEnd(18)}</S>
                          <S fg={t.text.muted}>{truncate(detail(), Math.max(8, width() - 30))}</S>
                          <Show when={(stage.attempt ?? 1) > 1}>
                            <S fg={t.text.feedback.warning.base}> ×{stage.attempt}</S>
                          </Show>
                        </text>
                        <text fg={t.text.muted}>{right()}</text>
                      </box>
                    )
                  }}
                </For>
                <Show when={r().rootCause}>
                  <Rule fx={fx} width={width()} />
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={t.text.base}>
                      <b>Root cause</b>
                      <Show when={r().category}>
                        <S fg={t.text.muted}> · {r().category}</S>
                      </Show>
                      <Show when={r().risk}>
                        <S fg={t.text.muted}> · risk {r().risk}</S>
                      </Show>
                    </text>
                    <Show when={r().confidence !== undefined}>
                      <text>
                        <S fg={t.text.muted}>confidence </S>
                        <S fg={confidenceTone(fx, r().confidence!)}>{meter(r().confidence!).filled}</S>
                        <S fg={t.text.muted}>{meter(r().confidence!).empty}</S>
                        <S fg={t.text.base}> {fmtPct(r().confidence!)}</S>
                      </text>
                    </Show>
                  </box>
                  <text fg={t.text.base}>{r().rootCause}</text>
                  <Show when={r().introducedBy}>
                    <text>
                      <S fg={t.text.muted}>Introduced by </S>
                      <S fg={t.text.base}>{r().introducedBy}</S>
                      <S fg={t.text.feedback.warning.base}> REGRESSION</S>
                    </text>
                  </Show>
                  <Show when={r().reopened}>
                    <text fg={t.text.feedback.warning.base}>⚠ Reopened crash — {r().reopened}</text>
                  </Show>
                </Show>
                <Show when={r().files || r().checks || r().review || r().jiraKey}>
                  <Rule fx={fx} width={width()} />
                  <Show when={r().files}>
                    <text>
                      <S fg={t.text.muted}>Diff      </S>
                      <S fg={t.text.base}>{truncate(r().files!.join("  "), width() - 12)}</S>
                      <S fg={t.text.muted}> · {r().files!.length} file(s)</S>
                    </text>
                  </Show>
                  <Show when={r().review}>
                    <text>
                      <S fg={t.text.muted}>Review    </S>
                      <S fg={/reject/.test(r().review!) ? t.text.feedback.error.base : t.text.feedback.success.base}>{r().review}</S>
                    </text>
                  </Show>
                  <Show when={r().checks}>
                    <text>
                      <S fg={t.text.muted}>Checks    </S>
                      <S fg={/✗/.test(r().checks!) ? t.text.feedback.error.base : t.text.feedback.success.base}>{r().checks}</S>
                    </text>
                  </Show>
                  <Show when={r().jiraKey}>
                    <text>
                      <S fg={t.text.muted}>Jira      </S>
                      <S fg={t.text.base}>{r().jiraKey}</S>
                      <Show when={r().jiraUrl}>
                        <S fg={t.text.muted}> {r().jiraUrl}</S>
                      </Show>
                    </text>
                  </Show>
                </Show>
                <Show when={gate()}>
                  <Rule fx={fx} width={width()} />
                  <text>
                    <S fg={t.text.feedback.warning.base}>⏸ Awaiting your decision: </S>
                    <S fg={t.text.base}>{gate()?.summary}</S>
                    <S fg={t.text.muted}> — press a</S>
                  </text>
                </Show>
                <Show when={r().status === "done"}>
                  <Rule fx={fx} width={width()} />
                  <Show when={r().mrUrl} fallback={<text fg={t.text.muted}>No merge request opened (see the report in the session).</text>}>
                    <text>
                      <S fg={t.text.muted}>MR      </S>
                      <S fg={t.text.feedback.success.base}>{r().mrUrl}</S>
                      <S fg={t.text.muted}> {r().mrStatus ?? ""}</S>
                    </text>
                  </Show>
                  <Show when={r().branch}>
                    <text>
                      <S fg={t.text.muted}>Branch  </S>
                      <S fg={t.text.base}>{r().branch}</S>
                    </text>
                  </Show>
                  <text fg={t.text.muted}>Next: d feedback · /fixora fixed {r().runId} --release X</text>
                </Show>
                <Show when={r().error}>
                  <Rule fx={fx} width={width()} />
                  <text fg={t.text.feedback.error.base}>{truncate(r().error, width() * 3)}</text>
                </Show>
              </box>
            </scrollbox>
          </>
        }
      </Show>
      <Rule fx={fx} width={width()} />
      <Keys fx={fx} items={[...(gate() ? [["a", "answer"] as [string, string]] : []), ["r", "retry"], ["R", "restart"], ["c", "cancel"], ["w", "worker"], ["d", "feedback"], ["y", "copy MR"], ["l", "runs"], ["g", "report"], ["f", "full"], ["esc", "close"]]} />
    </>
  )
}

// ---------- runs view ----------

function RunsView(props: { fx: Fixora; panel: PanelInput }) {
  const fx = props.fx
  const t = fx.context.theme
  const width = () => Math.max(40, props.panel.width - 2)
  const runs = createMemo(() => fx.state.order.map((id) => fx.state.runs[id]!))
  const cursor = () => Math.min(fx.state.cursor, Math.max(0, runs().length - 1))
  const move = (delta: number) => fx.mutate((d) => void (d.cursor = Math.max(0, Math.min(runs().length - 1, cursor() + delta))))
  const selected = () => runs()[cursor()]
  const counts = createMemo(() => ({ running: runs().filter((r) => r.status === "running").length, awaiting: runs().filter((r) => r.status === "awaiting-approval").length, done: runs().filter((r) => r.status === "done").length }))

  fx.context.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    commands: [
      { bind: "escape", title: "Back", run: () => fx.actions.show("run") },
      { bind: "down,j", run: () => move(1) },
      { bind: "up,k", run: () => move(-1) },
      { bind: "return", title: "Show run", enabled: () => !!selected(), run: () => fx.actions.show("run", selected()!.runId) },
      {
        bind: "a",
        title: "Answer approval",
        enabled: () => !!selected()?.gateId,
        run: () => {
          const g = selected()?.gateId ? fx.state.gates[selected()!.gateId!] : undefined
          if (g) void fx.actions.openGate(g)
        },
      },
      { bind: "r", title: "Retry", enabled: () => !!selected() && selected()!.status !== "running", run: () => void fx.actions.retry(selected()!.runId) },
      { bind: "shift+r", title: "Restart", enabled: () => !!selected(), run: () => void fx.actions.restart(selected()!.runId) },
      { bind: "x", title: "Cancel", enabled: () => selected()?.status === "running", run: () => void fx.actions.cancel(selected()!.runId) },
      { bind: "m", title: "Mark fixed", enabled: () => !!selected(), run: () => void fx.actions.markFixed(selected()!.runId) },
      { bind: "s", title: "Sync MRs", run: () => void fx.actions.sync() },
      { bind: "g", title: "Report", run: () => fx.actions.show("report") },
      { bind: "f", title: "Fullscreen", run: () => props.panel.toggleFullscreen() },
    ],
  }))

  return (
    <>
      <box flexDirection="row" justifyContent="space-between">
        <text>
          <S fg={t.text.base}>
            <b>Fixora</b>
          </S>
          <S fg={t.text.muted}> · </S>
          <Tabs fx={fx} />
        </text>
        <text fg={t.text.muted}>
          {counts().running} running · {counts().awaiting} awaiting you · {counts().done} done
        </text>
      </box>
      <Rule fx={fx} width={width()} />
      <scrollbox flexGrow={1} scrollY>
        <box flexDirection="column">
          <Show when={runs().length === 0}>
            <text fg={t.text.muted}>No runs yet. /fixora picks a crash, /fixora paste {"<file>"} fixes a pasted trace.</text>
          </Show>
          <For each={runs()}>
            {(r, i) => (
              <box flexDirection="row" justifyContent="space-between" backgroundColor={i() === cursor() ? t.background.raised.high : undefined}>
                <text>
                  <S fg={t.text.muted}>{i() === cursor() ? "▸ " : "  "}</S>
                  <S fg={tone(fx, r.status)}>{glyphOf(fx, r.status)} </S>
                  <S fg={t.text.base}>{truncate(r.runId, 24).padEnd(25)}</S>
                  <S fg={tone(fx, r.status)}>{(STATUS_LABEL[r.status] ?? r.status).padEnd(16)}</S>
                  <S fg={t.text.muted}>{(STAGE_TITLES[r.step] ?? r.step).padEnd(16)}</S>
                  <S fg={t.text.base}>{truncate(r.title, Math.max(10, width() - 90))}</S>
                </text>
                <text fg={t.text.muted}>
                  {r.mrUrl ? `MR ${r.mrStatus ?? "open"}  ` : ""}
                  {r.jiraKey ? `${r.jiraKey}  ` : ""}
                  {relTime(r.updatedAt)}
                </text>
              </box>
            )}
          </For>
        </box>
      </scrollbox>
      <Rule fx={fx} width={width()} />
      <Keys fx={fx} items={[["↑↓", "select"], ["enter", "show"], ["a", "answer"], ["r", "retry"], ["R", "restart"], ["x", "cancel"], ["m", "mark fixed"], ["s", "sync MRs"], ["g", "report"], ["esc", "back"]]} />
    </>
  )
}

// ---------- report view ----------

function ReportView(props: { fx: Fixora; panel: PanelInput }) {
  const fx = props.fx
  const t = fx.context.theme
  const width = () => Math.max(40, props.panel.width - 2)
  const s = () => fx.state.report!
  fx.context.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    commands: [
      { bind: "escape", title: "Back", run: () => fx.actions.show("run") },
      { bind: "s", title: "Sync MRs", run: () => void fx.actions.sync().then(() => fx.actions.loadReport()) },
      { bind: "l", title: "Runs", run: () => fx.actions.show("runs") },
      { bind: "f", title: "Fullscreen", run: () => props.panel.toggleFullscreen() },
    ],
  }))
  const max = () => Math.max(1, ...(fx.state.report?.funnel.map((f) => f.count) ?? [1]))
  const barWidth = () => Math.max(8, Math.min(24, width() - 36))
  return (
    <>
      <box flexDirection="row" justifyContent="space-between">
        <text>
          <S fg={t.text.base}>
            <b>Fixora</b>
          </S>
          <S fg={t.text.muted}> · </S>
          <Tabs fx={fx} />
        </text>
        <text fg={t.text.muted}>
          last {fx.state.report?.days ?? 30} days · {fx.state.report?.total ?? 0} run(s)
        </text>
      </box>
      <Rule fx={fx} width={width()} />
      <Show when={fx.state.report} fallback={<text fg={t.text.muted}>Loading…</text>}>
        {
          <scrollbox flexGrow={1} scrollY>
            <box flexDirection="column" gap={1}>
              <box flexDirection="column">
                <For each={s().funnel}>
                  {(f) => (
                    <text>
                      <S fg={t.text.base}>{f.stage.padEnd(16)}</S>
                      <S fg={t.hue.accent[200]}>{bar(f.count, max(), barWidth())}</S>
                      <S fg={t.text.base}>{String(f.count).padStart(4)}</S>
                      <S fg={t.text.muted}> {fmtPct(f.rate).padStart(4)}</S>
                    </text>
                  )}
                </For>
              </box>
              <box flexDirection="column">
                <text>
                  <S fg={t.text.muted}>Trend  created </S>
                  <S fg={t.categorical[0]![200]}>{sparkline(s().daily.map((d) => d.created))}</S>
                  <S fg={t.text.base}> {s().daily.reduce((a, d) => a + d.created, 0)}</S>
                </text>
                <text>
                  <S fg={t.text.muted}>       done    </S>
                  <S fg={t.text.feedback.success.base}>{sparkline(s().daily.map((d) => d.completed))}</S>
                  <S fg={t.text.base}> {s().daily.reduce((a, d) => a + d.completed, 0)}</S>
                </text>
                <text>
                  <S fg={t.text.muted}>       failed  </S>
                  <S fg={t.text.feedback.error.base}>{sparkline(s().daily.map((d) => d.failed))}</S>
                  <S fg={t.text.base}> {s().daily.reduce((a, d) => a + d.failed, 0)}</S>
                </text>
              </box>
              <box flexDirection="column">
                <text fg={t.text.base}>
                  <S fg={t.text.muted}>Timing   </S>avg {fmtDuration(s().timing.avgMs)} · p90 {fmtDuration(s().timing.p90Ms)} · fastest {fmtDuration(s().timing.minMs)}
                </text>
                <text fg={t.text.base}>
                  <S fg={t.text.muted}>MRs      </S>
                  {s().mrs.opened} opened · {s().mrs.merged} merged · {s().mrs.closed} closed · {s().mrs.pending} pending
                </text>
                <text fg={t.text.base}>
                  <S fg={t.text.muted}>Releases </S>
                  {s().releases.fixed} fixed · {s().releases.reopened} reopened ({fmtPct(s().releases.reopenRate)})
                </text>
                <Show when={s().top.platforms.length}>
                  <text fg={t.text.base}>
                    <S fg={t.text.muted}>Top      </S>
                    {truncate([...s().top.platforms, ...s().top.versions].map(([k, v]) => `${k} ${v}`).join(" · "), width() - 10)}
                  </text>
                </Show>
              </box>
              <box flexDirection="column">
                <text fg={t.text.muted}>Recent</text>
                <For each={s().recent}>
                  {(r) => (
                    <text>
                      <S fg={tone(fx, r.status)}>{glyphOf(fx, r.status)} </S>
                      <S fg={t.text.base}>{truncate(r.runId, 24).padEnd(25)}</S>
                      <S fg={t.text.muted}>{truncate(r.title, Math.max(10, width() - 36))}</S>
                      <S fg={t.text.muted}>{r.mrUrl ? "  MR" : ""}</S>
                    </text>
                  )}
                </For>
              </box>
            </box>
          </scrollbox>
        }
      </Show>
      <Rule fx={fx} width={width()} />
      <Keys fx={fx} items={[["s", "sync MRs"], ["l", "runs"], ["f", "full"], ["esc", "back"]]} />
    </>
  )
}

// ---------- approval dialog ----------

export function GateDialog(props: { fx: Fixora; gate: GateView }) {
  const fx = props.fx
  const t = fx.context.theme.surface("dialog")
  const p = () => props.gate.preview
  const [full, setFull] = createSignal(false)
  const run = () => fx.state.runs[props.gate.runId]
  const body = () => (p().mrBody ?? "").split("\n")
  const title = () => (props.gate.kind === "ticket" ? "Create Jira ticket" : props.gate.kind === "mr" ? "Open merge request" : props.gate.kind === "push" ? "Push branch" : "Publish fix")

  fx.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      { bind: "a", title: "Approve", run: () => void fx.actions.approve(props.gate) },
      { bind: "r", title: "Reject with feedback", run: () => void fx.actions.reject(props.gate) },
      {
        bind: "v",
        title: "Toggle full MR body",
        enabled: () => !!p().mrBody,
        run: () => {
          setFull((v) => !v)
        },
      },
    ],
  }))

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} gap={1}>
      <text fg={t.text.base}>
        <b>Fixora · {title()}</b>
        <S fg={t.text.muted}> · {props.gate.runId}</S>
      </text>
      <text fg={t.text.base}>{run()?.title ?? ""}</text>
      <box flexDirection="column">
        <Show when={props.gate.kind === "ticket"}>
          <text>
            <S fg={t.text.muted}>Jira      </S>
            <S fg={t.text.base}>
              {p().jira?.issueType ?? "Bug"} in {p().jira?.project ?? "?"}: {p().jira?.summary ?? ""}
            </S>
          </text>
        </Show>
        <Show when={p().branch}>
          <text>
            <S fg={t.text.muted}>Branch    </S>
            <S fg={t.text.base}>{p().branch}</S>
            <S fg={t.text.muted}>
              {" "}
              → {p().remote ?? ""} {p().target ? `(target ${p().target})` : ""}
            </S>
          </text>
        </Show>
        <Show when={p().files?.length}>
          <text>
            <S fg={t.text.muted}>Files     </S>
            <S fg={t.text.base}>{p().files!.join("  ")}</S>
            <S fg={t.text.muted}>
              {" "}
              · {p().files!.length} file(s){p().additions !== undefined ? ` · +${p().additions} −${p().deletions ?? 0}` : ""}
            </S>
          </text>
        </Show>
        <Show when={p().checks}>
          <text>
            <S fg={t.text.muted}>Checks    </S>
            <S fg={/✗/.test(p().checks!) ? t.text.feedback.error.base : t.text.feedback.success.base}>{p().checks}</S>
          </text>
        </Show>
        <Show when={p().review}>
          <text>
            <S fg={t.text.muted}>Review    </S>
            <S fg={/reject/.test(p().review!) ? t.text.feedback.error.base : t.text.feedback.success.base}>{p().review}</S>
          </text>
        </Show>
        <Show when={p().confidence !== undefined}>
          <text>
            <S fg={t.text.muted}>Confidence </S>
            <S fg={confidenceTone(fx, p().confidence!)}>{meter(p().confidence!).filled}</S>
            <S fg={t.text.muted}>{meter(p().confidence!).empty}</S>
            <S fg={t.text.base}> {fmtPct(p().confidence!)}</S>
            <Show when={p().risk}>
              <S fg={t.text.muted}> · risk {p().risk}</S>
            </Show>
          </text>
        </Show>
        <Show when={p().jiraKey}>
          <text>
            <S fg={t.text.muted}>Jira      </S>
            <S fg={t.text.base}>{p().jiraKey}</S>
          </text>
        </Show>
        <Show when={p().mrTitle}>
          <text>
            <S fg={t.text.muted}>MR title  </S>
            <S fg={t.text.base}>{p().mrTitle}</S>
            <S fg={t.text.muted}> via {p().mrProvider ?? "?"}</S>
          </text>
        </Show>
      </box>
      <Show when={p().rootCause}>
        <box flexDirection="column" border borderColor={t.border.base} paddingLeft={1} paddingRight={1}>
          <text fg={t.text.muted}>Root cause</text>
          <text fg={t.text.base}>{p().rootCause}</text>
        </box>
      </Show>
      <Show when={p().mrBody}>
        <scrollbox height={full() ? 24 : 8} scrollY border borderColor={t.border.base} paddingLeft={1} paddingRight={1}>
          <box flexDirection="column">
            <For each={full() ? body() : body().slice(0, 12)}>{(line) => <text fg={/^#/.test(line) ? t.text.base : t.text.muted}>{line || " "}</text>}</For>
            <Show when={!full() && body().length > 12}>
              <text fg={t.text.muted}>… v for the full body</text>
            </Show>
          </box>
        </scrollbox>
      </Show>
      <Keys fx={fx} items={[["a", props.gate.kind === "ticket" ? "create ticket" : "approve"], ["r", "reject with feedback"], ...(p().mrBody ? [["v", "full MR body"] as [string, string]] : []), ["esc", "decide later"]]} />
    </box>
  )
}

// ---------- small surfaces ----------

export function SidebarBadge(props: { fx: Fixora; sessionID: string }) {
  const fx = props.fx
  const t = fx.context.theme
  const runs = createMemo(() => runsForSession(fx.state, props.sessionID))
  return (
    <Show when={runs().length > 0}>
      <box flexDirection="column">
        <text fg={t.text.base}>
          <b>Fixora</b>
        </text>
        <For each={runs().slice(0, 3)}>
          {(r) => (
            <text>
              <S fg={tone(fx, r.status)}>{glyphOf(fx, r.status)} </S>
              <S fg={t.text.muted}>
                {STAGE_TITLES[r.step] ?? r.step}
                {r.status === "running" ? ` ${fmtClock(fx.state.now - r.startedAt)}` : r.status === "awaiting-approval" ? " · needs you" : ""}
              </S>
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

export function FooterChip(props: { fx: Fixora }) {
  const fx = props.fx
  const t = fx.context.theme
  const running = createMemo(() => fx.state.order.filter((id) => fx.state.runs[id]!.status === "running").length)
  const awaiting = createMemo(() => awaitingGates(fx.state).length)
  return (
    <Show when={running() + awaiting() > 0}>
      <box flexShrink={0}>
        <text>
          <S fg={t.text.muted}>fixora </S>
          <Show when={running() > 0}>
            <S fg={t.hue.accent[200]}>◐{running()} </S>
          </Show>
          <Show when={awaiting() > 0}>
            <S fg={t.text.feedback.warning.base}>⏸{awaiting()}</S>
          </Show>
        </text>
      </box>
    </Show>
  )
}

export function ComposerStrip(props: { fx: Fixora; sessionID: string }) {
  const fx = props.fx
  const t = fx.context.theme
  const gate = createMemo(() => awaitingGates(fx.state).find((g) => g.sessionID === props.sessionID))
  return (
    <Show when={gate()}>
      <box paddingLeft={1}>
        <text>
          <S fg={t.text.feedback.warning.base}>
            ⏸ Fixora needs a decision on {gate()?.runId}: {gate()?.summary}
          </S>
          <S fg={t.text.muted}> — /fixora panel then a, or the palette command "Fixora: answer pending approval"</S>
        </text>
      </box>
    </Show>
  )
}
