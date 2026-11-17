/** @jsxImportSource @opentui/solid */
// Solid components for the Fixora TUI. Everything renders inside DXcoder's session panel (docked
// next to the conversation, or fullscreen with `f`): the crashes list, the live run view, the
// runs list and the report are views of that one panel. Dialogs (picker, approval) are the host's
// modal dialogs. Layout decisions are pure (format.ts); these components only pad and colour.

import type { PanelInput } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, For, Show, Switch, Match } from "solid-js"
import { bar, fmtDuration, fmtPct, sparkline } from "../render.js"
import type { FunnelStats } from "../state.js"
import { awaitingGates, clampCursor, fmtClock, meter, panelRun, relTime, runsForSession, STAGE_TITLES, truncate, type GateView, type RunView } from "./store.js"
import { breakpoint, confidenceToneKey, counterLine, crashBusy, crashGlyph, crashImpact, crashMeta, crashSubline, crashTally, crashTone, crashesLayout, fixBadge, groupCrashes, groupRuns, isActive, padDisplay, progressOf, runLinks, runsLayout, sortCrashes, sourceLabel, stageTitle, STATUS_LABEL, STATUS_SHORT, statusTone, wrap } from "./format.js"
import { Card, Chip, color, Empty, Header, Keys, Link, Progress, Row, Rule, S, spinner, Timeline, type Fixora } from "./ui.js"

export type { Fixora } from "./ui.js"

/** Colour of a run status (kept for callers outside this file). */
export const tone = (fx: Fixora, status: string) => color(fx, statusTone(status))
export const confidenceTone = (fx: Fixora, c: number) => color(fx, confidenceToneKey(c))

const glyphOf = (fx: Fixora, status: string) => (status === "running" ? spinner(fx) : status === "awaiting-approval" ? "⏸" : status === "done" ? "✓" : status === "skipped" || status === "cancelled" ? "–" : "✗")

const panelWidth = (panel: PanelInput) => Math.max(40, panel.width - 2)

// ---------- the panel: one host panel, four views ----------

export function FixoraPanel(props: { fx: Fixora; panel: PanelInput }) {
  const fx = props.fx
  const t = fx.context.theme
  return (
    <box width="100%" height="100%" flexDirection="column" minHeight={0} paddingLeft={1} paddingRight={1} backgroundColor={props.panel.presentation === "panel" ? t.background.raised.base : t.background.base}>
      <Switch>
        <Match when={fx.state.view === "crashes"}>
          <CrashesView fx={fx} panel={props.panel} />
        </Match>
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

// ---------- run view: the pipeline as cards ----------

function RunDetail(props: { fx: Fixora; panel: PanelInput }) {
  const fx = props.fx
  const t = fx.context.theme
  const run = createMemo(() => panelRun(fx.state, props.panel.sessionID))
  const r = () => run()!
  const width = () => panelWidth(props.panel)
  /** Columns inside a card (border + padding on both sides). */
  const inner = () => width() - 4
  const elapsed = createMemo(() => {
    const x = run()
    if (!x) return ""
    if (x.totalMs !== undefined && x.status === "done") return fmtDuration(x.totalMs)
    if (!isActive(x.status)) return relTime(x.updatedAt, fx.state.now)
    return fmtClock(fx.state.now - x.startedAt)
  })
  const gate = createMemo(() => {
    const x = run()
    return x?.gateId ? fx.state.gates[x.gateId] : undefined
  })
  const progress = createMemo(() => progressOf(run()?.stages ?? []))
  const collapsed = () => !!run() && r().status === "running" && !fx.state.expandStages && props.panel.presentation === "panel"
  const liveStage = () => r().stages.find((s) => s.status === "running")
  const activity = () => (r().activity ?? []).slice(-(props.panel.presentation === "panel" ? 4 : 8))
  const checks = () => (r().checks ?? "").split(" · ").filter(Boolean)

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
      { bind: "e", title: "Expand / fold finished stages", enabled: () => run()?.status === "running", run: () => fx.mutate((d) => void (d.expandStages = !d.expandStages)) },
      { bind: "shift+c", title: "Crashes", run: () => fx.actions.show("crashes") },
      { bind: "l", title: "All runs", run: () => fx.actions.show("runs") },
      { bind: "g", title: "Report", run: () => fx.actions.show("report") },
      { bind: "f", title: "Fullscreen", run: () => props.panel.toggleFullscreen() },
      { bind: "escape", title: "Close", run: () => props.panel.close() },
    ],
  }))

  return (
    <>
      <Header fx={fx} right={run() ? `${STATUS_LABEL[r().status] ?? r().status} ${elapsed()}` : undefined} />
      <Rule fx={fx} width={width()} />
      <Show when={run()} fallback={<Empty fx={fx} text="No Fixora run yet." hint="C lists crashes to fix · /fixora picks one · /fixora paste <file> fixes a stack trace · l lists all runs" />}>
        {
          <scrollbox flexGrow={1} minHeight={0} scrollY>
            <box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1}>
              <Card fx={fx} title={r().runId} tone={statusTone(r().status)}>
                <text wrapMode="none">
                  <S fg={tone(fx, r().status)}>{glyphOf(fx, r().status)} </S>
                  <Chip fx={fx} tone={statusTone(r().status)} label={STATUS_LABEL[r().status] ?? r().status} />
                  <S fg={t.text.muted}> · </S>
                  <S fg={t.text.base}>{truncate(r().title, Math.max(8, inner() - (STATUS_LABEL[r().status] ?? r().status).length - 5))}</S>
                </text>
                <text wrapMode="none">
                  <Progress fx={fx} done={progress().done} total={progress().total} width={Math.min(20, Math.max(6, inner() - 26))} />
                  <S fg={t.text.muted}>{` · ${r().status === "done" ? "done" : progress().current ? stageTitle(progress().current!, width()) : STAGE_TITLES[r().step]} · ${elapsed()}`}</S>
                </text>
                <Show when={counterLine(r().counters)}>
                  <text fg={t.text.muted} wrapMode="none">
                    {counterLine(r().counters)}
                  </text>
                </Show>
              </Card>
              <Show when={gate()}>
                <Card fx={fx} title="Decision needed" tone="warning">
                  <For each={wrap(`⏸ ${gate()?.summary ?? ""}`, inner(), 3)}>{(line) => <text fg={t.text.base}>{line}</text>}</For>
                  <text fg={t.text.muted}>press a to answer</text>
                </Card>
              </Show>
              <Card fx={fx} title={collapsed() ? "Pipeline · e expands" : "Pipeline"}>
                <Timeline fx={fx} stages={r().stages} progress={r().progress} width={inner()} collapsed={collapsed()} />
              </Card>
              <Show when={r().status === "running" && activity().length > 0}>
                <Card fx={fx} title="Live" tone="accent">
                  <text wrapMode="none">
                    <S fg={t.hue.accent[200]}>{spinner(fx)} </S>
                    <S fg={t.text.base}>
                      <b>{stageTitle(liveStage()?.step ?? r().step, width())}</b>
                    </S>
                    <S fg={t.text.muted}> · {fmtClock(fx.state.now - (liveStage()?.startedAt ?? r().startedAt))}</S>
                  </text>
                  <For each={activity()}>{(line, i) => <text fg={i() === activity().length - 1 ? t.text.base : t.text.muted} wrapMode="none">{truncate(line, inner())}</text>}</For>
                </Card>
              </Show>
              <Show when={r().rootCause}>
                <Card fx={fx} title={["Root cause", r().category, r().risk ? `risk ${r().risk}` : undefined].filter(Boolean).join(" · ")}>
                  <Show when={r().confidence !== undefined}>
                    <Row fx={fx} label="Confidence" labelWidth={11}>
                      <S fg={confidenceTone(fx, r().confidence!)}>{meter(r().confidence!).filled}</S>
                      <S fg={t.text.muted}>{meter(r().confidence!).empty}</S>
                      <S fg={t.text.base}> {fmtPct(r().confidence!)}</S>
                    </Row>
                  </Show>
                  <For each={wrap(r().rootCause, inner(), props.panel.presentation === "panel" ? 4 : 10)}>{(line) => <text fg={t.text.base}>{line}</text>}</For>
                  <Show when={r().introducedBy}>
                    <Row fx={fx} label="Introduced" labelWidth={11}>
                      <S fg={t.text.base}>{truncate(r().introducedBy, Math.max(8, inner() - 23))}</S>
                      <S fg={t.text.feedback.warning.base}> REGRESSION</S>
                    </Row>
                  </Show>
                  <Show when={r().reopened}>
                    <text fg={t.text.feedback.warning.base} wrapMode="none">
                      {truncate(`⚠ Reopened crash — ${r().reopened}`, inner())}
                    </text>
                  </Show>
                </Card>
              </Show>
              <Show when={r().files || r().checks || r().review}>
                <Card fx={fx} title="Validation">
                  <Show when={r().files}>
                    <Row fx={fx} label="Diff">
                      <S fg={t.text.base}>{`${r().files!.length} file(s)`}</S>
                      <S fg={t.text.muted}> · {truncate(r().files!.join("  "), Math.max(8, inner() - 24))}</S>
                    </Row>
                  </Show>
                  <Show when={r().checks}>
                    <Row fx={fx} label="Checks">
                      {checks().map((c, i) => (
                        <S fg={/✗/.test(c) ? t.text.feedback.error.base : t.text.feedback.success.base}>{`${i > 0 ? " · " : ""}${c}`}</S>
                      ))}
                    </Row>
                  </Show>
                  <Show when={r().review}>
                    <Row fx={fx} label="Review">
                      <S fg={/reject/.test(r().review!) ? t.text.feedback.error.base : t.text.feedback.success.base}>{r().review}</S>
                    </Row>
                  </Show>
                </Card>
              </Show>
              <Show when={r().status === "done" || r().jiraKey}>
                <Card fx={fx} title={r().status === "done" ? "Result" : "Ticket"} tone={r().status === "done" ? "success" : undefined}>
                  <Show when={r().jiraKey}>
                    <Row fx={fx} label="Jira">
                      <S fg={t.text.base}>{r().jiraKey}</S>
                      <Show when={r().jiraUrl}>
                        <S fg={t.text.muted}> </S>
                        <Link href={r().jiraUrl!} fg={t.text.muted}>
                          {truncate(r().jiraUrl, Math.max(8, inner() - 12 - (r().jiraKey?.length ?? 0)))}
                        </Link>
                      </Show>
                    </Row>
                  </Show>
                  <Show when={r().status === "done"}>
                    <Show when={r().mrUrl} fallback={<text fg={t.text.muted}>No merge request opened (see the report in the session).</text>}>
                      <Row fx={fx} label="MR">
                        <Link href={r().mrUrl!} fg={t.text.feedback.success.base}>
                          {truncate(r().mrUrl, Math.max(8, inner() - 20))}
                        </Link>
                        <S fg={t.text.muted}> {r().mrStatus ?? ""}</S>
                      </Row>
                    </Show>
                    <Show when={r().branch}>
                      <Row fx={fx} label="Branch">
                        <S fg={t.text.base}>{truncate(r().branch, Math.max(8, inner() - 11))}</S>
                      </Row>
                    </Show>
                    <text fg={t.text.muted} wrapMode="none">
                      {truncate(`Next: d feedback · y copy MR · /fixora fixed ${r().runId} --release X`, inner())}
                    </text>
                  </Show>
                </Card>
              </Show>
              <Show when={r().error}>
                <Card fx={fx} title={STATUS_LABEL[r().status] ?? "Error"} tone="error">
                  <For each={wrap(r().error, inner(), 6)}>{(line) => <text fg={t.text.feedback.error.base}>{line}</text>}</For>
                  <Show when={r().status !== "running"}>
                    <text fg={t.text.muted}>r retries from the failed stage · R restarts on a fresh branch</text>
                  </Show>
                </Card>
              </Show>
            </box>
          </scrollbox>
        }
      </Show>
      <Rule fx={fx} width={width()} />
      <Keys fx={fx} items={[...(gate() ? [["a", "answer"] as [string, string]] : []), ["r", "retry"], ["R", "restart"], ["c", "cancel"], ["w", "worker"], ["d", "feedback"], ["y", "copy MR"], ...(collapsed() ? [["e", "stages"] as [string, string]] : []), ["C", "crashes"], ["l", "runs"], ["g", "report"], ["f", "full"], ["esc", "close"]]} />
    </>
  )
}

// ---------- runs view ----------

function RunsView(props: { fx: Fixora; panel: PanelInput }) {
  const fx = props.fx
  const t = fx.context.theme
  const width = () => panelWidth(props.panel)
  const layout = createMemo(() => runsLayout(width()))
  const runs = createMemo(() => fx.state.order.map((id) => fx.state.runs[id]!))
  const groups = createMemo(() => groupRuns(runs()))
  const flat = createMemo(() => groups().flatMap((g) => g.rows))
  const cursor = () => clampCursor(fx.state.cursor, flat().length)
  const move = (delta: number) => fx.mutate((d) => void (d.cursor = clampCursor(cursor() + delta, flat().length)))
  const selected = () => flat()[cursor()]
  const counts = createMemo(() => ({ running: runs().filter((r) => r.status === "running").length, awaiting: runs().filter((r) => r.status === "awaiting-approval").length, done: runs().filter((r) => r.status === "done").length }))
  const right = () => (breakpoint(width()) === "narrow" ? `◐${counts().running} ⏸${counts().awaiting} ✓${counts().done}` : `${counts().running} running · ${counts().awaiting} awaiting you · ${counts().done} done`)

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
      { bind: "y", title: "Copy MR URL", enabled: () => !!selected()?.mrUrl, run: () => void fx.actions.copy(selected()!.mrUrl!) },
      { bind: "s", title: "Sync MRs", run: () => void fx.actions.sync() },
      { bind: "u", title: "Recover runs from MRs", run: () => void fx.actions.recover() },
      { bind: "shift+c", title: "Crashes", run: () => fx.actions.show("crashes") },
      { bind: "g", title: "Report", run: () => fx.actions.show("report") },
      { bind: "f", title: "Fullscreen", run: () => props.panel.toggleFullscreen() },
    ],
  }))

  const RunRow = (p: { r: RunView }) => {
    const r = p.r
    const i = () => flat().indexOf(r)
    const sel = () => i() === cursor()
    const L = layout
    const prog = () => progressOf(r.stages)
    return (
      <box flexDirection="row" backgroundColor={sel() ? t.background.raised.high : undefined}>
        <text wrapMode="none">
          <S fg={t.text.muted}>{sel() ? "▸ " : "  "}</S>
          <S fg={tone(fx, r.status)}>{glyphOf(fx, r.status)} </S>
          <Chip fx={fx} tone={statusTone(r.status)} label={(breakpoint(width()) === "wide" ? STATUS_LABEL[r.status] : STATUS_SHORT[r.status]) ?? r.status} width={L().chip} />
          <S fg={sel() ? t.text.base : t.text.base}> {padDisplay(r.title, L().title!)}</S>
          <Show when={L().progress}>
            <S fg={r.status === "running" ? t.hue.accent[200] : t.text.muted}> {padDisplay(isActive(r.status) ? `${prog().done}/${prog().total}` : "", L().progress!, "right")}</S>
          </Show>
          <Show when={L().stage}>
            <S fg={t.text.muted}> {padDisplay(r.status === "done" ? "" : stageTitle(r.step, L().stage! >= 18 ? 70 : 0), L().stage!)}</S>
          </Show>
          <Show when={L().links}>
            <S fg={r.mrUrl ? t.text.feedback.success.base : t.text.muted}> {padDisplay(runLinks(r), L().links!)}</S>
          </Show>
          <Show when={L().age}>
            <S fg={t.text.muted}> {padDisplay(relTime(r.updatedAt, fx.state.now), L().age!, "right")}</S>
          </Show>
        </text>
      </box>
    )
  }

  return (
    <>
      <Header fx={fx} right={right()} />
      <Rule fx={fx} width={width()} />
      <scrollbox flexGrow={1} minHeight={0} scrollY>
        <box flexDirection="column">
          <Show when={runs().length === 0}>
            <Empty fx={fx} text="No runs yet." hint="C lists crashes to fix · /fixora picks one · /fixora paste <file> fixes a pasted trace" />
          </Show>
          <For each={groups()}>
            {(g) => (
              <box flexDirection="column" paddingTop={1}>
                <text wrapMode="none">
                  <S fg={t.text.base}>
                    <b>{g.label}</b>
                  </S>
                  <S fg={t.text.muted}> ({g.rows.length})</S>
                </text>
                <For each={g.rows}>{(r) => <RunRow r={r} />}</For>
              </box>
            )}
          </For>
        </box>
      </scrollbox>
      <Rule fx={fx} width={width()} />
      <Keys fx={fx} items={[["↑↓", "select"], ["enter", "show"], ["a", "answer"], ["r", "retry"], ["R", "restart"], ["x", "cancel"], ["m", "mark fixed"], ["y", "copy MR"], ["s", "sync MRs"], ["u", "recover"], ["C", "crashes"], ["g", "report"], ["esc", "back"]]} />
    </>
  )
}

// ---------- crashes view ----------

function CrashesView(props: { fx: Fixora; panel: PanelInput }) {
  const fx = props.fx
  const t = fx.context.theme
  const width = () => panelWidth(props.panel)
  const layout = createMemo(() => crashesLayout(width()))
  const sorted = createMemo(() => sortCrashes(fx.state.crashes, fx.state.crashSort))
  const groups = createMemo(() => groupCrashes(sorted(), fx.state.crashSort))
  const flat = createMemo(() => groups().flatMap((g) => g.rows))
  const cursor = () => clampCursor(fx.state.crashCursor, flat().length)
  const move = (delta: number) => fx.mutate((d) => void (d.crashCursor = clampCursor(cursor() + delta, flat().length)))
  const selected = () => flat()[cursor()]
  const tally = createMemo(() => crashTally(fx.state.crashes))
  const narrow = () => breakpoint(width()) === "narrow"
  const status = createMemo(() => {
    const srcs = fx.state.sources.filter((s) => s.id === "sentry" || s.id === "crashlytics")
    const connected = srcs.filter((s) => s.status === "connected").length
    const n = tally()
    const counts = narrow() ? [`${n.new} new`, n.reopened ? `${n.reopened} back` : "", `${n.fixed} fixed`, n.inProgress ? `${n.inProgress} busy` : ""] : [`${n.new} new`, n.reopened ? `${n.reopened} came back` : "", n.failed ? `${n.failed} failed` : "", `${n.fixed} fixed`, n.inProgress ? `${n.inProgress} in progress` : ""]
    const head = narrow() ? `${connected} src` : srcs.map((s) => `${sourceLabel[s.id] ?? s.id} ${s.status === "connected" ? "✓" : "✗"}`).join(" · ") || "no sources"
    return [head, ...counts.filter(Boolean)].join(" · ")
  })

  fx.context.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    commands: [
      { bind: "escape", title: "Back", run: () => fx.actions.show("run") },
      { bind: "down,j", run: () => move(1) },
      { bind: "up,k", run: () => move(-1) },
      {
        bind: "return",
        title: "Fix this crash",
        enabled: () => !!selected(),
        run: () => {
          const c = selected()!
          if (crashBusy(c)) fx.actions.show("run", c.fix?.runId ?? c.runId)
          else void fx.actions.startCrash(c)
        },
      },
      { bind: "t", title: "Fix top 3", enabled: () => tally().candidates > 0, run: () => void fx.actions.fixTop(3) },
      { bind: "r", title: "Refresh", enabled: () => !fx.state.crashesLoading, run: () => void fx.actions.loadCrashes({ refresh: true }) },
      { bind: "o", title: "Copy crash URL", enabled: () => !!selected()?.url, run: () => void fx.actions.copy(selected()!.url!) },
      { bind: "y", title: "Copy MR URL", enabled: () => !!selected()?.fix?.mrUrl, run: () => void fx.actions.copy(selected()!.fix!.mrUrl!) },
      { bind: "v", title: "Show the run", enabled: () => !!(selected()?.fix?.runId ?? selected()?.runId), run: () => fx.actions.show("run", selected()!.fix?.runId ?? selected()!.runId) },
      { bind: "s", title: "Sort by state / source", run: () => fx.mutate((d) => void (d.crashSort = d.crashSort === "state" ? "source" : "state")) },
      { bind: "l", title: "Runs", run: () => fx.actions.show("runs") },
      { bind: "g", title: "Report", run: () => fx.actions.show("report") },
      { bind: "f", title: "Fullscreen", run: () => props.panel.toggleFullscreen() },
    ],
  }))

  const CrashLine = (p: { c: (typeof fx.state.crashes)[number] }) => {
    const c = p.c
    const i = () => flat().indexOf(c)
    const sel = () => i() === cursor()
    const L = layout
    const fg = () => color(fx, crashTone(c.fix?.state ?? c.state))
    const badge = () => fixBadge(c.fix) || (c.fix ? c.fix.label : "")
    return (
      <box flexDirection="column" backgroundColor={sel() ? t.background.raised.high : undefined}>
        <text wrapMode="none">
          <S fg={t.text.muted}>{sel() ? "▸ " : "  "}</S>
          <S fg={fg()}>{crashGlyph(c)} </S>
          <S fg={t.text.base}>{padDisplay(c.title, L().title!)}</S>
          <Show when={L().impact}>
            <S fg={t.text.base}> {padDisplay(crashImpact(c), L().impact!, "right")}</S>
          </Show>
          <Show when={L().badge}>
            <S fg={fg()}> {padDisplay(badge(), L().badge!)}</S>
          </Show>
          <Show when={L().platform}>
            <S fg={t.text.muted}> {padDisplay(crashMeta(c), L().platform!)}</S>
          </Show>
          <Show when={L().age}>
            <S fg={t.text.muted}> {padDisplay(c.lastSeen ? relTime(Date.parse(c.lastSeen), fx.state.now) : "", L().age!, "right")}</S>
          </Show>
        </text>
        <Show when={sel()}>
          <Show when={!L().platform && crashMeta(c)}>
            <text fg={t.text.muted} wrapMode="none">
              {`    ${truncate([crashMeta(c), !L().impact ? crashImpact(c) : ""].filter(Boolean).join(" · "), width() - 4)}`}
            </text>
          </Show>
          <For each={crashSubline(c)}>
            {(line) => (
              <text wrapMode="none">
                <S fg={t.text.muted}>{`    ${truncate(line.text, line.href ? Math.max(8, Math.floor((width() - 5) / 2)) : width() - 4)}`}</S>
                <Show when={line.href}>
                  <S fg={t.text.muted}> </S>
                  <Link href={line.href!} fg={t.hue.accent[200]}>
                    {truncate(line.href, Math.max(8, width() - 5 - Math.min(line.text.length, Math.floor((width() - 5) / 2))))}
                  </Link>
                </Show>
              </text>
            )}
          </For>
          <text fg={t.text.muted} wrapMode="none">
            {`    ${crashBusy(c) ? "enter shows the run" : c.fix && !["new", "failed", "reopened"].includes(c.fix.state) ? "enter: links · fix again with --force" : "enter starts a fix"}${c.fix?.runId || c.runId ? " · v run" : ""}${c.fix?.mrUrl ? " · y copy MR" : ""}${c.url ? " · o copy URL" : ""}`}
          </text>
        </Show>
      </box>
    )
  }

  return (
    <>
      <Header fx={fx} right={[fx.state.crashesAt ? relTime(fx.state.crashesAt, fx.state.now) : "", `by ${fx.state.crashSort}`].filter(Boolean).join(" · ")} />
      <Rule fx={fx} width={width()} />
      <text fg={t.text.muted} wrapMode="none">
        {truncate(status(), width())}
      </text>
      <Switch>
        <Match when={fx.state.crashesLoading && fx.state.crashes.length === 0}>
          <Empty fx={fx} text={`${spinner(fx)} Loading crashes…`} />
        </Match>
        <Match when={fx.state.crashes.length === 0 && fx.state.crashesError}>
          <box paddingTop={1}>
            <Card fx={fx} title="Could not load crashes" tone="error">
              <For each={wrap(fx.state.crashesError, width() - 4, 4)}>{(line) => <text fg={t.text.feedback.error.base}>{line}</text>}</For>
              <text fg={t.text.muted}>r retries · connect Sentry / Crashlytics from /mcps · /fixora paste {"<file>"} fixes a pasted trace</text>
            </Card>
          </box>
        </Match>
        <Match when={fx.state.crashes.length === 0}>
          <Empty fx={fx} text="No crashes listed." hint="r refreshes · connect Sentry / Crashlytics from /mcps · /fixora paste <file> fixes a pasted trace" />
        </Match>
        <Match when={true}>
          <scrollbox flexGrow={1} minHeight={0} scrollY>
            <box flexDirection="column">
              <For each={groups()}>
                {(g) => (
                  <box flexDirection="column" paddingTop={1}>
                    <text wrapMode="none">
                      <S fg={t.text.base}>
                        <b>{g.label}</b>
                      </S>
                      <S fg={t.text.muted}> ({g.rows.length})</S>
                    </text>
                    <For each={g.rows}>{(c) => <CrashLine c={c} />}</For>
                  </box>
                )}
              </For>
            </box>
          </scrollbox>
        </Match>
      </Switch>
      <Rule fx={fx} width={width()} />
      <Keys fx={fx} items={[["↑↓", "select"], ["enter", "fix"], ["t", "fix top 3"], ["r", "refresh"], ["v", "run"], ["o", "copy URL"], ["y", "copy MR"], ["s", "sort"], ["l", "runs"], ["g", "report"], ["f", "full"], ["esc", "back"]]} />
    </>
  )
}

// ---------- report view ----------

const EMPTY_REPORT: FunnelStats = { days: 30, total: 0, byStatus: {}, funnel: [], daily: [], timing: { samples: 0 }, mrs: { opened: 0, merged: 0, closed: 0, pending: 0 }, releases: { fixed: 0, reopened: 0, reopenRate: 0 }, top: { platforms: [], versions: [], sources: [] }, recent: [] }

function ReportView(props: { fx: Fixora; panel: PanelInput }) {
  const fx = props.fx
  const t = fx.context.theme
  const width = () => panelWidth(props.panel)
  const inner = () => width() - 4
  // `Show` reads its children eagerly, so never dereference an absent report.
  const s = () => fx.state.report ?? EMPTY_REPORT
  fx.context.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    commands: [
      { bind: "escape", title: "Back", run: () => fx.actions.show("run") },
      { bind: "s", title: "Sync MRs", run: () => void fx.actions.sync().then(() => fx.actions.loadReport()) },
      { bind: "shift+c", title: "Crashes", run: () => fx.actions.show("crashes") },
      { bind: "l", title: "Runs", run: () => fx.actions.show("runs") },
      { bind: "f", title: "Fullscreen", run: () => props.panel.toggleFullscreen() },
    ],
  }))
  const max = () => Math.max(1, ...(fx.state.report?.funnel.map((f) => f.count) ?? [1]))
  const barWidth = () => Math.max(8, Math.min(24, inner() - 28))
  return (
    <>
      <Header fx={fx} right={`last ${fx.state.report?.days ?? 30} days · ${fx.state.report?.total ?? 0} run(s)`} />
      <Rule fx={fx} width={width()} />
      <Show when={fx.state.report} fallback={<Empty fx={fx} text={`${spinner(fx)} Loading…`} />}>
        {
          <scrollbox flexGrow={1} minHeight={0} scrollY>
            <box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1}>
              <Card fx={fx} title="Funnel">
                <Show when={s().funnel.length === 0}>
                  <text fg={t.text.muted}>No runs in this window.</text>
                </Show>
                <For each={s().funnel}>
                  {(f) => (
                    <text wrapMode="none">
                      <S fg={t.text.base}>{padDisplay(f.stage, 12)}</S>
                      <S fg={t.hue.accent[200]}>{bar(f.count, max(), barWidth())}</S>
                      <S fg={t.text.base}>{String(f.count).padStart(5)}</S>
                      <S fg={t.text.muted}> {fmtPct(f.rate).padStart(4)}</S>
                    </text>
                  )}
                </For>
              </Card>
              <Card fx={fx} title="Trend">
                <Row fx={fx} label="created" labelWidth={8}>
                  <S fg={t.categorical[0]![200]}>{sparkline(s().daily.map((d) => d.created))}</S>
                  <S fg={t.text.base}> {String(s().daily.reduce((a, d) => a + d.created, 0))}</S>
                </Row>
                <Row fx={fx} label="done" labelWidth={8}>
                  <S fg={t.text.feedback.success.base}>{sparkline(s().daily.map((d) => d.completed))}</S>
                  <S fg={t.text.base}> {String(s().daily.reduce((a, d) => a + d.completed, 0))}</S>
                </Row>
                <Row fx={fx} label="failed" labelWidth={8}>
                  <S fg={t.text.feedback.error.base}>{sparkline(s().daily.map((d) => d.failed))}</S>
                  <S fg={t.text.base}> {String(s().daily.reduce((a, d) => a + d.failed, 0))}</S>
                </Row>
              </Card>
              <Card fx={fx} title="Totals">
                <Row fx={fx} label="Timing">
                  <S fg={t.text.base}>{truncate(`avg ${fmtDuration(s().timing.avgMs)} · p90 ${fmtDuration(s().timing.p90Ms)} · fastest ${fmtDuration(s().timing.minMs)}`, inner() - 10)}</S>
                </Row>
                <Row fx={fx} label="MRs">
                  <S fg={t.text.base}>{truncate(`${s().mrs.opened} opened · ${s().mrs.merged} merged · ${s().mrs.closed} closed · ${s().mrs.pending} pending`, inner() - 10)}</S>
                </Row>
                <Row fx={fx} label="Releases">
                  <S fg={t.text.base}>{truncate(`${s().releases.fixed} fixed · ${s().releases.reopened} reopened (${fmtPct(s().releases.reopenRate)})`, inner() - 10)}</S>
                </Row>
                <Show when={s().top.platforms.length}>
                  <Row fx={fx} label="Top">
                    <S fg={t.text.base}>{truncate([...s().top.platforms, ...s().top.versions].map(([k, v]) => `${k} ${v}`).join(" · "), inner() - 10)}</S>
                  </Row>
                </Show>
              </Card>
              <Card fx={fx} title="Recent">
                <Show when={s().recent.length === 0}>
                  <text fg={t.text.muted}>Nothing yet.</text>
                </Show>
                <For each={s().recent}>
                  {(r) => (
                    <text wrapMode="none">
                      <S fg={tone(fx, r.status)}>{glyphOf(fx, r.status)} </S>
                      <S fg={t.text.base}>{padDisplay(r.runId, Math.min(24, Math.max(10, Math.floor(inner() / 3))))}</S>
                      <S fg={t.text.muted}> {truncate(r.title, Math.max(8, inner() - Math.min(24, Math.max(10, Math.floor(inner() / 3))) - 7))}</S>
                      <S fg={t.text.feedback.success.base}>{r.mrUrl ? "  MR" : ""}</S>
                    </text>
                  )}
                </For>
              </Card>
            </box>
          </scrollbox>
        }
      </Show>
      <Rule fx={fx} width={width()} />
      <Keys fx={fx} items={[["s", "sync MRs"], ["C", "crashes"], ["l", "runs"], ["f", "full"], ["esc", "back"]]} />
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
  const title = () => (props.gate.kind === "ticket" ? "Create Jira ticket" : props.gate.kind === "mr" ? "Open merge request" : props.gate.kind === "push" ? "Push branch" : props.gate.kind === "stash" ? "Stash local changes" : props.gate.kind === "delete-branch" ? "Delete remote branch" : "Publish fix")

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
              {` · ${p().files!.length} file(s)${p().additions !== undefined ? ` · +${p().additions} −${p().deletions ?? 0}` : ""}`}
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
        <box flexDirection="column" border borderStyle="rounded" borderColor={t.border.base} title=" Root cause " titleColor={t.text.muted} paddingLeft={1} paddingRight={1}>
          <text fg={t.text.base}>{p().rootCause}</text>
        </box>
      </Show>
      <Show when={p().mrBody}>
        <scrollbox height={full() ? 24 : 8} scrollY border borderStyle="rounded" borderColor={t.border.base} paddingLeft={1} paddingRight={1}>
          <box flexDirection="column">
            <For each={full() ? body() : body().slice(0, 12)}>{(line) => <text fg={/^#/.test(line) ? t.text.base : t.text.muted}>{line || " "}</text>}</For>
            <Show when={!full() && body().length > 12}>
              <text fg={t.text.muted}>… v for the full body</text>
            </Show>
          </box>
        </scrollbox>
      </Show>
      <Keys fx={fx} items={[["a", props.gate.kind === "ticket" ? "create ticket" : props.gate.kind === "stash" ? "stash and continue" : "approve"], ["r", "reject with feedback"], ...(p().mrBody ? [["v", "full MR body"] as [string, string]] : []), ["esc", "decide later"]]} />
    </box>
  )
}

// ---------- small surfaces ----------

/**
 * Sidebar block: one row per run of this session with its live timer. The host closes the panel
 * when the sidebar is shown, so a click on a row (or on the header) reopens the panel on that run.
 */
export function SidebarBadge(props: { fx: Fixora; sessionID: string }) {
  const fx = props.fx
  const t = fx.context.theme
  const runs = createMemo(() => runsForSession(fx.state, props.sessionID))
  const [hover, setHover] = createSignal<string | undefined>(undefined)
  const open = (runId?: string) => fx.actions.show("run", runId ?? runs()[0]?.runId)
  return (
    <Show when={runs().length > 0}>
      <box flexDirection="column" onMouseUp={() => open()}>
        <box flexDirection="row" justifyContent="space-between" onMouseOver={() => setHover("header")} onMouseOut={() => setHover(undefined)}>
          <text fg={t.text.base}>
            <b>Fixora</b>
          </text>
          <text fg={t.text.muted}>{hover() ? "open ▸" : ""}</text>
        </box>
        <For each={runs().slice(0, 3)}>
          {(r) => (
            <box
              onMouseUp={(event) => {
                event.stopPropagation()
                open(r.runId)
              }}
              onMouseOver={() => setHover(r.runId)}
              onMouseOut={() => setHover(undefined)}
            >
              <text wrapMode="none">
                <S fg={tone(fx, r.status)}>{glyphOf(fx, r.status)} </S>
                <S fg={hover() === r.runId ? t.text.base : t.text.muted}>
                  {STAGE_TITLES[r.step] ?? r.step}
                  {r.status === "running" ? ` ${fmtClock(fx.state.now - r.startedAt)}` : r.status === "awaiting-approval" ? " · needs you" : ""}
                </S>
              </text>
            </box>
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
      <box flexShrink={0} onMouseUp={() => fx.actions.show("run")}>
        <text>
          <S fg={t.text.muted}>fixora </S>
          <Show when={running() > 0}>
            <S fg={t.hue.accent[200]}>{`◐${running()} `}</S>
          </Show>
          <Show when={awaiting() > 0}>
            <S fg={t.text.feedback.warning.base}>{`⏸${awaiting()}`}</S>
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
            {`⏸ Fixora needs a decision on ${gate()?.runId ?? ""}: ${gate()?.summary ?? ""}`}
          </S>
          <S fg={t.text.muted}> — /fixora panel then a, or the palette command "Fixora: answer pending approval"</S>
        </text>
      </box>
    </Show>
  )
}
