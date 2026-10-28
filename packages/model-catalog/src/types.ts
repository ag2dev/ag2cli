export type ProtocolId = "anthropic" | "openai"

export type InputModality = "text" | "image"

export interface ModelCost {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

export interface ChatModelEntry {
  readonly id: string
  readonly aliases?: readonly string[]
  readonly protocol: ProtocolId
  readonly provider?: string
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly reasoning: boolean
  readonly inputModalities: readonly InputModality[]
  readonly cost?: ModelCost
}

export interface RouteDefaults {
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
}

export interface ProtocolDefaults {
  readonly contextWindow: number
  readonly requestMaxTokens: number
  readonly maxOutputTokens?: number
}

export type ValueSource = "override" | "model" | "route" | "protocol"

export type CeilingSource = "model" | "route" | "protocol"

export interface ModelOverrides {
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
}

export interface ResolvedLimit {
  readonly value: number
  readonly source: ValueSource
}

export interface ResolvedCeiling {
  readonly value?: number
  readonly source?: CeilingSource
}

export interface ResolvedModelInfo {
  readonly matched: boolean
  readonly modelId: string
  readonly contextWindow: ResolvedLimit
  readonly maxOutputTokensCeiling: ResolvedCeiling
  readonly defaultMaxOutputTokens: number
  readonly entry?: ChatModelEntry
}
