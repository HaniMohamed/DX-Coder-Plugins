/** @jsxImportSource @opentui/solid */
// Slash / palette commands and the crash picker dialog.

import type { Fixora } from "./components.js"
import type { CrashRow } from "./store.js"
import { relTime, truncate } from "./store.js"
import { isFixCandidate, isFixed, nextCommands, STATE_GLYPH } from "../crashstate.js"
import { describeError } from "../errors.js"
import type { CrashFix } from "../types.js"

type PickValue = { kind: "crash"; ref: string; title: string } | { kind: "paste" } | { kind: "source"; id: string }

export function currentSession(fx: Fixora): string | undefined {
  const route = fx.context.ui.router.current()
  return route.type === "session" ? route.sessionID : undefined
}

/**
 * The session Fixora works in. On the Home / new-session screen no session exists yet (the host
 * creates one on the first prompt), so Fixora creates one itself, named after the plugin, and
 * navigates to it. Returns undefined only when creation fails.
 */
export async function ensureSession(fx: Fixora): Promise<string | undefined> {
  const current = currentSession(fx)
  if (current) return current
  try {
    const model = fx.context.ui.model.current()
    const created = (await fx.context.client.session.create({
      title: "Fixora",
      location: fx.context.data.location.default(),
      ...(model ? { model: { providerID: model.providerID, id: model.modelID, variant: model.variant } } : {}),
    } as never)) as { id: string }
    fx.context.ui.router.navigate({ type: "session", sessionID: created.id })
    // Give the session view a tick to mount before anything targets its panel.
    await new Promise((resolve) => setTimeout(resolve, 150))
    return created.id
  } catch (error) {
    fx.context.ui.toast.show({ title: "Fixora", message: `Could not create a session: ${describeError(error)}`, variant: "error" })
    return undefined
  }
}

export const sourceLabel: Record<string, string> = { sentry: "Sentry", crashlytics: "Crashlytics", manual: "Pasted" }

/** "DE-456 · MR !418 merged" for the picker row of a crash Fixora already handled. */
export function fixBadge(fix: CrashFix | undefined): string {
  if (!fix) return ""
  const parts: string[] = []
  if (fix.jiraKey) parts.push(fix.jiraKey)
  if (fix.mrUrl) parts.push(`${fix.mrRef ?? "MR"}${fix.mrStatus ? ` ${fix.mrStatus}` : ""}`)
  if (fix.release) parts.push(`release ${fix.release}`)
  return parts.join(" · ")
}

export function crashOption(c: CrashRow) {
  const users = c.userCount !== undefined ? `${c.userCount.toLocaleString()} users` : c.eventCount !== undefined ? `${c.eventCount.toLocaleString()} events` : ""
  const glyph = c.fix ? (STATE_GLYPH[c.fix.state] ?? "") : ""
  const footer = c.fix ? `${glyph} ${c.fix.label}${c.fix.stillSeen && c.fix.state !== "reopened" ? " · still seen" : ""}`.trim().toUpperCase() : "NEW"
  const badge = fixBadge(c.fix)
  return {
    title: `${glyph ? `${glyph} ` : ""}${truncate(c.title, 70)}${users ? `   ${users}` : ""}`,
    value: { kind: "crash" as const, ref: c.ref ?? `${c.source}:${c.id}`, title: c.title },
    description: [c.platform, c.appVersion ? `v${c.appVersion}` : undefined, c.lastSeen ? relTime(Date.parse(c.lastSeen)) : undefined, badge || undefined, c.fix?.note ? truncate(c.fix.note, 60) : undefined, c.runId].filter(Boolean).join(" · ") || undefined,
    footer,
    category: sourceLabel[c.source] ?? c.source,
    disabled: c.state === "in_progress" || c.state === "awaiting",
  }
}

/** The /fixora picker: lists crashes from every connected source and starts runs. */
export async function pickCrash(fx: Fixora, rpc: ReturnType<Fixora["context"]["client"]["rpc"]> & Record<string, (input: unknown) => Promise<unknown>>): Promise<void> {
  const sessionID = await ensureSession(fx)
  if (!sessionID) return
  const toast = fx.context.ui.toast
  const loading = setTimeout(() => toast.show({ message: "Fixora: loading crashes…", variant: "info", duration: 1500 }), 400)
  let sources: Array<{ id: string; status: string; serverName?: string }> = []
  let crashes: CrashRow[] = []
  let errors: string[] = []
  try {
    const s = (await rpc["sources.list"]({})) as { sources: typeof sources }
    sources = s.sources
    const list = (await rpc["crashes.list"]({ sessionID, top: 25 })) as { crashes: CrashRow[]; errors: string[] }
    crashes = list.crashes
    errors = list.errors
  } catch (error) {
    errors.push(describeError(error))
  } finally {
    clearTimeout(loading)
  }
  fx.mutate((d) => {
    d.sources = sources
    d.crashes = crashes
    d.crashesAt = Date.now()
  })
  const options = crashes.map(crashOption)
  const unavailable = sources.filter((s) => s.status !== "connected" && (s.id === "sentry" || s.id === "crashlytics"))
  for (const s of unavailable) options.push({ title: `${sourceLabel[s.id] ?? s.id} (${s.status}) — connect it from /mcps`, value: { kind: "source" as const, id: s.id } as never, description: s.serverName, footer: "", category: "Other", disabled: true })
  options.push({ title: "Paste a stack trace from a file…", value: { kind: "paste" as const } as never, description: "/fixora paste <file>", footer: "", category: "Other", disabled: false })
  if (crashes.length === 0 && errors.length > 0) toast.show({ title: "Fixora", message: errors.join("; ").slice(0, 200), variant: "warning" })
  const newOnes = crashes.filter((c) => isFixCandidate(c.state))
  const fixedCount = crashes.filter((c) => isFixed(c.state)).length
  const picked = await fx.context.ui.dialog.select<PickValue>({
    title: `Fixora · pick a crash to fix  (${sources.filter((s) => s.status === "connected").length} source(s) · ${newOnes.length} new${fixedCount ? ` · ${fixedCount} already fixed` : ""})`,
    placeholder: "Search by title, exception, version…",
    options,
    search: (query, opts) => {
      const q = query.trim().toLowerCase()
      if (!q) return opts
      return opts.filter((o) => `${o.title} ${o.description ?? ""} ${o.category ?? ""}`.toLowerCase().includes(q))
    },
    actions: [
      {
        bind: "ctrl+t",
        title: "Fix top 3",
        selection: "none",
        onTrigger: () => {
          fx.context.ui.dialog.clear()
          void startRuns(fx, rpc, sessionID, newOnes.slice(0, 3).map((c) => c.ref ?? `${c.source}:${c.id}`))
        },
      },
      {
        bind: "ctrl+r",
        title: "Refresh",
        selection: "none",
        onTrigger: () => {
          fx.context.ui.dialog.clear()
          void pickCrash(fx, rpc)
        },
      },
    ],
  })
  if (!picked) return
  if (picked.kind === "paste") {
    const file = await fx.context.ui.dialog.prompt({ title: "Fixora · paste", description: "Path of a file containing the stack trace", placeholder: "crash.txt" })
    if (file) await startRuns(fx, rpc, sessionID, [`manual:${file}`], { file })
    return
  }
  if (picked.kind !== "crash") return
  const row = crashes.find((c) => (c.ref ?? `${c.source}:${c.id}`) === picked.ref)
  if (row?.fix && !isFixCandidate(row.state)) {
    // Already handled: show the links instead of starting a run that the server would refuse anyway.
    const f = row.fix
    const lines = [`${STATE_GLYPH[f.state] ?? ""} ${f.label}`, `run ${f.runId}`, f.branch ? `branch ${f.branch}` : "", f.jiraKey ? `Jira ${f.jiraKey}${f.jiraUrl ? ` ${f.jiraUrl}` : ""}` : "", f.mrUrl ? `${f.mrRef ?? "MR"} ${f.mrUrl}` : "", f.note ?? ""].filter(Boolean)
    const next = nextCommands(f, picked.ref)
    const again = await fx.context.ui.dialog.confirm({ title: "Fixora · already handled", message: `${lines.join("\n")}${next.length ? `\n\nNext: ${next.join("  ·  ")}` : ""}\n\nStart a new fix cycle anyway (--force)?`, label: { confirm: "Fix again", cancel: "Close" } })
    if (again) await startRuns(fx, rpc, sessionID, [picked.ref], { flags: { force: true } })
    return
  }
  const ok = await fx.context.ui.dialog.confirm({ title: "Fixora", message: `Fix "${truncate(picked.title, 80)}"? The agent creates a fixora/ branch in this checkout, fixes and tests it, a second session reviews it, and after your approval it pushes and opens a draft MR. Your branch and local changes are restored afterwards.`, label: { confirm: "Start", cancel: "Not now" } })
  if (!ok) return
  await startRuns(fx, rpc, sessionID, [picked.ref])
}

export async function startRuns(fx: Fixora, rpc: Record<string, (input: unknown) => Promise<unknown>>, sessionID: string, refs: string[], o: { file?: string; flags?: Record<string, unknown> } = {}): Promise<void> {
  for (const ref of refs) {
    try {
      if (ref.startsWith("manual:") && o.file) {
        // Pasted traces go through the slash command so the file is copied into the run folder.
        await fx.context.client.session.command({ sessionID, name: "fixora", text: `paste ${o.file}` } as never)
        continue
      }
      const res = (await rpc["run.start"]({ ref, sessionID, ...(o.flags ? { flags: o.flags } : {}) })) as { runId: string }
      fx.context.ui.toast.show({ message: `Fixora started ${res.runId}`, variant: "info", sessionID })
    } catch (error) {
      const e = error as { type?: string; message?: string; data?: { ref?: string; runId?: string } }
      fx.context.ui.toast.show({ title: "Fixora", message: e.type === "busy" ? `${e.data?.runId ?? ref} is already in progress` : (e.data?.ref ?? describeError(error)).slice(0, 200), variant: "warning" })
    }
  }
  setTimeout(() => fx.context.ui.panel.open("fixora"), 300)
}

/** Parses `/fixora …` typed in the prompt (TUI side); unknown verbs fall through to the server command. */
export function parseSlash(input: string | undefined): { verb: string; rest: string } {
  const text = (input ?? "").trim()
  const [verb = "", ...rest] = text.split(/\s+/)
  return { verb: verb.toLowerCase(), rest: rest.join(" ") }
}
