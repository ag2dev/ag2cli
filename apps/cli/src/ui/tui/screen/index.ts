/**
 * Facade for the terminal lifecycle deep module. Cross-module consumers
 * import this index only (tui-r1); the terminal port is injected by the
 * assembly root and nothing under screen/ reaches other modules.
 */
export type {
  ScreenCapabilities,
  ScreenPreparation,
  ScreenSignal,
  ScreenTerminalPort,
  ScreenWriteCallback,
  TerminalScreenOptions,
  TerminalScreen,
  TerminalSize,
} from "./terminal-screen.js"
export { createTerminalScreen, screenCapabilityFromProbe } from "./terminal-screen.js"
