/**
 * Reading owner: line measurement, the viewport and pagination — the
 * transcript document model with its bounded cache, the follow/anchor
 * viewport, and the card pager. The detail cache stays with the text
 * kernel and is consumed through its facade.
 */
export {
  MAX_CACHED_BYTES,
  MAX_CACHED_LINES,
  TranscriptLineCache,
  TranscriptLineModel,
  sameToolRenderSource,
  type QueuedPreview,
  type TranscriptChrome,
  type TranscriptLayout,
  type TranscriptLazySegment,
  type TranscriptLineCacheOptions,
  type TranscriptLineSegment,
  type TranscriptLineSpan,
} from "./lines.js"
export {
  FOLLOW_VIEWPORT,
  WHEEL_STEP_LINES,
  resolveViewport,
  viewportIndicator,
  viewportPageDown,
  viewportPageUp,
  viewportPosition,
  viewportResetByContent,
  viewportShowsIndicator,
  viewportWheelDown,
  viewportWheelUp,
  viewportWindow,
  type TranscriptViewport,
  type TranscriptWindow,
} from "./viewport.js"
export { CARD_PAGE_HEIGHT, DocPager } from "./pager.js"
