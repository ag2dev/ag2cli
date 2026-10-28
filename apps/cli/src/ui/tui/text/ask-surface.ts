import { horizontalTabWindow } from "./horizontal-navigation.js"
import { clipText, textWidth, wrapVerbatim } from "./measure.js"

export type AskSurfaceRowKind =
  "attribution" | "question-tabs" | "question" | "option" | "elision" | "other" | "other-editor" | "submit" | "separator" | "chat" | "hint"

export interface AskSurfaceRow {
  readonly kind: AskSurfaceRowKind
  readonly text: string
  readonly focused?: boolean
  readonly selected?: boolean
  readonly enabled?: boolean
  readonly caretColumn?: number
  readonly optionIndex?: number
}

interface AskSurfaceOption {
  readonly optionId: string
  readonly label: string
  readonly description?: string
}

interface AskSurfaceQuestion {
  readonly question: string
  readonly header?: string
  readonly multiSelect: boolean
  readonly options: readonly AskSurfaceOption[]
}

export interface AskSurfaceInput {
  readonly attribution?: string
  readonly questions: readonly AskSurfaceQuestion[]
  readonly questionIndex: number
  readonly selectedOptionIds: readonly string[]
  readonly armedIndex: number | null
  readonly windowStart: number
  readonly otherText: string
  readonly otherEditing: boolean
  readonly canSubmit: boolean
  readonly ctrlDHint?: boolean
  readonly otherLines?: readonly string[]
  readonly otherCaretColumn?: number
  readonly width: number
  readonly maxRows: number
}

export const ASK_OPTION_WINDOW_COMPACT = 3
export const ASK_OPTION_WINDOW_WIDE = 6

function preview(text: string, width: number, maxRows: number): readonly string[] {
  const lines = wrapVerbatim(text, Math.max(1, width))
  if (lines.length <= maxRows) return lines
  const visible = [...lines.slice(0, maxRows)]
  const last = visible.length - 1
  visible[last] = clipText(`${visible[last]}…`, width).text
  return visible
}

function tabLabel(question: AskSurfaceQuestion, index: number): string {
  return `${index + 1} ${question.header ?? "Question"}`
}

function questionTabs(questions: readonly AskSurfaceQuestion[], activeIndex: number, width: number): string {
  const active = Math.max(0, Math.min(Math.max(0, questions.length - 1), activeIndex))
  const labels = questions.map(tabLabel)
  const window = horizontalTabWindow(labels, active, width)
  const entries = labels.slice(window.start, window.end).map((label, offset) => {
    const index = window.start + offset
    return index === active ? `❮ ${label} ❯` : label
  })
  return [
    ...(window.start > 0 ? ["‹"] : []),
    ...entries,
    ...(window.end < labels.length ? ["›"] : []),
    ...(labels.length > 1 ? [`${active + 1}/${labels.length}`] : []),
  ].join(" · ")
}

/** One bounded Ask surface ledger shared by the coordinator's budget and Ink's rows. */
export function askSurfaceRows(input: AskSurfaceInput): readonly AskSurfaceRow[] {
  const width = Math.max(1, Math.floor(input.width))
  const budget = Math.max(0, Math.floor(input.maxRows))
  const questionIndex = Math.max(0, Math.min(input.questions.length - 1, input.questionIndex))
  const question = input.questions[questionIndex]
  const optionCount = question?.options.length ?? 0
  const otherIndex = optionCount
  const submitIndex = optionCount + 1
  const chatIndex = optionCount + 2
  const compact = width <= 40
  const otherFocused = input.armedIndex === otherIndex
  const hints = input.otherEditing
    ? ["Type answer · arrows edit", "Enter to choices · Esc back"]
    : otherFocused
      ? [compact ? "←→ question · ↑↓ choices" : "←/→ question · ↑/↓ choices", "Enter edit · Esc decline"]
      : [
          compact ? "←→ question · ↑↓ choices · 1-9 pick" : "←/→ question · ↑/↓ choices · 1-9 select",
          question?.multiSelect
            ? compact
              ? "Space/Enter toggle · Esc decline"
              : "Space/Enter toggle · c chat · Esc decline"
            : compact
              ? "Enter select · Esc decline"
              : "Enter select · c chat · Esc decline",
        ]
  if (input.ctrlDHint) hints[hints.length - 1] = "press ctrl+d again to exit"

  const tabRow: AskSurfaceRow = {
    kind: "question-tabs",
    text: questionTabs(input.questions, questionIndex, width),
    focused: true,
  }
  const questionLines =
    question === undefined ? [] : preview(question.question, width, compact ? 2 : 4).map((text) => ({ kind: "question" as const, text }))
  const optionGroups: AskSurfaceRow[][] = []
  if (question !== undefined) {
    const windowSize = compact ? ASK_OPTION_WINDOW_COMPACT : ASK_OPTION_WINDOW_WIDE
    const start = Math.max(0, Math.min(input.windowStart, Math.max(0, optionCount - windowSize)))
    for (let index = start; index < Math.min(optionCount, start + windowSize); index += 1) {
      const option = question.options[index]!
      const focused = input.armedIndex === index
      const selected = input.selectedOptionIds.includes(option.optionId)
      const marker = question.multiSelect ? (selected ? "[x]" : "[ ]") : selected ? "(*)" : "( )"
      const prefix = `${focused ? "›" : " "} ${marker} ${index + 1}. `
      const continuation = " ".repeat(textWidth(prefix))
      const lines: AskSurfaceRow[] = preview(option.label, Math.max(1, width - textWidth(prefix)), compact ? 1 : 2).map(
        (text, lineIndex) => ({
          kind: "option",
          text: `${lineIndex === 0 ? prefix : continuation}${text}`,
          focused,
          selected,
          optionIndex: index,
        }),
      )
      if (option.description !== undefined && option.description.length > 0) {
        for (const text of preview(option.description, Math.max(1, width - 4), compact ? 1 : 2)) {
          lines.push({ kind: "option", text: `    ${text}`, focused, selected, optionIndex: index })
        }
      }
      optionGroups.push(lines)
    }
  }

  const otherLines = input.otherEditing ? (input.otherLines ?? ["❯ "]) : []
  const tail: AskSurfaceRow[] = [
    {
      kind: "other",
      text: `${input.armedIndex === otherIndex ? "›" : " "} Other${input.otherText.length === 0 ? " · Type something" : ` · ${input.otherText.replace(/\s+/gu, " ")}`}`,
      focused: input.armedIndex === otherIndex || input.otherEditing,
      selected: input.otherText.trim().length > 0,
    },
    ...otherLines.slice(0, 1).map((text, index) => ({
      kind: "other-editor" as const,
      text,
      focused: true,
      ...(index === 0 && input.otherCaretColumn !== undefined ? { caretColumn: input.otherCaretColumn } : {}),
    })),
    {
      kind: "submit",
      text: `${input.armedIndex === submitIndex ? "›" : " "} Submit${otherFocused ? "" : " · Enter"}`,
      focused: input.armedIndex === submitIndex,
      enabled: input.canSubmit,
    },
    { kind: "separator", text: "─".repeat(Math.max(1, width)) },
    {
      kind: "chat",
      text: `${input.armedIndex === chatIndex ? "›" : " "} Chat with this context${otherFocused ? "" : " · c"}`,
      focused: input.armedIndex === chatIndex,
    },
    ...hints.map((text) => ({ kind: "hint" as const, text })),
  ]

  // Keep the question and terminal actions visible at the compact floor.
  // Optional attribution and extra previews yield first; choices are then
  // admitted by distance from the focused row, so its label stays present.
  const visibleTail = [...tail]
  if (input.otherEditing) visibleTail.splice(1, 1, { ...visibleTail[1]!, caretColumn: input.otherCaretColumn })
  if (budget < visibleTail.length + 1) visibleTail.splice(-2, 1)
  const fixedTop = [tabRow, ...questionLines]
  let remaining = Math.max(0, budget - fixedTop.length - visibleTail.length)
  const priorities = optionGroups
    .map((group, index) => ({ group, index, focused: group.some((row) => row.focused) }))
    .sort(
      (left, right) =>
        Number(right.focused) - Number(left.focused) ||
        Math.abs(left.index - Math.floor(optionGroups.length / 2)) - Math.abs(right.index - Math.floor(optionGroups.length / 2)),
    )
  const admitted = new Set<number>()
  const visibleOptionsByIndex = new Map<number, readonly AskSurfaceRow[]>()
  for (const { group, index } of priorities) {
    if (remaining <= 0) break
    admitted.add(index)
    const visible = group.slice(0, remaining)
    visibleOptionsByIndex.set(index, visible)
    remaining -= visible.length
  }
  const visibleOptions = optionGroups.flatMap((_, index) => visibleOptionsByIndex.get(index) ?? [])
  const omittedOptions = Math.max(0, optionCount - admitted.size)
  const optionalTop = [
    ...(input.attribution === undefined ? [] : [{ kind: "attribution" as const, text: clipText(input.attribution, width).text }]),
  ]
  const middle = [...visibleOptions]
  if (omittedOptions > 0 && remaining > 0) {
    middle.push({ kind: "elision", text: `… ${omittedOptions} more options` })
    remaining -= 1
  }
  const optional = optionalTop.slice(Math.max(0, optionalTop.length - remaining))
  return [...fixedTop.slice(0, Math.max(0, budget - visibleTail.length)), ...optional, ...middle, ...visibleTail].slice(0, budget)
}
