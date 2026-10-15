/**
 * Slash execution host: the state-layer seam that turns one bubbled
 * slash input into view state and host work. Commands execute through
 * the registry (async handlers included); each closed result digests
 * one way — documents and card-bound commands open their card through
 * the store, text results land the feedback surface, theme commits,
 * prompts leave as submissions for the host's run coordination, and
 * clear and exit leave as host effects. The store itself stays
 * synchronous and source-free: every data need arrives as an injected
 * command.
 */
import {
  CORE_SLASH_COMMANDS,
  createSlashCommandRegistry,
  slashNotice,
  unknownSlashNotice,
  type SlashCommandDefinition,
  type SlashInput,
  type SlashResult,
  type SlashCommandRegistry,
} from "./slash.js"
import type { TuiStateEffect, TuiStateStore } from "./store.js"

export interface TuiSlashHostOptions {
  readonly store: TuiStateStore
  /**
   * Registry to execute through — the same instance the store was built
   * with (store options.slash). The store gates submissions on its own
   * registry, so a command only this one knows would die as unknown
   * before it ever bubbles. The core local set when omitted.
   */
  readonly registry?: SlashCommandRegistry
}

/** Why a dispatch may have outlived the submission that issued it. */
export type SlashDispatchStaleReason = "switched" | "torn-down" | "interrupted"

export interface TuiSlashHost {
  /** The command set the registry executes (and /help lists). */
  readonly commands: readonly SlashCommandDefinition[]
  /**
   * Execute one bubbled slash input and digest its result; the returned
   * effects are the host's to run (submissions, transcript clears, exits).
   * The optional staleness probe reports why a dispatch may have outlived
   * its submission — "switched" (another session owns the screen now),
   * "torn-down" (the client itself is gone) or "interrupted" (the
   * dispatch owned the run slot and the user aborted it). Session-scoped
   * view state drops on any reason; a client-scoped text result (scope
   * "client") names the client's own outcome, and the client-local card
   * surfaces (theme palette, workspace diff) classify with it — both
   * survive switch and interrupt, but nothing lands past teardown.
   * Returned effects stay the caller's — the host already owns
   * generation gating for those.
   */
  dispatch(input: SlashInput, signal?: AbortSignal, stale?: () => SlashDispatchStaleReason | null): Promise<readonly TuiStateEffect[]>
}

export function createTuiSlashHost(options: TuiSlashHostOptions): TuiSlashHost {
  const registry = options.registry ?? createSlashCommandRegistry(CORE_SLASH_COMMANDS)
  const commands = registry.commands
  const store = options.store

  const digest = async (
    input: SlashInput,
    signal?: AbortSignal,
    stale?: () => SlashDispatchStaleReason | null,
  ): Promise<readonly TuiStateEffect[]> => {
    const command = registry.resolve(input.name)
    // Session-scoped view state drops once the probe reports the
    // dispatch outlived its submission; a client-scoped text result
    // names the client's own outcome (the resumed destination) and
    // survives every reason but teardown.
    const lands = (clientScope: boolean): boolean => {
      const reason = stale?.() ?? null
      return clientScope ? reason !== "torn-down" : reason === null
    }
    // Client-local surfaces (theme palette, workspace diff) mirror the
    // session-detached sweep's classification: they survive a switch
    // because the client and the workspace do, and die with teardown.
    if (command === undefined) {
      if (lands(false)) store.dispatch({ kind: "slash-notice", notice: unknownSlashNotice(input) })
      return []
    }
    let result: SlashResult | undefined
    try {
      result = await registry.execute(input, {
        signal: signal ?? new AbortController().signal,
        commands,
      })
    } catch (fault) {
      // A throwing handler is one more failure surface, not an
      // unhandled rejection: the user sees the error letter.
      if (lands(false)) {
        store.dispatch({
          kind: "slash-notice",
          notice: slashNotice(input, "error", fault instanceof Error ? fault.message : String(fault)),
        })
      }
      return []
    }
    if (result === undefined || result.type === "none") return []
    if (result.type === "text") {
      if (lands(result.scope === "client")) store.dispatch({ kind: "slash-notice", notice: slashNotice(input, result.kind, result.text) })
      return []
    }
    if (result.type === "document") {
      if (lands(false)) store.dispatch({ kind: "open-doc-card", document: result.document })
      return []
    }
    if (result.type === "theme") return [{ kind: "theme-commit", themeId: result.themeId }]
    if (result.type === "theme-card") {
      if (lands(true)) store.dispatch({ kind: "open-theme-card" })
      return []
    }
    if (result.type === "rewind-card") {
      if (lands(false)) store.dispatch({ kind: "open-rewind-card" })
      return []
    }
    if (result.type === "diff-card") {
      if (lands(true)) store.dispatch({ kind: "open-diff-card", files: result.files })
      return []
    }
    if (result.type === "resume-card") {
      if (lands(false)) store.dispatch({ kind: "open-resume-card", sessions: result.sessions })
      return []
    }
    if (result.type === "permissions-card") {
      if (lands(false)) {
        store.dispatch({ kind: "open-permissions-card", ...(result.initialTab === undefined ? {} : { tab: result.initialTab }) })
      }
      return []
    }
    if (result.type === "submit") return [{ kind: "submit", text: result.text }]
    if (result.type === "clear") return [{ kind: "clear-transcript" }]
    return [{ kind: "exit" }]
  }

  return {
    commands,
    dispatch: (input, signal, stale) => digest(input, signal, stale),
  }
}
