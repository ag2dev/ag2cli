import { clipText, textWidth, wrapVerbatim, type TextRun } from "../text/index.js"

/** Color the theme task's visible removal and addition sample rows. */
export function paintThemeDiffPreview(
  lines: readonly (readonly TextRun[])[],
  sampleLines: readonly string[],
): readonly (readonly TextRun[])[] {
  return lines.map((line) => {
    const sample = sampleLines.find((candidate) => line.some((run) => run.text.includes(candidate)))
    if (sample === undefined) return line

    const token = sample.startsWith("- ") ? "diffRemoved" : sample.startsWith("+ ") ? "diffAdded" : null
    if (token === null) return line
    return line.map((run) => (run.token === "border" ? run : { ...run, token }))
  })
}

/** Build the selected-theme diff sample for a side preview panel. */
export function themePreviewPanel(sampleLines: readonly string[], width: number, height: number): readonly (readonly TextRun[])[] {
  const panelWidth = Math.max(1, width)
  const samples = [
    { text: "function greet() {", token: "text" as const },
    ...sampleLines.map((text) => ({
      text,
      token: text.startsWith("- ") ? ("diffRemoved" as const) : text.startsWith("+ ") ? ("diffAdded" as const) : ("text" as const),
    })),
    { text: "}", token: "text" as const },
  ]
  const rows: (readonly TextRun[])[] = [
    [{ text: "diff preview · example.ts", token: "title" }],
    [{ text: "─".repeat(panelWidth), token: "border" }],
  ]
  for (const sample of samples) {
    const visible = clipText(sample.text, panelWidth).text
    const pad = Math.max(0, panelWidth - textWidth(visible))
    rows.push([{ text: visible, token: sample.token }, ...(pad === 0 ? [] : [{ text: " ".repeat(pad), token: sample.token }])])
  }
  return padRows(rows, height)
}

/** Build a right-hand prompt preview using the selected history row's body. */
export function promptHistoryPreviewPanel(lines: readonly string[], width: number, height: number): readonly (readonly TextRun[])[] {
  const panelWidth = Math.max(1, width)
  const bodyRows = lines.flatMap((line) => wrapVerbatim(line, panelWidth))
  const rows: (readonly TextRun[])[] = [
    [{ text: "prompt preview", token: "title" }],
    [{ text: "─".repeat(panelWidth), token: "border" }],
    ...bodyRows.map((line) => [{ text: line, token: "muted" as const }]),
  ]
  return padRows(rows, height)
}

function padRows(rows: readonly (readonly TextRun[])[], height: number): readonly (readonly TextRun[])[] {
  const count = Math.max(0, height)
  return [...rows.slice(0, count), ...Array.from({ length: Math.max(0, count - rows.length) }, () => [])]
}
