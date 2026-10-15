/**
 * Terminal duration text for status rows: milliseconds read as-is,
 * seconds to one decimal, minutes and seconds past the minute mark.
 */

/** Format a duration in milliseconds as compact status-row text. */
export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`
  return `${Math.floor(durationMs / 60_000)}m${Math.round((durationMs % 60_000) / 1000)}s`
}
