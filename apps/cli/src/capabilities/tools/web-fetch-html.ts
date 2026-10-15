/**
 * Coarse HTML-to-text converter for web_fetch (ADR-WEB-FETCH-TOOL-001 §4).
 *
 * A single-pass tokenizer plus one per-name LIFO pairing pass; every scan
 * advances monotonically (indexOf or bounded character windows), so any
 * hostile input converts in linear time — there is no regex backtracking.
 * Tag ends skip quoted attribute values; script/style blocks (never
 * self-closing, with validated close boundaries), comments and tags are
 * dropped; headings, links and code are kept in a coarse markdown form;
 * each entity reference decodes exactly once.
 */

type Token =
  | { readonly kind: "text"; readonly raw: string }
  | { readonly kind: "open"; readonly name: string; readonly attrs: string; readonly selfClosing: boolean }
  | { readonly kind: "close"; readonly name: string }

const TAG_NAME = /[a-zA-Z][a-zA-Z0-9-]*/y

const BLOCK_TAGS: ReadonlySet<string> = new Set(["p", "div", "li", "tr", "section", "article", "blockquote", "ul", "ol", "table"])

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

function isHeading(name: string): number | undefined {
  return /^h[1-6]$/.test(name) ? Number(name.slice(1)) : undefined
}

function parseTagAt(
  html: string,
  nameStart: number,
  close: number,
): { name: string; attrs: string; end: number; selfClosing: boolean } | undefined {
  TAG_NAME.lastIndex = nameStart
  const name = TAG_NAME.exec(html)?.[0]
  if (name === undefined) return undefined
  const attrs = html.slice(nameStart + name.length, close)
  // Self-closing only for a standalone trailing slash; a '/' at the end of
  // an unquoted value (`href=foo/`) belongs to the value.
  return { name: name.toLowerCase(), attrs, end: close + 1, selfClosing: /(?:^|\s)\/$/.test(attrs) }
}

/**
 * End index (past `>`) of a real case-insensitive close tag for script/style.
 * A boundary character is required after the name, so `</scripty>` does not
 * close a script block (matching the HTML tokenizer: the block stays open
 * and content stays dropped).
 */
const CLOSE_TAG_PATTERN: Readonly<Record<"script" | "style", RegExp>> = {
  script: /<\/script(?=[\s/>]|$)/gi,
  style: /<\/style(?=[\s/>]|$)/gi,
}

function findBlockEnd(html: string, from: number, name: "script" | "style"): number {
  const pattern = CLOSE_TAG_PATTERN[name]
  pattern.lastIndex = from
  const match = pattern.exec(html)
  if (match === null) return -1
  const close = findTagClose(html, match.index, html.length)
  return close < 0 ? html.length : close + 1
}

/** Index of the first `>` at or after `from` (before `limit`) outside quoted spans. */
function findTagClose(html: string, from: number, limit: number): number {
  let quote = ""
  for (let p = from; p < limit; p++) {
    const ch = html[p]
    if (quote !== "") {
      if (ch === quote) quote = ""
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ">") {
      return p
    }
  }
  return -1
}

/** Peeks (case-insensitively) whether the tag name at `at` is script/style. */
function peekRawTextName(html: string, at: number): "script" | "style" | undefined {
  for (const name of ["script", "style"] as const) {
    if (html.slice(at, at + name.length).toLowerCase() !== name) continue
    const after = html.charAt(at + name.length)
    const continues = (after >= "a" && after <= "z") || (after >= "A" && after <= "Z") || (after >= "0" && after <= "9") || after === "-"
    if (!continues) return name
  }
  return undefined
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = []
  let textStart = 0
  const flush = (end: number): void => {
    if (end > textStart) tokens.push({ kind: "text", raw: html.slice(textStart, end) })
  }
  // Monotonic scan: every search resumes where the last one ended, so no
  // input can make the scan quadratic. A '<' only starts a tag when an
  // unquoted '>' closes it before the next '<'; a tag whose quoted values
  // hide the '>' or contain a raw '<' is treated as text — except that a
  // script/style open is closed by one unbounded quote-aware scan instead
  // (quoted values may legally contain '<'), because demoting its open to
  // text would leak the block's body as page text.
  let i = 0
  while (true) {
    const lt = html.indexOf("<", i)
    if (lt < 0) break
    i = lt + 1
    const next = html.charAt(lt + 1)
    if (next === "!") {
      flush(lt)
      if (html.startsWith("<!--", lt)) {
        const end = html.indexOf("-->", lt + 2)
        if (end < 0) return tokens
        i = end + 3
      } else {
        const close = findTagClose(html, lt + 1, html.length)
        if (close < 0) return tokens
        i = close + 1
      }
      textStart = i
      continue
    }
    const nameStart = next === "/" ? lt + 2 : lt + 1
    const lead = html.charAt(nameStart)
    const isNameStart = (lead >= "a" && lead <= "z") || (lead >= "A" && lead <= "Z")
    if (!isNameStart) continue
    const rawText = next === "/" ? undefined : peekRawTextName(html, nameStart)
    const limit = rawText === undefined ? html.indexOf("<", lt + 1) : html.length
    const close = findTagClose(html, nameStart, limit < 0 ? html.length : limit)
    if (close < 0) {
      // EOF inside an open tag drops the rest of the input; for raw-text
      // elements that is the only spec-honoring outcome.
      if (rawText !== undefined) return tokens
      continue
    }
    const parsed = parseTagAt(html, nameStart, close)
    if (parsed === undefined) continue
    if (rawText !== undefined) {
      // script/style are never self-closing: the content always drops to
      // the validated close tag or the end of input.
      flush(lt)
      const end = findBlockEnd(html, parsed.end, rawText)
      if (end < 0) return tokens
      i = end
      textStart = i
      continue
    }
    flush(lt)
    tokens.push(
      next === "/"
        ? { kind: "close", name: parsed.name }
        : { kind: "open", name: parsed.name, attrs: parsed.attrs, selfClosing: parsed.selfClosing },
    )
    i = parsed.end
    textStart = i
  }
  flush(html.length)
  return tokens
}

/** First href attribute value: double-quoted, single-quoted or bare token. */
function extractHref(attrs: string): string | undefined {
  const match = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/i.exec(attrs)
  if (match === null) return undefined
  return match[1] ?? match[2] ?? match[3]
}

function decodeEntityAt(text: string, at: number): { value: string; length: number } | undefined {
  // The longest body is 7 characters ("#x1F600"), so the ';' scan is bounded.
  const limit = Math.min(text.length, at + 11)
  let semi = -1
  for (let p = at + 1; p < limit; p++) {
    if (text[p] === ";") {
      semi = p
      break
    }
  }
  if (semi < 0) return undefined
  const body = text.slice(at + 1, semi)
  if (body.startsWith("#")) {
    const digits = body.slice(1)
    const code = /^\d{1,8}$/.test(digits)
      ? Number.parseInt(digits, 10)
      : /^[xX][0-9a-fA-F]{1,6}$/.test(digits)
        ? Number.parseInt(digits.slice(1), 16)
        : undefined
    if (code === undefined) return undefined
    // Numeric references for null, surrogates and out-of-range code points
    // decode to the replacement character, per the HTML tokenizer.
    const value = code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\u{fffd}" : String.fromCodePoint(code)
    return { value, length: semi - at + 1 }
  }
  const named = NAMED_ENTITIES[body.toLowerCase()]
  return named === undefined ? undefined : { value: named, length: semi - at + 1 }
}

/** Decode each entity reference exactly once, left to right. */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text
  let out = ""
  let i = 0
  while (true) {
    const amp = text.indexOf("&", i)
    if (amp < 0) break
    out += text.slice(i, amp)
    const decoded = decodeEntityAt(text, amp)
    if (decoded === undefined) {
      out += "&"
      i = amp + 1
      continue
    }
    out += decoded.value
    i = amp + decoded.length
  }
  return out + text.slice(i)
}

function wrapperFor(token: Extract<Token, { kind: "open" }>): { prefix: string; suffix: string } | undefined {
  if (token.name === "a") {
    const href = extractHref(token.attrs)
    if (href === undefined) return undefined
    return { prefix: "[", suffix: `](${decodeEntities(href)})` }
  }
  if (token.name === "pre") return { prefix: "\n\n```\n", suffix: "\n```\n\n" }
  if (token.name === "code") return { prefix: "`", suffix: "`" }
  const level = isHeading(token.name)
  if (level !== undefined) return { prefix: `\n\n${"#".repeat(level)} `, suffix: "\n\n" }
  return undefined
}

/** Convert an HTML document to coarse text in linear time on any input. */
export function convertHtmlToText(html: string): string {
  const tokens = tokenize(html)
  // Per-name LIFO pairing: for each open, the index of its close and vice
  // versa. A close whose open is already gone is stray.
  const matchClose = new Int32Array(tokens.length).fill(-1)
  const matchOpen = new Int32Array(tokens.length).fill(-1)
  const openStacks = new Map<string, number[]>()
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind === "open") {
      if (token.selfClosing) continue
      const stack = openStacks.get(token.name)
      if (stack === undefined) openStacks.set(token.name, [i])
      else stack.push(i)
    } else if (token.kind === "close") {
      const open = openStacks.get(token.name)?.pop()
      if (open !== undefined) {
        matchClose[open] = i
        matchOpen[i] = open
      }
    }
  }
  let out = ""
  // Mis-nested closes implicitly end every wrapper opened after their open
  // (HTML implied end tags), so no suffix is ever lost.
  const wrappers: { openIdx: number; suffix: string }[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind === "text") {
      out += decodeEntities(token.raw)
      continue
    }
    if (token.kind === "close") {
      const openIdx = matchOpen[i]!
      if (openIdx >= 0) {
        let popped = false
        while (wrappers.length > 0 && wrappers[wrappers.length - 1]!.openIdx >= openIdx) {
          out += wrappers.pop()!.suffix
          popped = true
        }
        if (!popped && (BLOCK_TAGS.has(token.name) || isHeading(token.name) !== undefined)) out += "\n"
        continue
      }
      if (BLOCK_TAGS.has(token.name) || isHeading(token.name) !== undefined) out += "\n"
      continue
    }
    if (token.name === "br") {
      out += "\n"
      continue
    }
    // Only balanced a/pre/code wrap; an unclosed heading still marks its line.
    const wrap = matchClose[i]! >= 0 || isHeading(token.name) !== undefined ? wrapperFor(token) : undefined
    if (wrap !== undefined) {
      out += wrap.prefix
      wrappers.push({ openIdx: i, suffix: wrap.suffix })
      continue
    }
    if (BLOCK_TAGS.has(token.name) || isHeading(token.name) !== undefined) out += "\n"
  }
  return collapseWhitespace(out)
}

/** Collapse runs of spaces and blank lines outside emitted code fences. */
function collapseWhitespace(text: string): string {
  const collapsed: string[] = []
  let fenced = false
  for (const line of text.split("\n")) {
    // Only the bare fence lines the converter emits toggle fence state, so
    // a page-text line quoting a fenced block does not disable collapsing.
    if (line === "```") {
      fenced = !fenced
      collapsed.push(line)
      continue
    }
    if (fenced) {
      collapsed.push(line)
      continue
    }
    const cleaned = line.replace(/[ \t]+/g, " ").trim()
    if (cleaned === "" && collapsed[collapsed.length - 1] === "") continue
    collapsed.push(cleaned)
  }
  return collapsed.join("\n").trim()
}
