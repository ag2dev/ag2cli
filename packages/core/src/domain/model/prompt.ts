/**
 * Canonical vocabulary for prompt assembly: system-prompt sections and assembly manifests.
 *
 * Keep only pure data shapes here; assembly logic lives in the prompt/application layer,
 * and provider protocol conversion stays in boundary adapters.
 */

/** System-prompt sections passed through every model call for the entire session. */
export type SystemPrompt = string[]

/** PromptAssembly observation manifest: which named sections and context fragments were enabled. */
export interface PromptAssemblyManifest {
  readonly systemSectionIds: readonly string[]
  readonly contextFragmentIds: readonly string[]
}
