/**
 * FileEdit algorithm helpers.
 *
 * These functions implement pure algorithms required for file editing:
 *  - normalizeQuotes: convert curly quotes to straight quotes (the model may output curly quotes while the file uses straight quotes)
 *  - findActualString: try an exact match first, then a quote-normalized match, and return the actual string from the file
 *  - preserveQuoteStyle: if old_string matched after quote normalization, apply the file's curly-quote style to new_string
 *
 * All functions are side-effect-free for easy unit testing and reuse.
 */

// Curly-quote constants (a common difference between model output and file contents).
const LEFT_SINGLE_CURLY = "‘"
const RIGHT_SINGLE_CURLY = "’"
const LEFT_DOUBLE_CURLY = "“"
const RIGHT_DOUBLE_CURLY = "”"

export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY, "'")
    .replaceAll(RIGHT_SINGLE_CURLY, "'")
    .replaceAll(LEFT_DOUBLE_CURLY, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY, '"')
}

/**
 * Find the actual string in file contents that matches searchString, allowing quote normalization.
 * @returns The matched string from the file (used to preserve its quote style during replacement), or null if no match is found.
 */
export function findActualString(fileContent: string, searchString: string): string | null {
  // 1. Exact match.
  if (fileContent.includes(searchString)) {
    return searchString
  }
  // 2. Match after quote normalization.
  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)
  const idx = normalizedFile.indexOf(normalizedSearch)
  if (idx !== -1) {
    return fileContent.substring(idx, idx + searchString.length)
  }
  return null
}

/**
 * If old_string matched through quote normalization (curly quotes in the file, straight quotes in the model),
 * apply the file's curly-quote style to new_string to preserve the file's formatting.
 *
 * Opening/closing heuristic: whitespace, start of string, or an opening bracket before the quote means opening; otherwise closing.
 */
export function preserveQuoteStyle(newString: string, fileActualOld: string): string {
  // Transfer the curly-quote positions from actualOld to the corresponding straight quotes in newString.
  const curlyPairs: Array<[string, string]> = [
    [LEFT_SINGLE_CURLY, RIGHT_SINGLE_CURLY],
    [LEFT_DOUBLE_CURLY, RIGHT_DOUBLE_CURLY],
  ]
  let result = newString
  for (const [open, close] of curlyPairs) {
    if (!fileActualOld.includes(open) && !fileActualOld.includes(close)) continue
    // Simple replacement: alternate opening and closing curly quotes for straight quotes in newString.
    let openNext = true
    result = result.replace(/['"]/g, (m) => {
      const isSingle = m === "'"
      const pair = isSingle ? [LEFT_SINGLE_CURLY, RIGHT_SINGLE_CURLY] : [LEFT_DOUBLE_CURLY, RIGHT_DOUBLE_CURLY]
      const ch = openNext ? pair[0]! : pair[1]!
      openNext = !openNext
      return ch
    })
  }
  return result
}
