/** Host environment facts required for diagnostics and process defaults. */
export interface RuntimeEnvironment {
  readonly cwd: string
  readonly platform: string
}

export const defaultRuntimeEnvironment: RuntimeEnvironment = {
  get cwd() {
    const processLike = (globalThis as typeof globalThis & { process?: { cwd?: () => string } }).process
    return processLike?.cwd?.() ?? "."
  },
  get platform() {
    return (globalThis as typeof globalThis & { process?: { platform?: string } }).process?.platform ?? "unknown"
  },
}
