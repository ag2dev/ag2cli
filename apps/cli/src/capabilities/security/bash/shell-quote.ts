/** Local POSIX quoting for converting an argv into a single Bash command string. */

export type ShellQuoteResult = { success: true; quoted: string } | { success: false; error: string }

function quoteArg(arg: string): string {
  if (arg === "") return "''"
  // Whitespace/quotes/backslash without a single quote: single-quote wrap.
  if (/["\s\\]/.test(arg) && !/'/.test(arg)) return `'${arg}'`
  // Any quote or whitespace (covers args containing single quotes): escape
  // the characters Bash treats specially inside double quotes.
  if (/["'\s]/.test(arg)) return `"${arg.replace(/(["\\$`!])/g, "\\$1")}"`
  // Bare token: backslash-escape the remaining shell metacharacters, keeping
  // Windows drive-letter colons intact.
  return arg.replace(/([A-Za-z]:)?([#!"$&'()*,:;<=>?@[\\\]^`{|}])/g, "$1\\$2")
}

/**
 * Quote an argv into one Bash command string, or fail loudly on values that
 * have no safe shell representation. Callers must treat `success: false` as
 * a hard refusal, never fall back to string concatenation.
 */
export function tryQuoteShellArgs(args: unknown[]): ShellQuoteResult {
  try {
    const validated = args.map((arg, index) => {
      if (arg === null || arg === undefined) return String(arg)
      const type = typeof arg
      if (type === "string") return arg as string
      if (type === "number" || type === "boolean") return String(arg)
      throw new Error(`Cannot quote argument at index ${index}: ${type} values are not supported`)
    })
    return { success: true, quoted: validated.map(quoteArg).join(" ") }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown quote error" }
  }
}
