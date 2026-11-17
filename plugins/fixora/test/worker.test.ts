import { describe, expect, test } from "bun:test"
import { sessionTitle } from "../src/worker.js"

const run = { runId: "crashlytics-03b1c433cbee82f20fa674611c638925", source: "crashlytics" as const, crashId: "03b1c433cbee82f20fa674611c638925", title: "pdf_viewer.dart - PdfViewerSizeDelegateLegacy.onLayoutUpdate", jiraKey: undefined }

describe("worker session titles", () => {
  test("before the crash is fetched only the run id is known", () => {
    expect(sessionTitle({ ...run, title: run.runId }, "fixer")).toBe("Fixora fix · crashlytics-03b1c433cbee82f20fa674611c638925")
    expect(sessionTitle({ ...run, title: "" }, "reviewer", { round: 1 })).toBe("Fixora review #1 · crashlytics-03b1c433cbee82f20fa674611c638925")
  })
  test("the crash title with a short source id, then the Jira key once it exists", () => {
    expect(sessionTitle(run, "fixer")).toBe("Fixora fix · crashlytics-03b1c433 · pdf_viewer.dart - PdfViewerSizeDelegateLegacy.onLayoutUpdate")
    expect(sessionTitle({ ...run, jiraKey: "DE-77437" }, "fixer")).toBe("Fixora fix · DE-77437 · pdf_viewer.dart - PdfViewerSizeDelegateLegacy.onLayoutUpdate")
    expect(sessionTitle({ ...run, jiraKey: "DE-77437" }, "reviewer", { round: 2 })).toBe("Fixora review #2 · DE-77437 · pdf_viewer.dart - PdfViewerSizeDelegateLegacy.onLayoutUpdate")
  })
  test("multi-line titles are flattened and long ones clipped to the host's 100 characters", () => {
    const long = sessionTitle({ ...run, title: `Null check operator used on a null value\n   at ${"x".repeat(120)}` }, "fixer")
    expect(long).toHaveLength(100)
    expect(long.endsWith("…")).toBe(true)
    expect(long).toContain("Null check operator used on a null value at xxx")
  })
})
