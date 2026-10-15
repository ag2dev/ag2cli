/**
 * Agent profile port: the named agent definitions the main session loop and
 * `set_agent` consume. Profiles are resolved from the composition's agent
 * catalog; they carry instructions, an optional tool scope and an optional
 * model override.
 */
export interface AgentProfile {
  readonly name: string
  readonly description: string
  readonly instructions: string
  /** Tool names the profile keeps; an empty list inherits the full pool. */
  readonly tools: readonly string[]
  readonly model?: string
}

export interface AgentProfileResolver {
  resolve(name: string): AgentProfile | undefined
}
