/**
 * Argv routing contract for the unified `ag2cli` entry: classify the process
 * arguments into exactly one business mode. Pure classification — help and
 * version text live here; execution and error envelopes stay in the
 * entrypoints. Anything unrecognized is forwarded verbatim to the headless
 * parser so hidden commands and unknown-command errors keep their existing
 * byte-identical behavior.
 */

/** Brand for the public entry; hidden passthrough keeps the legacy "agent". */
export type InvocationName = "agent" | "ag2cli"

export const AG2CLI_INVOCATION: InvocationName = "ag2cli"

export type UnifiedCliRoute =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "tui"; readonly args: readonly string[] }
  | { readonly kind: "run" | "serve"; readonly args: readonly string[] }
  | { readonly kind: "acp"; readonly args: readonly string[] }
  | { readonly kind: "headless"; readonly args: readonly string[] }

export const UNIFIED_CLI_HELP = `Usage:
  ag2cli                  start the interactive TUI (default)
  ag2cli tui [options]    start the interactive TUI explicitly
  ag2cli run <goal | -> [options]    run one non-interactive agent run
  ag2cli serve [options]  start the App Server

Options:
  --version               print the version and exit
  --help, -h              show this help

Run ag2cli <command> --help for command options. Non-interactive
environments should call ag2cli run explicitly.`

export function routeUnifiedCliArgs(argv: readonly string[]): UnifiedCliRoute {
  const [first, ...rest] = argv
  if (first === "--help" || first === "-h") return { kind: "help" }
  if (first === "--version") return { kind: "version" }
  if (first === "tui") return { kind: "tui", args: rest }
  if (first === "run" || first === "serve") return { kind: first, args: rest }
  if (first === "acp") return { kind: "acp", args: rest }
  if (first === undefined || first.startsWith("-")) return { kind: "tui", args: argv }
  return { kind: "headless", args: argv }
}
