import { Plugin, Skill } from "@opencode/plugin"
import matter from "gray-matter"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { COMMAND, notify, PlannerStop, runAudit, runPlan, runPush, runStatus, SKILL_ID, workerFolder } from "./src/flows.js"
import { guardWorkerWrite, WRITE_TOOLS } from "./src/mcp.js"
import { ISSUE_KEY_PATTERN } from "./src/schema.js"

const USAGE = [
  "Usage:",
  `  /${COMMAND} <ISSUE-KEY> [--force] [--no-attachments]   plan the story and break it into subtasks`,
  `  /${COMMAND} audit <ISSUE-KEY>                          re-check the plan against Jira (gaps + estimates)`,
  `  /${COMMAND} push <ISSUE-KEY> [--dry-run]               create the missing subtasks in Jira (asks for approval)`,
  `  /${COMMAND} status [ISSUE-KEY]                         show recorded runs`,
].join("\n")

interface Parsed {
  verb: "plan" | "audit" | "push" | "status"
  issue?: string
  flags: Set<string>
}

export function parseCommand(text: string): Parsed | undefined {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const flags = new Set(words.filter((w) => w.startsWith("--")).map((w) => w.toLowerCase()))
  const rest = words.filter((w) => !w.startsWith("--"))
  if (rest.length === 0) return undefined
  const first = rest[0]!.toLowerCase()
  const keyAt = (i: number) => {
    const k = rest[i]
    return k && ISSUE_KEY_PATTERN.test(k) ? k.toUpperCase() : undefined
  }
  if (first === "plan") return keyAt(1) ? { verb: "plan", issue: keyAt(1), flags } : undefined
  if (first === "audit") return keyAt(1) ? { verb: "audit", issue: keyAt(1), flags } : undefined
  if (first === "push") return keyAt(1) ? { verb: "push", issue: keyAt(1), flags } : undefined
  if (first === "status") return { verb: "status", issue: keyAt(1), flags }
  if (keyAt(0)) return { verb: "plan", issue: keyAt(0), flags }
  return undefined
}

export default Plugin.define({
  id: "gosi.jira-planner",
  async setup(ctx) {
    // Bundled worker skill, loaded the same way the Figma plugin loads its skills.
    const file = new URL(`./skills/${SKILL_ID}/SKILL.md`, import.meta.url)
    const markdown = matter(await readFile(file, "utf8"))
    const skill = Skill.Info.make({
      id: Skill.ID.make(SKILL_ID),
      name: Skill.Name.make(markdown.data.name ?? SKILL_ID),
      description: markdown.data.description,
      autoinvoke: markdown.data["disable-model-invocation"] !== true,
      path: Skill.Info.fields.path.make(fileURLToPath(file)),
      content: markdown.content,
    })
    await ctx.skill.transform((editor) => {
      if (!editor.get(skill.id)) editor.add(skill)
    })

    // Confine planning workers to their issue folder. This runs before every write/edit/patch call
    // and does not depend on how the host formats permission resources.
    const folders = new Map<string, string | null>()
    await ctx.tool.hook("execute.before", async (event) => {
      if (!WRITE_TOOLS.has(event.tool)) return
      let folder = folders.get(event.sessionID)
      if (folder === undefined) {
        folder = (await workerFolder(ctx, event.sessionID)) ?? null
        folders.set(event.sessionID, folder)
      }
      if (!folder) return
      const problem = guardWorkerWrite({ tool: event.tool, input: event.input, folder, directory: ctx.location.directory })
      if (problem) throw new Error(problem)
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: COMMAND,
        description: "Plan a Jira story against this repo, break it into estimated subtasks, audit existing ones, and push the gaps to Jira after approval",
        execute: async (input) => {
          const parsed = parseCommand(input.prompt.text)
          if (!parsed) {
            await notify(ctx, input.sessionID, USAGE)
            return
          }
          try {
            switch (parsed.verb) {
              case "plan":
                await runPlan(ctx, {
                  sessionID: input.sessionID,
                  issue: parsed.issue!,
                  force: parsed.flags.has("--force"),
                  attachments: !parsed.flags.has("--no-attachments"),
                })
                break
              case "audit":
                await runAudit(ctx, { sessionID: input.sessionID, issue: parsed.issue! })
                break
              case "push":
                await runPush(ctx, { sessionID: input.sessionID, issue: parsed.issue!, dryRun: parsed.flags.has("--dry-run") })
                break
              case "status":
                await runStatus(ctx, { sessionID: input.sessionID, issue: parsed.issue })
                break
            }
          } catch (error) {
            if (error instanceof PlannerStop) {
              await ctx.session.synthetic({
                sessionID: input.sessionID,
                description: `jira-planner stopped: ${error.message.split("\n")[0]!.slice(0, 160)}`,
                text: `[jira-planner] Tell the user exactly this, formatted as markdown, without calling tools:\n\n${error.message}`,
                resume: true,
              })
              return
            }
            const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
            await ctx.storage.set(`jira-planner/run/${parsed.issue ?? "unknown"}`, {
              step: "error",
              originSessionID: input.sessionID,
              attempt: 0,
              startedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              error: message,
            })
            await ctx.session.synthetic({
              sessionID: input.sessionID,
              description: `jira-planner failed: ${message.slice(0, 160)}`,
              text: `[jira-planner] The command failed. Tell the user, without calling tools:\n\n${message}`,
              resume: true,
            })
          }
        },
      })
    })
  },
})
