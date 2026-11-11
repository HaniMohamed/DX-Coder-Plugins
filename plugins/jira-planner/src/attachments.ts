// Attachment download + conversion to markdown. Every file is processed independently and
// failures are recorded in the manifest instead of aborting the run.

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { extname, join } from "node:path"
import type { JiraAttachment, JiraClient } from "./jira.js"

export type ManifestStatus = "converted" | "downloaded" | "failed" | "skipped"

export interface ManifestEntry {
  id: string
  name: string
  /** Sanitized file name inside attachments/ */
  file: string
  size: number
  mime: string
  status: ManifestStatus
  converter?: string
  /** Markdown file name inside attachments/ (when converted) */
  markdown?: string
  truncated?: boolean
  error?: string
}

export interface AttachmentOptions {
  allowedExtensions: string[]
  maxBytes: number
  maxMarkdownBytes: number
  maxRowsPerSheet: number
  banner: (name: string) => string
}

export const DEFAULT_ALLOWED = ["pdf", "docx", "xlsx", "xlsm", "md", "txt", "csv", "json", "png", "jpg", "jpeg"]
export const TEXT_EXTENSIONS = new Set(["md", "txt", "csv", "json"])

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").trim()
  return cleaned.length > 0 ? cleaned.slice(0, 150) : "attachment"
}

export async function processAttachments(
  client: JiraClient,
  attachments: JiraAttachment[],
  dir: string,
  opts: AttachmentOptions,
  onProgress?: (entry: ManifestEntry) => Promise<void> | void,
): Promise<ManifestEntry[]> {
  await mkdir(dir, { recursive: true })
  const manifestPath = join(dir, "manifest.json")
  const previous = new Map<string, ManifestEntry>()
  if (existsSync(manifestPath)) {
    try {
      for (const e of JSON.parse(await readFile(manifestPath, "utf8")) as ManifestEntry[]) previous.set(e.id, e)
    } catch {
      // A corrupt manifest just means everything is re-downloaded.
    }
  }

  const used = new Set<string>()
  const unique = (file: string) => {
    let candidate = file
    let n = 1
    while (used.has(candidate.toLowerCase())) {
      const ext = extname(file)
      candidate = `${file.slice(0, file.length - ext.length)}-${n++}${ext}`
    }
    used.add(candidate.toLowerCase())
    return candidate
  }

  const manifest: ManifestEntry[] = []
  for (const a of attachments) {
    const file = unique(sanitizeFilename(a.filename))
    const ext = extname(file).slice(1).toLowerCase()
    const base: ManifestEntry = { id: a.id, name: a.filename, file, size: a.size, mime: a.mimeType ?? "", status: "skipped" }

    const reuse = previous.get(a.id)
    if (reuse && reuse.size === a.size && reuse.status !== "failed" && existsSync(join(dir, reuse.file))) {
      manifest.push(reuse)
      continue
    }
    if (!opts.allowedExtensions.includes(ext)) {
      manifest.push({ ...base, error: `extension .${ext || "?"} is not in the allow-list` })
      continue
    }
    if (a.size > opts.maxBytes) {
      manifest.push({ ...base, error: `size ${a.size} bytes exceeds the ${opts.maxBytes} byte limit` })
      continue
    }

    let entry: ManifestEntry
    try {
      const bytes = await client.download(a.content, opts.maxBytes)
      await writeFile(join(dir, file), bytes)
      entry = { ...base, status: "downloaded" }
      const converted = await convertToMarkdown(bytes, ext, { maxRowsPerSheet: opts.maxRowsPerSheet })
      if (converted) {
        const markdownName = `${file}.md`
        let body = converted.markdown
        let truncated = false
        if (Buffer.byteLength(body, "utf8") > opts.maxMarkdownBytes) {
          body = `${Buffer.from(body, "utf8").subarray(0, opts.maxMarkdownBytes).toString("utf8")}\n\n[... truncated at ${opts.maxMarkdownBytes} bytes ...]`
          truncated = true
        }
        const header = [
          `# Attachment: ${a.filename}`,
          "",
          `- Source: Jira attachment ${a.id} on the story (${a.size} bytes, ${a.mimeType ?? "unknown type"})`,
          `- Converted with: ${converted.converter}${truncated ? " (truncated)" : ""}`,
          "",
          opts.banner(a.filename),
          "",
        ].join("\n")
        await writeFile(join(dir, markdownName), `${header}${body}\n\n<<<END UNTRUSTED ATTACHMENT CONTENT>>>\n`)
        entry = { ...entry, status: "converted", converter: converted.converter, markdown: markdownName, truncated }
      }
    } catch (error) {
      entry = { ...base, status: "failed", error: (error as Error).message }
    }
    manifest.push(entry)
    await onProgress?.(entry)
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export interface Converted {
  markdown: string
  converter: string
}

/** Returns undefined for formats that are kept as-is (images) and throws on conversion failure. */
export async function convertToMarkdown(
  bytes: Uint8Array,
  ext: string,
  opts: { maxRowsPerSheet: number },
): Promise<Converted | undefined> {
  switch (ext) {
    case "md":
    case "txt":
    case "csv":
    case "json":
      return { markdown: Buffer.from(bytes).toString("utf8"), converter: "utf-8 passthrough" }
    case "docx": {
      const mammoth = await import("mammoth")
      const result = await mammoth.convertToMarkdown({ buffer: Buffer.from(bytes) })
      return { markdown: result.value, converter: "mammoth" }
    }
    case "xlsx":
    case "xlsm": {
      const ExcelJS = await import("exceljs")
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer)
      const parts: string[] = []
      workbook.eachSheet((sheet) => {
        parts.push(`## Sheet: ${sheet.name}`, "")
        let rows = 0
        let width = 0
        const lines: string[][] = []
        sheet.eachRow({ includeEmpty: false }, (row) => {
          if (rows >= opts.maxRowsPerSheet) return
          const values = (row.values as unknown[]).slice(1).map(cellText)
          width = Math.max(width, values.length)
          lines.push(values)
          rows++
        })
        if (lines.length === 0) {
          parts.push("(empty)", "")
          return
        }
        const pad = (vals: string[]) => [...vals, ...Array(Math.max(0, width - vals.length)).fill("")]
        parts.push(`| ${pad(lines[0]!).join(" | ")} |`)
        parts.push(`|${Array(width).fill("---").join("|")}|`)
        for (const l of lines.slice(1)) parts.push(`| ${pad(l).join(" | ")} |`)
        if (sheet.rowCount > opts.maxRowsPerSheet) parts.push("", `(truncated after ${opts.maxRowsPerSheet} rows of ${sheet.rowCount})`)
        parts.push("")
      })
      return { markdown: parts.join("\n"), converter: "exceljs" }
    }
    case "pdf": {
      const { extractText } = await import("unpdf")
      const result = await extractText(new Uint8Array(bytes), { mergePages: true })
      const text = Array.isArray(result.text) ? result.text.join("\n\n") : result.text
      return { markdown: `${text}\n\n(${result.totalPages} pages)`, converter: "unpdf" }
    }
    default:
      return undefined
  }
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "object") {
    const o = v as { richText?: Array<{ text: string }>; text?: string; result?: unknown; hyperlink?: string }
    if (o.richText) return o.richText.map((r) => r.text).join("")
    if (o.result !== undefined) return cellText(o.result)
    if (o.text !== undefined) return o.text
    if (v instanceof Date) return v.toISOString().slice(0, 10)
  }
  return String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}
