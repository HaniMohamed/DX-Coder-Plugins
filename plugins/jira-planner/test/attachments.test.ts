import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { convertToMarkdown, processAttachments, sanitizeFilename } from "../src/attachments.js"
import { JiraClient } from "../src/jira.js"
import { startMockJira, type MockJira } from "./mock-jira.js"

const fixtures = new URL("./fixtures/", import.meta.url)
const fixture = (name: string) => readFile(new URL(name, fixtures)).then((b) => new Uint8Array(b))

describe("convertToMarkdown", () => {
  test("docx via mammoth", async () => {
    const out = await convertToMarkdown(await fixture("sample.docx"), "docx", { maxRowsPerSheet: 10 })
    expect(out?.converter).toBe("mammoth")
    expect(out?.markdown).toContain("Invoice export requirements")
  })

  test("pdf via unpdf", async () => {
    const out = await convertToMarkdown(await fixture("sample.pdf"), "pdf", { maxRowsPerSheet: 10 })
    expect(out?.converter).toBe("unpdf")
    expect(out?.markdown).toContain("Hello BRD")
  })

  test("xlsx via exceljs renders sheets as tables and truncates", async () => {
    const ExcelJS = await import("exceljs")
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet("Scope")
    sheet.addRow(["Requirement", "Priority"])
    for (let i = 1; i <= 5; i++) sheet.addRow([`Req ${i}`, i % 2 ? "Must" : "Should"])
    const buffer = new Uint8Array(await wb.xlsx.writeBuffer())
    const out = await convertToMarkdown(buffer, "xlsx", { maxRowsPerSheet: 3 })
    expect(out?.converter).toBe("exceljs")
    expect(out?.markdown).toContain("## Sheet: Scope")
    expect(out?.markdown).toContain("| Requirement | Priority |")
    expect(out?.markdown).toContain("| Req 2 | Should |")
    expect(out?.markdown).toContain("truncated after 3 rows")
  })

  test("text passthrough and unknown types", async () => {
    expect((await convertToMarkdown(new TextEncoder().encode("plain"), "txt", { maxRowsPerSheet: 1 }))?.markdown).toBe("plain")
    expect(await convertToMarkdown(new Uint8Array([1, 2, 3]), "png", { maxRowsPerSheet: 1 })).toBeUndefined()
  })

  test("corrupt docx throws (and is recorded as failed by processAttachments)", async () => {
    await expect(convertToMarkdown(new TextEncoder().encode("not a zip"), "docx", { maxRowsPerSheet: 1 })).rejects.toThrow()
  })
})

describe("sanitizeFilename", () => {
  test("removes path separators and control characters", () => {
    expect(sanitizeFilename("../etc/passwd")).toBe("_._etc_passwd")
    expect(sanitizeFilename("BRD: v2 <final>.docx")).toBe("BRD_ v2 _final_.docx")
    expect(sanitizeFilename("")).toBe("attachment")
  })
})

describe("processAttachments", () => {
  let mock: MockJira
  let dir: string
  beforeAll(async () => {
    mock = startMockJira()
    dir = await mkdtemp(join(tmpdir(), "jira-planner-"))
  })
  afterAll(async () => {
    mock.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test("downloads allowed files, converts them, records skips and reuses the manifest", async () => {
    const client = new JiraClient({ baseUrl: mock.url, authHeader: "Bearer x", authKind: "pat", insecure: false, source: "test" })
    const issue = await client.issue("PROJ-1", ["attachment"])
    const opts = { allowedExtensions: ["txt", "docx"], maxBytes: 1024, maxMarkdownBytes: 10_000, maxRowsPerSheet: 10, banner: (n: string) => `<<<BEGIN ${n}>>>` }
    const manifest = await processAttachments(client, issue.fields.attachment!, dir, opts)
    expect(manifest.map((m) => `${m.name}:${m.status}`)).toEqual(["BRD invoices.txt:converted", "evil.exe:skipped"])
    const md = await readFile(join(dir, manifest[0]!.markdown!), "utf8")
    expect(md).toContain("<<<BEGIN BRD invoices.txt>>>")
    expect(md).toContain("Invoice export BRD")
    expect(md).toContain("<<<END UNTRUSTED ATTACHMENT CONTENT>>>")

    const before = mock.requests.length
    const again = await processAttachments(client, issue.fields.attachment!, dir, opts)
    expect(again[0]).toEqual(manifest[0])
    expect(mock.requests.filter((r) => r.path.includes("/secure/attachment/a1/")).length).toBe(1)
    expect(mock.requests.length).toBe(before)
  })
})
