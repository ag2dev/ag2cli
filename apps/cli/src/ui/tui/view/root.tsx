/**
 * Root of the Ink view tree: binds the framework-free store via
 * useSyncExternalStore and lays out the transcript window, composer
 * (whose rule row carries the scrolled-off indicator while the window
 * is anchored above the tail), the slash feedback surface, the open cards,
 * the one resting-screen hint line and the footer in one column; the
 * open detailed-transcript reader replaces the column with its heading,
 * window and hint. Pure
 * data flow — no terminal access, no
 * canonical events; the frame is a function of the store snapshot and
 * the theme id, both injected by the bootstrap assembly. Below the
 * support floor the whole tree collapses to one
 * diagnostic line — only the interrupt path still reaches the store,
 * and the frame returns when the terminal recovers.
 */
import { useSyncExternalStore } from "react"
import type { ReactElement } from "react"
import { Box, Text } from "ink"
import type { TuiStateStore } from "../state/index.js"
import { SUPPORT_FLOOR, clipText, inkStyle, type ThemeId } from "../text/index.js"
import { CardSurface } from "./card.js"
import { ChildPanel } from "./agents.js"
import { Composer } from "./composer.js"
import { Footer } from "./footer.js"
import { CompletionPickerView } from "./picker.js"
import { Transcript } from "./transcript.js"

/** The floor's numbers live with the chrome kernel; the snapshot carries its decision. */
const TOO_SMALL_DIAGNOSTIC = `terminal too small: need at least ${SUPPORT_FLOOR.columns}x${SUPPORT_FLOOR.rows}`

/**
 * One chrome row clipped to the layout width: the budget counts
 * exactly one row for the hint, each notice line, each visible parked
 * input, the queue's elision counter and the indicator, so the frame
 * never wraps past what it budgeted.
 */
const chromeRow = (text: string, columns: number): string => clipText(text, columns).text

export interface TuiRootProps {
  readonly store: TuiStateStore
  readonly theme: ThemeId
}

export function TuiRoot({ store, theme }: TuiRootProps): ReactElement | null {
  // The subscription stays unconditional: the floor branch below must
  // not reorder hooks when a resize crosses the boundary mid-session.
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  // Geometry is store state: the bootstrap dispatches the terminal size
  // before the first render, so a tree without a layout yet paints
  // nothing rather than guessing a size.
  const layout = snapshot.layout
  if (layout === null) return null
  if (snapshot.supportFloor) {
    return <Text {...inkStyle("muted", [], theme)}>{TOO_SMALL_DIAGNOSTIC}</Text>
  }
  const columns = layout.columns
  const rows = layout.rows
  if (snapshot.toolTranscriptOpen && (snapshot.activeCard === null || snapshot.cardLines.length === 0)) {
    const position = snapshot.toolTranscript.position
    const heading = position === null ? "Detailed transcript" : `Detailed transcript · ${position}`
    const readerHint = "↑↓/wheel scroll · PgUp/PgDn page · bottom follows · Esc/Ctrl+O back"
    const hint = snapshot.hint === null ? readerHint : `${snapshot.hint} · Esc/Ctrl+O back`
    return (
      <Box flexDirection="column" height={rows}>
        <Text {...inkStyle("accent", [], theme)}>{chromeRow(heading, columns)}</Text>
        <Transcript lines={snapshot.toolTranscript.lines} start={snapshot.toolTranscript.start} theme={theme} />
        <Text {...inkStyle("muted", [], theme)}>{chromeRow(hint, columns)}</Text>
      </Box>
    )
  }
  const completionVisible = snapshot.completion !== null
  const notice = snapshot.slashNotice
  // The focused child panel replaces the transcript surface; the main
  // window's indicator hides beneath it.
  const indicator = snapshot.childPanel === null ? snapshot.transcript.indicator : null
  return (
    <Box flexDirection="column">
      {snapshot.childPanel !== null ? (
        <ChildPanel panel={snapshot.childPanel} columns={columns} theme={theme} />
      ) : snapshot.introLines.length > 0 ? (
        <Box flexDirection="column">
          {snapshot.introLines.map((line, index) => (
            <Text key={`${index}:${line}`} {...inkStyle("muted", [], theme)}>
              {chromeRow(line, columns)}
            </Text>
          ))}
        </Box>
      ) : (
        <Transcript lines={snapshot.transcript.lines} start={snapshot.transcript.start} theme={theme} />
      )}
      {completionVisible ? <CompletionPickerView window={snapshot.completion} columns={columns} theme={theme} /> : null}
      {(() => {
        // The store derives the bounded prefix and the elision count at
        // queue ingress; the frame paints exactly what the snapshot carries.
        const queued = snapshot.queued
        if (queued.visible.length === 0) return null
        return (
          <Box flexDirection="column">
            {queued.visible.map((text, index) => (
              <Text key={`${index}:${text}`} {...inkStyle("muted", [], theme)}>
                {chromeRow(text, columns)}
              </Text>
            ))}
            {queued.elided > 0 ? (
              <Text {...inkStyle("muted", [], theme)}>{chromeRow(`… +${queued.elided} more queued`, columns)}</Text>
            ) : null}
          </Box>
        )
      })()}
      {notice === null ? null : (
        <Box flexDirection="column">
          <Text {...inkStyle(notice.kind === "error" ? "error" : "muted", [], theme)}>{chromeRow(notice.title, columns)}</Text>
          <Text {...inkStyle(notice.kind === "error" ? "error" : "muted", [], theme)}>{chromeRow(notice.body, columns)}</Text>
        </Box>
      )}
      {snapshot.activeCard === null ? null : <CardSurface lines={snapshot.cardLines} theme={theme} />}
      <Composer
        editor={snapshot.editor}
        columns={columns}
        rows={rows}
        prefixRows={snapshot.composerPrefix}
        bodyRows={snapshot.composerRows}
        theme={theme}
        completionVisible={completionVisible}
        cursorVisible={snapshot.cursorVisible}
        indicator={indicator}
      />
      {snapshot.hint === null ? null : <Text {...inkStyle("muted", [], theme)}>{chromeRow(snapshot.hint, columns)}</Text>}
      {snapshot.agentsSummary === null ? null : <Text {...inkStyle("muted", [], theme)}>{chromeRow(snapshot.agentsSummary, columns)}</Text>}
      <Footer footer={snapshot.footer} columns={columns} theme={theme} />
    </Box>
  )
}
