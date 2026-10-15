/**
 * Read-only Bash template classifier: a conservative whitelist producer.
 * A match labels the preparation with a `bash-read-only-template` fact for
 * the canonical judgment to consume; it never authorizes on its own.
 */
import { isSensitivePathToken } from "../workspace.js"

// Bare invocations are observation-only. Members with write-capable flags
// (find -delete/-exec) are deliberately excluded.
const SINGLE_WORD_TEMPLATES = new Set(["pwd", "ls", "cat", "head", "tail", "wc", "file", "stat", "which", "grep", "du", "df", "echo"])

// Read-only git subcommands. Members whose bare positional arguments write
// refs or config (branch/tag/remote add/reflog expire) are excluded.
const GIT_TEMPLATE_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "blame", "ls-files", "describe", "shortlog", "rev-parse"])

// Any of these characters enables shell behavior beyond a plain word list:
// substitution, chaining, redirection, grouping, brace expansion.
const TEMPLATE_METACHARACTERS = /[$`;&|><()\\+{}\n]/

// "FOO=bar cmd" mutates the environment before the command runs, so argv[0]
// must be the command itself for a template match.
const PREFIX_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

export function classifyReadOnlyTemplate(command: string): boolean {
  if (TEMPLATE_METACHARACTERS.test(command)) return false
  const tokens = command.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  if (PREFIX_ASSIGNMENT.test(tokens[0]!)) return false
  const name = tokens[0]!
  const args = tokens.slice(1)
  if (name === "git") {
    const subcommand = args[0]
    if (subcommand === undefined || !GIT_TEMPLATE_SUBCOMMANDS.has(subcommand)) return false
    // Flags can redirect or otherwise mutate (diff --output), so a template
    // git invocation takes positional revisions and pathspecs only.
    if (args.slice(1).some((arg) => arg.startsWith("-"))) return false
  } else if (!SINGLE_WORD_TEMPLATES.has(name)) {
    return false
  }
  // Paths inside a Bash command are not covered by workspace admission, so
  // the classifier screens arguments itself: tilde forms and sensitive path
  // tokens (.env, .ssh, id_*, *.pem, ...) stay on the ordinary ask path.
  return !args.some((arg) => arg.includes("~") || isSensitivePathToken(arg))
}
