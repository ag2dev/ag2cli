/**
 * The Resume task: the resumable-session picker. Rows seed at open and
 * re-read the live probe, so a card opened against a cold cache fills
 * when the listing fact lands; Enter resumes through the canonical
 * command (the effect carries the session id; the switch itself is the
 * host's) and the invocation ends the moment the command left. Client
 * scope by declaration, but the kernel ends it on switch and detach —
 * its rows would name bindings the card can no longer adopt.
 */
import type { TuiIntent } from "../../keys/index.js"
import type { ResumeSessionRowView, TaskDefinition, TaskEngineEvent } from "./contracts.js"
import { ChoiceList } from "./choice-list.js"
import { defineTask } from "./contracts.js"

export type ResumeTaskInput = { readonly sessions: readonly ResumeSessionRowView[] }
export type ResumeTaskResult = { readonly kind: "picked"; readonly sessionId: string } | { readonly kind: "closed" }
export type ResumeTaskEffect = { readonly kind: "resume-session"; readonly sessionId: string }
export type ResumeTaskDefinition = TaskDefinition<"resume", ResumeTaskInput, ResumeTaskResult, ResumeTaskEffect>

const LOADING_ROW = "listing sessions…"
const EMPTY_ROW = "no sessions to resume"

function formatCreatedAt(value: string): string {
  const instant = new Date(value)
  return Number.isFinite(instant.valueOf()) ? `${instant.toISOString().slice(0, 16).replace("T", " ")}Z` : value
}

export function createResumeTask(): ResumeTaskDefinition {
  return defineTask({
    kind: "resume",
    scope: "client",
    create(input, kit) {
      const list = new ChoiceList({ window: 8, digits: true })
      const rows = (): readonly ResumeSessionRowView[] => {
        // The probe is the live mirror cache; the seed covers the
        // probe-less harness so the card still renders its input.
        const live = kit.resumeSessions?.()
        return live === undefined || live === null ? input.sessions : live.rows
      }
      const reload = (): void => {
        list.load(
          rows().map((row) => ({
            key: row.sessionId,
            label: `${row.sessionId} · ${row.title?.replace(/\s+/gu, " ").trim() || "Untitled session"} · ${formatCreatedAt(row.createdAt)}`,
          })),
          // Re-seed focus onto the held row so a listing refill never
          // jumps the picker.
          list.focusKey === null ? undefined : { focus: list.focusKey },
        )
      }
      reload()
      const unanswered = (): boolean => kit.resumeSessions !== undefined && kit.resumeSessions() === null
      return {
        title: "Resume",
        scope: "client",
        composerMode: "hidden",
        input,
        identities: () => [],
        handle(intent: TuiIntent): readonly TaskEngineEvent<ResumeTaskResult, ResumeTaskEffect>[] {
          reload()
          const result = list.dispatch(intent)
          if (result.activated && list.chosenKey !== null) {
            return [
              { kind: "effect", effect: { kind: "resume-session", sessionId: list.chosenKey } },
              { kind: "completed", value: { kind: "picked", sessionId: list.chosenKey } },
            ]
          }
          return []
        },
        back: () => "root",
        dirty: () => false,
        steps: () => ["sessions"],
        rows: () => {
          reload()
          // A wired probe that has not answered keeps the loading
          // face even against a seeded list; the seed only speaks
          // without a probe.
          if (unanswered()) return [{ label: LOADING_ROW, focused: false }]
          if (!list.isEmpty) return list.visibleRows()
          // An empty seed without a probe is still loading; an
          // answered empty listing is an honest empty.
          const loading = kit.resumeSessions === undefined && input.sessions.length === 0
          return [{ label: loading ? LOADING_ROW : EMPTY_ROW, focused: false }]
        },
        hints: () => {
          reload()
          return list.hints(["enter resume here"])
        },
      }
    },
  })
}
