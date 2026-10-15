/**
 * Text kernel facade: grapheme-safe measurement/wrapping, the bounded
 * markdown renderer, the transcript line kernel, card chrome and the
 * framed-card renderer, the closed 13-token × 6-theme table,
 * sanitization, and the Ink style bridge. Everything here is
 * framework-free and pure; the bridge output is plain props, so
 * React stays in the view layer.
 */
export {
  clipText,
  expandTabs,
  graphemeWidth,
  graphemes,
  measureVerbatim,
  textWidth,
  verbatimRowSpans,
  wrapVerbatim,
  wrapVerbatimRange,
} from "./measure.js"
export { formatDuration } from "./duration.js"
export { createToolDetailCache, type ToolDetailCache, type ToolDetailCacheBounds } from "./detail-cache.js"
export {
  measureDetailedTranscriptSource,
  renderDetailedTranscriptSource,
  renderDetailedTranscriptSourceRange,
  renderTranscriptSource,
  transcriptRenderSources,
  type TranscriptLine,
  type TranscriptRenderSource,
  type TranscriptSessionInput,
  type TranscriptTailInput,
  type TranscriptToolInput,
} from "./transcript.js"
export { renderMarkdownRuns, renderMarkdownRunsRange, type MarkdownRenderPhase, type MarkdownRunsRange } from "./markdown.js"
export { FRAME_FLOOR_COLUMNS, SUPPORT_FLOOR, breadcrumbRow, frameBox, frameInnerWidth, hintRow, tabRow } from "./chrome.js"
export { CARD_ROW_CAP, renderCardLines, type CardView } from "./card.js"
export { wrapFooterSegments } from "./footer.js"
export { textRunsEqual, THEME_IDS, THEMES, type TextOverlay, type TextRun, type TextToken, type ThemeId } from "./theme.js"
export { sanitizeText } from "./sanitize.js"
export { serializeRuns } from "./serialize.js"
export { inkRun, inkStyle, type InkTextStyle } from "./ink.js"
