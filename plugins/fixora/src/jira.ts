// Jira through the Jira MCP server (mcp-atlassian shapes; tolerant). The plugin only renders the
// exact tool inputs the worker must send and validates what it reports back.

import type { FixoraOptions } from "./options.js"
import type { DetectedService } from "./types.js"

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Tickets are possible when a connected Jira MCP server exposes create + search and a project is configured. */
export function jiraAvailable(service: DetectedService | undefined, options: FixoraOptions): boolean {
  return !!service && service.status === "connected" && !!service.capabilities.createIssue && !!service.capabilities.search && !!options.jira.project
}

export const jiraBaseUrl = (service: DetectedService | undefined) => service?.environment?.JIRA_URL?.replace(/\/+$/, "")

export const browseUrl = (baseUrl: string | undefined, key: string) => (baseUrl ? `${baseUrl}/browse/${key}` : undefined)

/** JSON-schema type of one input parameter of a tool ("string", "object", …), or undefined when unknown. */
export function schemaParamType(schema: unknown, param: string): string | undefined {
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined
  const prop = schema.properties[param]
  if (!isRecord(prop)) return undefined
  const type = prop.type ?? (Array.isArray(prop.anyOf) ? (prop.anyOf as unknown[]).map((x) => (isRecord(x) ? x.type : undefined)).find((t) => t && t !== "null") : undefined)
  if (typeof type === "string") return type
  if (Array.isArray(type)) return type.find((t) => t !== "null") as string | undefined
  return undefined
}

/**
 * mcp-atlassian changed `additional_fields` from a JSON string to an object between versions.
 * Encode according to the server's declared schema; when unknown, send an object (the skill tells
 * the agent to retry with the other encoding when the server complains).
 */
export function encodeAdditionalFields(value: Record<string, unknown>, declaredType: string | undefined): string | Record<string, unknown> {
  return declaredType === "string" ? JSON.stringify(value) : value
}

export interface JiraCreateFields {
  project: string
  issueType: string
  summary: string
  description: string
  labels: string[]
  parent?: string
}

/** The `jira_create_issue` input (mcp-atlassian takes the parent key in additional_fields, sub-tasks and parent links alike). */
export function jiraCreateInput(fields: JiraCreateFields, o: { additionalFieldsType?: string } = {}): Record<string, unknown> {
  const additional = { labels: fields.labels, ...(fields.parent ? { parent: fields.parent } : {}) }
  return {
    project_key: fields.project,
    summary: fields.summary.slice(0, 255),
    issue_type: fields.issueType,
    description: fields.description,
    additional_fields: encodeAdditionalFields(additional, o.additionalFieldsType),
  }
}

export const jiraSearchInput = (jql: string, max = 5): Record<string, unknown> => ({ jql, limit: max, fields: "summary,status" })
export const jiraCommentInput = (key: string, body: string): Record<string, unknown> => ({ issue_key: key, comment: body })
export const jiraTransitionsInput = (key: string): Record<string, unknown> => ({ issue_key: key })
export const jiraTransitionInput = (key: string, transitionId: string): Record<string, unknown> => ({ issue_key: key, transition_id: transitionId })

export const dedupeJql = (project: string | undefined, fingerprint: string) =>
  `${project ? `project = "${project}" AND ` : ""}(labels = "fixora" OR text ~ "fixora-fp") AND text ~ "fixora-fp:${fingerprint.slice(0, 12)}" ORDER BY created DESC`

/** Finds a transition whose name matches loosely ("In Review" ≈ "in-review" ≈ "Review"). */
export function pickTransition(transitions: Array<{ id: string; name: string }>, wanted: string): { id: string; name: string } | undefined {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "")
  const w = norm(wanted)
  return transitions.find((t) => norm(t.name) === w) ?? transitions.find((t) => norm(t.name).includes(w) || w.includes(norm(t.name)))
}

/** Pulls an issue key (and URL when present) out of whatever a create / search reply looks like. */
export function issueKeyFromResult(raw: unknown): { key?: string; url?: string } {
  if (typeof raw === "string") {
    const key = /\b[A-Z][A-Z0-9_]+-\d+\b/.exec(raw)?.[0]
    const url = /https?:\/\/\S+\/browse\/[A-Z][A-Z0-9_]+-\d+/.exec(raw)?.[0]
    return { key, url }
  }
  if (!isRecord(raw)) return {}
  const r = isRecord(raw.issue) ? raw.issue : raw
  const key = typeof r.key === "string" ? r.key : undefined
  const url = typeof r.url === "string" ? r.url : typeof r.self === "string" && /browse/.test(r.self) ? r.self : undefined
  return key ? { key, url } : issueKeyFromResult(JSON.stringify(raw))
}
