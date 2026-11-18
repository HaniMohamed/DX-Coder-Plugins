/** @jsxImportSource @opentui/solid */
// The panel's small design system: colours by tone, cards, chips, labelled rows, the stage
// timeline. Contract: `S`, `Chip`, `Progress`, `Tabs` and `Link` yield spans, so they can sit
// inside a <text>; `Card`, `Row`, `Header`, `Rule`, `Keys`, `Timeline` and `Empty` yield boxes or
// texts and must never be nested in a <text> (a nested <text> crashes the slot).

import type { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { createMemo, For, Show } from "solid-js"
import type { Store } from "solid-js/store"
import { collapseStages, fmtClock, fmtShort, padDisplay, progressBar, stageTitle, stageTitleWidth, stageTone, truncate, type ToneKey } from "./format.js"
import { SPINNER, STATUS_GLYPH, type CrashRow, type GateView, type PanelView, type RunView, type StageView, type TuiState } from "./store.js"

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
    /** Rebuilds the run records from the merge requests Fixora opened (after a reset / on a new machine). */
    recover(o?: { dryRun?: boolean; force?: boolean; all?: boolean }): Promise<void>
    markFixed(runId: string): Promise<void>
    copy(text: string): Promise<void>
    hydrate(runId?: string): Promise<void>
    loadReport(): Promise<void>
    /** Loads the sources and the top crashes for the crashes view. */
    loadCrashes(o?: { refresh?: boolean }): Promise<void>
    /** Confirms and starts a run for a listed crash (`--force` for one Fixora already handled). */
    startCrash(row: CrashRow, o?: { force?: boolean }): Promise<void>
    /** Starts runs for the first `n` crashes nobody handled yet. */
    fixTop(n: number): Promise<void>
  }
}

export function color(fx: Fixora, tone: ToneKey): RGBA {
  const t = fx.context.theme
  switch (tone) {
    case "success":
      return t.text.feedback.success.base
    case "warning":
      return t.text.feedback.warning.base
    case "error":
      return t.text.feedback.error.base
    case "accent":
      return t.hue.accent[200]
    case "base":
      return t.text.base
    default:
      return t.text.muted
  }
}

/** Current spinner frame (the store clock ticks at 4 fps while a run is active). */
export const spinner = (fx: Fixora) => SPINNER[Math.floor(fx.state.now / 250) % SPINNER.length]!

/** Inline coloured text: OpenTUI spans take their colour through `style`. */
export function S(props: { fg?: RGBA; children?: JSX.Element }) {
  return <span style={{ fg: props.fg }}>{props.children}</span>
}

/** A clickable hyperlink span (OSC 8); the label defaults to the URL. */
export function Link(props: { href: string; fg?: RGBA; children?: JSX.Element }) {
  return (
    <a href={props.href} style={{ fg: props.fg }}>
      {props.children ?? props.href}
    </a>
  )
}

/** A status pill: bold label in its tone colour, optionally padded to a column width. */
export function Chip(props: { fx: Fixora; tone: ToneKey; label: string; width?: number }) {
  return (
    <S fg={color(props.fx, props.tone)}>
      <b>{props.width ? padDisplay(props.label, props.width) : props.label}</b>
    </S>
  )
}

/** ▰▰▰▱▱ 6/11 as spans. */
export function Progress(props: { fx: Fixora; done: number; total: number; width: number }) {
  const t = props.fx.context.theme
  const bar = () => progressBar(props.done, props.total, props.width)
  return (
    <>
      <S fg={props.total > 0 && props.done >= props.total ? t.text.feedback.success.base : t.hue.accent[200]}>{bar().filled}</S>
      <S fg={t.text.muted}>{bar().empty}</S>
      <S fg={t.text.base}>{` ${props.done}/${props.total}`}</S>
    </>
  )
}

export function Keys(props: { fx: Fixora; items: Array<[string, string]> }) {
  const t = props.fx.context.theme
  return (
    <box flexDirection="row" gap={2} flexWrap="wrap" flexShrink={0}>
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

export function Rule(props: { fx: Fixora; width: number }) {
  return <text fg={props.fx.context.theme.border.base}>{"─".repeat(Math.max(1, props.width))}</text>
}

/** Rendered INSIDE a <text>, so this yields spans only (no control flow: the host never loops inside a text). */
export function Tabs(props: { fx: Fixora }) {
  const t = props.fx.context.theme
  const tab = (view: PanelView, label: string) => <S fg={props.fx.state.view === view ? t.text.base : t.text.muted}>{props.fx.state.view === view ? <b>{label}</b> : label}</S>
  const sep = () => <S fg={t.text.muted}> · </S>
  return (
    <>
      {tab("crashes", "crashes")}
      {sep()}
      {tab("run", "run")}
      {sep()}
      {tab("runs", "runs")}
      {sep()}
      {tab("report", "report")}
    </>
  )
}

/** The "Fixora · tabs … right" top row every view shares. */
export function Header(props: { fx: Fixora; right?: string }) {
  const t = props.fx.context.theme
  return (
    <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <text wrapMode="none">
        <S fg={t.text.base}>
          <b>Fixora</b>
        </S>
        <S fg={t.text.muted}> · </S>
        <Tabs fx={props.fx} />
      </text>
      <Show when={props.right}>
        <text fg={t.text.muted} wrapMode="none">
          {props.right}
        </text>
      </Show>
    </box>
  )
}

/** A rounded, bordered section with its title in the top border; the border carries the tone. */
export function Card(props: { fx: Fixora; title?: string; tone?: ToneKey; children?: JSX.Element }) {
  const t = props.fx.context.theme
  const border = () => (props.tone ? color(props.fx, props.tone) : t.border.base)
  return (
    <box flexDirection="column" flexShrink={0} border borderStyle="rounded" borderColor={border()} title={props.title ? ` ${props.title} ` : undefined} titleColor={props.tone ? color(props.fx, props.tone) : t.text.base} paddingLeft={1} paddingRight={1}>
      {props.children}
    </box>
  )
}

/** "Label     value" with the label padded to a column; children must be spans or strings. */
export function Row(props: { fx: Fixora; label: string; labelWidth?: number; children?: JSX.Element }) {
  const t = props.fx.context.theme
  return (
    <text wrapMode="none">
      <S fg={t.text.muted}>{padDisplay(props.label, props.labelWidth ?? 10)}</S>
      {props.children}
    </text>
  )
}

export function Empty(props: { fx: Fixora; text: string; hint?: string }) {
  const t = props.fx.context.theme
  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1}>
      <text fg={t.text.base}>{props.text}</text>
      <Show when={props.hint}>
        <text fg={t.text.muted}>{props.hint}</text>
      </Show>
    </box>
  )
}

/** The stage checklist of a run: glyph, title, live detail, attempt badge, duration or live clock. */
export function Timeline(props: { fx: Fixora; stages: StageView[]; progress?: string; width: number; collapsed: boolean }) {
  const fx = props.fx
  const t = fx.context.theme
  const rows = createMemo(() => collapseStages(props.stages, props.collapsed))
  const titleW = () => stageTitleWidth(props.width)
  const detailW = () => Math.max(6, props.width - titleW() - 12)
  return (
    <box flexDirection="column">
      <For each={rows()}>
        {(row) => {
          if (row.kind === "collapsed")
            return (
              <box flexDirection="row" justifyContent="space-between">
                <text wrapMode="none">
                  <S fg={t.text.feedback.success.base}>{"✓ "}</S>
                  <S fg={t.text.muted}>{`${row.count} stages done`}</S>
                </text>
                <text fg={t.text.muted}>{fmtShort(row.durationMs)}</text>
              </box>
            )
          const stage = row.stage
          const glyph = () => (stage.status === "running" ? spinner(fx) : STATUS_GLYPH[stage.status])
          const right = () => (stage.status === "running" && stage.startedAt ? fmtClock(fx.state.now - stage.startedAt) : fmtShort(stage.durationMs))
          const detail = () => (stage.status === "running" ? (props.progress ?? stage.detail ?? "") : (stage.detail ?? ""))
          return (
            <box flexDirection="row" justifyContent="space-between">
              <text wrapMode="none">
                <S fg={color(fx, stageTone(stage.status))}>{glyph()} </S>
                <S fg={stage.status === "pending" ? t.text.muted : t.text.base}>{padDisplay(stageTitle(stage.step, props.width), titleW())}</S>
                <S fg={t.text.muted}> {truncate(detail(), detailW())}</S>
                <Show when={(stage.attempt ?? 1) > 1}>
                  <S fg={t.text.feedback.warning.base}> ×{String(stage.attempt)}</S>
                </Show>
              </text>
              <text fg={stage.status === "running" ? t.text.base : t.text.muted}>{right()}</text>
            </box>
          )
        }}
      </For>
    </box>
  )
}
