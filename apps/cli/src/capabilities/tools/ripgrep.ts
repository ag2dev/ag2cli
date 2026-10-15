/**
 * Low-level ripgrep wrapper.
 *
 * Runtime strategy (decision changed on 2026-10-07; see section 9 of ADR-UNIFIED-CLI-ENTRY-SINGLE-BINARY):
 *  - Prefer the bundled rg next to the actual executable (release tarballs place rg alongside ag2cli).
 *  - In development, use the prebuilt binary provided by @vscode/ripgrep.
 *  - Fall back to the system rg on PATH only as a last resort.
 *  - If none is available, throw a clear error.
 *
 * Currently reads stdout once with execFile; callers already limit the number of results.
 */

import { execFile } from "node:child_process"
import { existsSync, realpathSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

const execFileP = promisify(execFile)
// Use createRequire in ESM to load the CommonJS @vscode/ripgrep package (it has only a CJS entry point).
const require = createRequire(import.meta.url)

/**
 * Resolve the ripgrep binary path: bundled rg → @vscode/ripgrep prebuilt binary → system rg on PATH.
 *
 * Level 1 is relative to the directory containing realpathSync(process.execPath) (when launched through a symlink,
 * execPath is the symlink path). A candidate must be a regular executable file; statSync follows symlinks.
 * A missing candidate, statSync error, or failed predicate counts as a miss and falls through to the next level.
 * This function runs at import time and must not throw at any level.
 */
export function resolveRgPath(execDir: string = dirname(realpathSync(process.execPath))): string {
  // 1. Bundled rg next to the actual executable.
  try {
    const candidate = join(execDir, "rg")
    const st = statSync(candidate)
    if (st.isFile() && (st.mode & 0o111) !== 0) {
      return candidate
    }
  } catch {
    // Fall through to the next level.
  }
  // 2. @vscode/ripgrep prebuilt binary.
  try {
    const mod = require("@vscode/ripgrep") as { rgPath?: string }
    if (mod.rgPath && existsSync(mod.rgPath)) {
      return mod.rgPath
    }
  } catch {
    // Fall through to system rg.
  }
  // 3. rg on the system PATH.
  return "rg"
}

const RG_PATH = resolveRgPath()

/**
 * Execute one ripgrep call.
 *
 * IMPORTANT: In non-interactive mode, rg needs the search path as its final positional argument or it hangs waiting for stdin.
 * Append cwd to args instead of using execFile's {cwd} option, which changes rg's working directory but does not tell it what to search.
 *
 * @param args ripgrep arguments (for example, ['--files', '--glob', '*.ts'] or ['TODO'])
 * @param cwd Search root (appended as the final positional argument)
 * @returns stdout split into lines with empty lines removed
 */
export async function runRipgrep(
  args: string[],
  cwd: string,
  opts: { maxOutputBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string[]> {
  const maxOutputBytes = opts.maxOutputBytes ?? 1_000_000 // 1 MB limit to prevent excessive output.
  const timeoutMs = opts.timeoutMs ?? 15_000
  // Use cwd as the final positional argument (required by rg in non-interactive mode to avoid hanging).
  const fullArgs = [...args, cwd]
  try {
    const { stdout } = await execFileP(RG_PATH, fullArgs, {
      maxBuffer: maxOutputBytes,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    return stdout.split("\n").filter((l) => l.length > 0)
  } catch (err) {
    // ripgrep exit code 1 means no matches (normal); 0 means matches were found. Other codes indicate an actual error.
    const e = err as { code?: number | string; name?: string; killed?: boolean; stderr?: string; message?: string }
    if (e.code === 1) return [] // No matches.
    // Bun's execFile ENOENT shape has code:"ENOENT", a message without "ENOENT", and empty stderr,
    // so check all three signals.
    if (RG_PATH === "rg" && (e.code === "ENOENT" || e.code === 127 || e.message?.includes("ENOENT"))) {
      throw new Error(
        "ripgrep not found: the release package did not include rg, and rg is not on the system PATH. Reinstall ag2cli or install ripgrep on the system.",
      )
    }
    if (opts.signal?.aborted || e.code === "ABORT_ERR" || e.name === "AbortError") {
      throw new DOMException("ripgrep search was cancelled", "AbortError")
    }
    if (e.code === "ETIMEDOUT" || e.killed) {
      throw new Error(`ripgrep timed out after ${timeoutMs} ms`)
    }
    throw new Error(`ripgrep failed: ${e.stderr || e.message || String(err)}`)
  }
}
