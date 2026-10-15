/** Runtime-facing memory value. Storage and filesystem concerns stay in Host. */
export type MemoryType = "user" | "feedback" | "project" | "reference"
export type MemoryScope = "user" | "team" | "project"

export interface Memory {
  readonly name: string
  readonly description: string
  readonly type: MemoryType
  readonly body: string
  readonly scope?: MemoryScope
  readonly alwaysLoad?: boolean
  readonly path?: string
}

export interface MemoryRoot {
  readonly root: string
  readonly scope: MemoryScope
}
