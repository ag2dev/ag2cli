/** Minimal subprocess environment for BashTool. */

import { buildChildEnvironment } from "./child-environment.js"

/**
 * Build the subprocess environment from the host environment without inheriting the entire process.env.
 * Explicitly constrain Git global configuration, the pager, and terminal interaction so user settings do not change read-only query behavior.
 */
export function buildBashEnvironment(command: string): Record<string, string | undefined> {
  const env = buildChildEnvironment()

  env.PAGER = "cat"
  env.GIT_PAGER = "cat"
  env.MANPAGER = "cat"
  env.GIT_TERMINAL_PROMPT = "0"
  env.GIT_CONFIG_NOSYSTEM = "1"
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null"
  env.GIT_OPTIONAL_LOCKS = "0"
  env.GIT_EDITOR = "true"
  env.GIT_SEQUENCE_EDITOR = "true"
  env.NO_COLOR = "1"

  // Fixed Bash invocation never reads user startup files. These variables are
  // removed as an additional defense against profile/environment injection.
  env.BASH_ENV = undefined
  env.ENV = undefined
  env.CDPATH = undefined
  for (const key of Object.keys(env)) {
    if (key.startsWith("BASH_FUNC_")) env[key] = undefined
  }

  // Keep the argument for future command-specific environment policies instead of making callers parse argv again.
  void command
  return env
}

/**
 * Build the environment for an explicit user shell command.
 *
 * `!` is a deliberate user escape hatch, so it follows the user's normal
 * shell environment instead of the model subprocess allowlist. Output limits,
 * cancellation and process-group cleanup remain active for TUI reliability.
 */
export function buildInteractiveBashEnvironment(): Record<string, string | undefined> {
  return { ...process.env }
}
