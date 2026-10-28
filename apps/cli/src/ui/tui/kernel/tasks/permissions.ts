/**
 * The Permissions task: the six-tab permission card. The tab strip is
 * the top level (left/right clamp without wrapping), each tab's list
 * the second; digits address the tabs directly. Mode rows submit
 * through the same canonical throat as the direct grammar and
 * permission cycling, rule rows commit the complete rule set composed
 * against the canonical mirror (Enter cycles the behavior, x/d
 * delete, a closes into a composer draft), and the read-only tabs
 * render the denial ledger and the authorized workspace scope. Every
 * fact is read live from the kit probe, so canonical echoes and
 * operation outcomes land without an inbound channel.
 */
import type { TuiIntent } from "../../keys/index.js"
import { horizontalTabDirection, moveHorizontalTab } from "../../text/index.js"
import type { PermissionRuleView, PermissionTaskFacts, TaskDefinition, TaskEngineEvent } from "./contracts.js"
import { noPermissionFacts } from "./contracts.js"
import { defineTask } from "./contracts.js"

/** The rotation ring order shared by keyboard cycling and the Mode tab. */
export const PERMISSION_MODE_RING: readonly string[] = ["manual", "accept-edits", "plan", "full-access", "auto"]

/** The next ring member the current mode rotates onto; null when nothing is selectable. */
export function nextPermissionMode(current: string, selectableModes: readonly string[]): string | null {
  const available = PERMISSION_MODE_RING.filter((mode) => selectableModes.includes(mode))
  if (available.length === 0) return null
  const index = available.indexOf(current)
  return available[index < 0 ? 0 : (index + 1) % available.length]!
}

export type PermissionsTab = "mode" | "recently-denied" | "allow" | "ask" | "deny" | "workspace"

export type PermissionsTaskInput = { readonly initialTab?: PermissionsTab }
export type PermissionsTaskResult = { readonly kind: "closed" } | { readonly kind: "draft"; readonly draft: string }
export type PermissionsTaskEffect =
  | { readonly kind: "permission-mode"; readonly mode: string }
  | { readonly kind: "permission-rules"; readonly rules: readonly PermissionRuleView[]; readonly baseline: readonly PermissionRuleView[] }
export type PermissionsTaskDefinition = TaskDefinition<"permissions", PermissionsTaskInput, PermissionsTaskResult, PermissionsTaskEffect>

const TABS: readonly { readonly id: PermissionsTab; readonly label: string }[] = [
  { id: "mode", label: "Mode" },
  { id: "recently-denied", label: "Recently denied" },
  { id: "allow", label: "Allow" },
  { id: "ask", label: "Ask" },
  { id: "deny", label: "Deny" },
  { id: "workspace", label: "Workspace" },
]
const RULE_TABS: ReadonlySet<PermissionsTab> = new Set(["allow", "ask", "deny"])
const RULE_FLOOR_LINE = "Deny rules and Plan mode override Allow rules."
const RULE_ADD_DRAFT = "/permissions rules add "
/** The surfaced row window; long ledgers slide with the focus instead of outgrowing the card. */
const ROW_WINDOW = 7
const EMPTY_ROW = "(none)"
const CYCLE: Readonly<Record<PermissionRuleView["behavior"], PermissionRuleView["behavior"]>> = {
  allow: "ask",
  ask: "deny",
  deny: "allow",
}

type Level = "tabs" | "list"

/** One addressable row: a stable key when the row names a fact, null for placeholders. */
interface CardRow {
  readonly key: string | null
  readonly label: string
}

export function createPermissionsTask(): PermissionsTaskDefinition {
  return defineTask({
    kind: "permissions",
    scope: "session",
    create(input, kit) {
      const facts = (): PermissionTaskFacts => kit.permissions?.() ?? noPermissionFacts
      const seededTab = TABS.findIndex((tab) => tab.id === input.initialTab)
      let tabIndex = seededTab >= 0 ? seededTab : 0
      let level: Level = "tabs"
      const focus: Partial<Record<PermissionsTab, number>> = {}
      let inline: string | null = null

      const tabRows = (tab: PermissionsTab): readonly CardRow[] => {
        const mirror = facts().mirror
        if (tab === "mode") {
          if (mirror === null) return [{ key: null, label: "permissions not reported by host yet" }]
          return PERMISSION_MODE_RING.filter((mode) => mirror.selectableModes.includes(mode)).map((mode) => ({
            key: mode,
            label: mode === mirror.currentMode ? `${mode} · current` : mode,
          }))
        }
        if (tab === "recently-denied") {
          const ledger = mirror?.deniedLedger ?? []
          if (ledger.length === 0) return [{ key: null, label: EMPTY_ROW }]
          return ledger.map((denial) => ({
            key: `${denial.toolName}:${denial.code}`,
            label: `${denial.toolName} · ${denial.code}${denial.reason === undefined ? "" : ` · ${denial.reason}`}`,
          }))
        }
        if (RULE_TABS.has(tab)) {
          const rules = (mirror?.rules ?? []).filter((rule) => rule.behavior === tab)
          if (rules.length === 0) return [{ key: null, label: EMPTY_ROW }]
          const submission = facts().rulesSubmission
          return rules.map((rule) => ({
            key: rule.name,
            label:
              submission !== null && submission.status === "pending" && submission.names.includes(rule.name)
                ? `${rule.name} · applying`
                : rule.name,
          }))
        }
        const scope = [
          ...(mirror?.workspaceRoot === null || mirror?.workspaceRoot === undefined ? [] : [mirror.workspaceRoot]),
          ...(mirror?.directories ?? []),
        ]
        if (scope.length === 0) return [{ key: null, label: EMPTY_ROW }]
        return scope.map((path, index) => ({ key: `${index}:${path}`, label: index === 0 ? `root ${path}` : `additional ${path}` }))
      }

      const listFocus = (rows: readonly CardRow[]): number =>
        Math.min(Math.max(0, focus[TABS[tabIndex]!.id] ?? 0), Math.max(0, rows.length - 1))

      const submissionHints = (): string[] => {
        const { modeSubmission, rulesSubmission } = facts()
        const hints: string[] = []
        if (modeSubmission !== null && modeSubmission.status !== "applied")
          hints.push(`mode change ${modeSubmission.status === "pending" ? "applying" : modeSubmission.status}`)
        if (rulesSubmission !== null && rulesSubmission.status !== "applied")
          hints.push(`rules change ${rulesSubmission.status === "pending" ? "applying" : rulesSubmission.status}`)
        return hints
      }

      const composeRuleEdit = (
        name: string,
        edit: (row: PermissionRuleView, baseline: readonly PermissionRuleView[]) => readonly PermissionRuleView[] | null,
      ): readonly TaskEngineEvent<PermissionsTaskResult, PermissionsTaskEffect>[] => {
        const mirror = facts().mirror
        if (mirror === null) {
          inline = "permissions not reported by host yet"
          return []
        }
        const row = mirror.rules.find((rule) => rule.name === name)
        if (row === undefined) {
          // A vanished row is never a silent no-op: the mirror moved under the card.
          inline = `no rule for ${name}`
          return []
        }
        const rules = edit(row, mirror.rules)
        if (rules === null) return []
        return [{ kind: "effect", effect: { kind: "permission-rules", rules, baseline: mirror.rules } }]
      }

      return {
        title: "Permissions",
        scope: "session",
        composerMode: "hidden",
        input,
        identities: () => [],
        handle(intent: TuiIntent): readonly TaskEngineEvent<PermissionsTaskResult, PermissionsTaskEffect>[] {
          inline = null
          const tab = TABS[tabIndex]!.id
          const tabDirection = horizontalTabDirection(intent)
          if (tabDirection !== null && (intent.kind !== "navigate" || level === "tabs")) {
            tabIndex = moveHorizontalTab(tabIndex, TABS.length, tabDirection)
            return []
          }
          if (intent.kind === "input" && intent.event.type === "char" && intent.event.value >= "1" && intent.event.value <= "6") {
            tabIndex = Number(intent.event.value) - 1
            return []
          }
          if (intent.kind === "navigate") {
            const direction = intent.direction
            if (direction === "left" || direction === "right") return []
            const down = direction === "down" || direction === "page-down"
            const up = direction === "up" || direction === "page-up"
            if (!down && !up) return []
            if (level === "tabs") {
              if (down) level = "list"
              return []
            }
            const rows = tabRows(tab)
            const index = listFocus(rows)
            if (up && index === 0) {
              level = "tabs"
              return []
            }
            focus[tab] = Math.min(rows.length - 1, Math.max(0, index + (down ? 1 : -1)))
            return []
          }
          if (intent.kind === "activate") {
            if (level !== "list") return []
            const rows = tabRows(tab)
            const row = rows[listFocus(rows)]
            if (row?.key == null) return []
            if (tab === "mode") return [{ kind: "effect", effect: { kind: "permission-mode", mode: row.key } }]
            if (RULE_TABS.has(tab))
              return composeRuleEdit(row.key, (focused, baseline) =>
                baseline.map((rule) => (rule.name === focused.name ? { name: focused.name, behavior: CYCLE[focused.behavior] } : rule)),
              )
            return []
          }
          if (intent.kind === "input" && intent.event.type === "char" && level === "list" && RULE_TABS.has(tab)) {
            const rows = tabRows(tab)
            const row = rows[listFocus(rows)]
            if (row?.key == null) return []
            const key = intent.event.value
            if (key === "x" || key === "d")
              return composeRuleEdit(row.key, (_, baseline) => baseline.filter((rule) => rule.name !== row.key))
            if (key === "a") return [{ kind: "completed", value: { kind: "draft", draft: RULE_ADD_DRAFT } }]
            return []
          }
          return []
        },
        back: () => "root",
        dirty: () => false,
        steps: () => [],
        tabs: () => ({ labels: TABS.map((entry) => entry.label), activeIndex: tabIndex, focused: level === "tabs" }),
        rows: () => {
          const rows = tabRows(TABS[tabIndex]!.id)
          const index = listFocus(rows)
          const start = Math.min(Math.max(0, index - ROW_WINDOW + 1), Math.max(0, rows.length - ROW_WINDOW))
          return rows.slice(start, start + ROW_WINDOW).map((row, position) => ({
            label: row.label,
            focused: level === "list" && start + position === index,
          }))
        },
        body: () => (RULE_TABS.has(TABS[tabIndex]!.id) ? [RULE_FLOOR_LINE] : []),
        hints: () => {
          const hints = submissionHints()
          if (inline !== null) hints.push(inline)
          if (level === "tabs") return [...hints, "Tab page · ↓ body · Esc back"]
          const tab = TABS[tabIndex]!.id
          const rows = tabRows(tab)
          const index = listFocus(rows)
          const returnHint = index === 0 ? "↑ tabs" : "↑ prev"
          if (tab === "mode") return [...hints, `Esc back · ${returnHint} · ↵ switch`]
          if (RULE_TABS.has(tab) && rows[index]?.key != null) return [...hints, "Esc back · ↵ cycle · x del · a add"]
          if (RULE_TABS.has(tab)) return [...hints, `Esc back · ${returnHint}`]
          return [...hints, `Esc back · ${returnHint} · read only`]
        },
      }
    },
  })
}
