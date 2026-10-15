import type { ReadFileState, ReadFileStateEntry } from "@ag2cli/runtime/ports/tool/contract.js"

/** Stores the last content read so write tools can reject stale edits. */
export class ReadFileStateMap implements ReadFileState {
  private map = new Map<string, ReadFileStateEntry>()

  get(path: string): ReadFileStateEntry | undefined {
    return this.map.get(normalizePath(path))
  }

  set(path: string, state: ReadFileStateEntry): void {
    this.map.set(normalizePath(path), state)
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/")
}
