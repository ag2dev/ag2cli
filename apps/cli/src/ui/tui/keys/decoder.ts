/**
 * Raw byte decoding into the closed normalized event vocabulary. Sequences
 * are matched exactly; a well-formed sequence outside the vocabulary (unknown
 * CSI finals, mouse reports, CSI-u) drops whole, but an introducer that can
 * never complete never swallows the read: an invalid continuation or an
 * unknown SS3 final surfaces as escape plus the leader byte and the rest
 * re-parses as plain input. Alt-modified keys lose their prefix and surface
 * as escape followed by the base key, except the two bound Alt+arrow forms
 * (CSI 1;3C/D and an ESC-prefixed plain arrow), which decode as single alt
 * events.
 *
 * Chunked reads: an escape sequence whose final byte has not arrived yet is
 * held back in a bounded carry-over buffer and completed by the next read. A
 * lone ESC or a held SS3 prefix resolves through a caller-owned ambiguity
 * window: the next read completes it, and flushPendingEscape surfaces it as
 * literal input once the window expires.
 *
 * Bracketed paste: once the start marker is seen, everything up to the
 * terminator is one paste body held verbatim (control bytes included), so a
 * carriage return inside a paste can never surface as an enter press. Paste
 * accumulation is exempt from the sequence carry limit — the terminator is
 * unambiguous, so the desync guard would only corrupt large pastes.
 */
import type { TuiInputDecoder, TuiInputEvent } from "./index.js"

const CARRY_LIMIT = 32
const PASTE_START = "\x1b[200~"
const PASTE_END = "\x1b[201~"

function isParameter(byte: string): boolean {
  return byte >= "\x20" && byte <= "\x3f"
}

function isFinal(byte: string): boolean {
  return byte >= "\x40" && byte <= "\x7e"
}

function arrowFor(final: string): TuiInputEvent | null {
  if (final === "A") return { type: "up" }
  if (final === "B") return { type: "down" }
  if (final === "C") return { type: "right" }
  if (final === "D") return { type: "left" }
  return null
}

function tildeFor(body: string): TuiInputEvent | null {
  if (body === "3") return { type: "delete" }
  if (body === "5") return { type: "page-up" }
  if (body === "6") return { type: "page-down" }
  return null
}

/** Bytes of the escape sequence at `index`; null when it must be held back,
 * INVALID_SEQUENCE when the continuation can never complete. */
const INVALID_SEQUENCE = -1

function sequenceLength(raw: string, index: number): number | null {
  const leader = raw[index + 1]
  if (leader === undefined) return null
  if (leader !== "[" && leader !== "O") return 1
  // X10 mouse reports are CSI M followed by three encoded bytes; the
  // generic CSI scanner would otherwise mistake M for the final byte and
  // leak coordinates into the composer.
  if (leader === "[" && raw[index + 2] === "M") return raw.length - index >= 6 ? 6 : null
  let cursor = index + 2
  while (cursor < raw.length && isParameter(raw[cursor]!)) cursor += 1
  if (cursor >= raw.length) return null
  if (!isFinal(raw[cursor]!)) return INVALID_SEQUENCE
  return cursor - index + 1
}

/** Consume the sequence at `index`; false when the SS3 final is outside the
 * vocabulary and the introducer must surface as the alt-pair instead. */
function decodeSequence(raw: string, index: number, length: number, events: TuiInputEvent[]): boolean {
  if (length === 1) {
    events.push({ type: "escape" })
    return true
  }
  const leader = raw[index + 1]!
  const final = raw[index + length - 1]!
  const body = raw.slice(index + 2, index + length - 1)
  if (leader === "[" && length === 6 && raw[index + 2] === "M") {
    const button = raw.charCodeAt(index + 3) - 32
    if ((button & 64) !== 0) {
      events.push({
        type: "wheel",
        direction: (button & 1) === 0 ? "up" : "down",
        column: Math.max(0, raw.charCodeAt(index + 4) - 33),
        row: Math.max(0, raw.charCodeAt(index + 5) - 33),
      })
    }
    return true
  }
  if (leader === "O") {
    // SS3 M is application-keypad Enter. The screen never requests that
    // mode, but a terminal left in it still means Enter, so it submits
    // like carriage return instead of dropping whole.
    if (final === "M") {
      events.push({ type: "enter" })
      return true
    }
    const arrow = arrowFor(final)
    if (arrow !== null) events.push(arrow)
    // An SS3 final outside the vocabulary is an Alt+O prefix plus a key:
    // reject the sequence so the introducer surfaces and the final byte
    // re-parses as plain input.
    return arrow !== null
  }
  if (body === "") {
    const arrow = arrowFor(final)
    if (arrow !== null) events.push(arrow)
    if (final === "Z") events.push({ type: "shift-tab" })
    return true
  }
  if (leader === "[" && body === "1;3" && (final === "C" || final === "D")) {
    // The only bound modified form: Alt+arrow from terminals reporting
    // modifiers in the CSI parameters. Other modifier combinations keep
    // dropping whole rather than aliasing the bare key.
    events.push(final === "C" ? { type: "alt-right" } : { type: "alt-left" })
    return true
  }
  if (final === "M") {
    const match = /^<(\d+);(\d+);(\d+)$/u.exec(body)
    if (match === null) return true
    const button = Number(match[1])
    const column = Number(match[2]) - 1
    const row = Number(match[3]) - 1
    if ((button & 64) === 0 || !Number.isSafeInteger(column) || !Number.isSafeInteger(row)) return true
    events.push({
      type: "wheel",
      direction: (button & 1) === 0 ? "up" : "down",
      column: Math.max(0, column),
      row: Math.max(0, row),
    })
    return true
  }
  if (final === "~") {
    const tilde = tildeFor(body)
    if (tilde !== null) events.push(tilde)
    return true
  }
  // CSI-u (Kitty/modifyOtherKeys) never arrives: the screen never
  // requests that protocol, and unknown finals drop whole. Non-wheel SGR
  // mouse reports share the drop: the screen enables wheel-only
  // reporting, and the wheel branch above consumed the reports it maps.
  return true
}

/**
 * Decoder factory. The decoder carries an incomplete escape sequence across
 * reads; every other byte is consumed by the read that delivered it.
 */
export function createInputDecoder(): TuiInputDecoder {
  let carry = ""
  let inPaste = false
  let pasteChunks: string[] = []
  let pasteTerminatorCarry = ""

  const longestPasteTerminatorPrefix = (value: string): number => {
    const max = Math.min(value.length, PASTE_END.length - 1)
    for (let length = max; length > 0; length -= 1) {
      if (PASTE_END.startsWith(value.slice(-length))) return length
    }
    return 0
  }

  return {
    decode(raw: string): readonly TuiInputEvent[] {
      let buffer = carry + raw
      carry = ""
      const events: TuiInputEvent[] = []
      let index = 0
      while (index < buffer.length) {
        if (inPaste) {
          // Retain only a possible terminator prefix between reads. The
          // paste body is stored as chunks and joined once, so a large paste
          // arriving in many small reads is linear rather than quadratic.
          const candidate = pasteTerminatorCarry + buffer.slice(index)
          const end = candidate.indexOf(PASTE_END)
          if (end < 0) {
            const keep = longestPasteTerminatorPrefix(candidate)
            const completeLength = candidate.length - keep
            if (completeLength > 0) pasteChunks.push(candidate.slice(0, completeLength))
            pasteTerminatorCarry = candidate.slice(completeLength)
            index = buffer.length
            break
          }
          if (end > 0) pasteChunks.push(candidate.slice(0, end))
          events.push({ type: "paste", value: pasteChunks.join("") })
          pasteChunks = []
          pasteTerminatorCarry = ""
          inPaste = false
          buffer = candidate.slice(end + PASTE_END.length)
          index = 0
          continue
        }
        if (buffer.startsWith(PASTE_START, index)) {
          inPaste = true
          index += PASTE_START.length
          continue
        }
        const char = buffer[index]!
        if (char === "\x1b") {
          if (buffer[index + 1] === "\x1b") {
            // A lone ESC before an arrow sequence is the other physical
            // form of Alt+direction. Only a pair that can still complete
            // into [C/[D is one alt event (held until the read or the
            // ambiguity window resolves it); anything else degrades —
            // the leading ESC surfaces now and the rest re-parses from
            // the second ESC unchanged.
            const pairLeader = buffer[index + 2]
            const pairFinal = buffer[index + 3]
            if (pairLeader === undefined || (pairLeader === "[" && pairFinal === undefined)) break
            if (pairLeader === "[" && (pairFinal === "C" || pairFinal === "D")) {
              events.push(pairFinal === "C" ? { type: "alt-right" } : { type: "alt-left" })
              index += 4
              continue
            }
            events.push({ type: "escape" })
            index += 1
            continue
          }
          const length = sequenceLength(buffer, index)
          if (length === null) {
            break
          }
          if (length === INVALID_SEQUENCE || !decodeSequence(buffer, index, length, events)) {
            events.push({ type: "escape" })
            events.push({ type: "char", value: buffer[index + 1]! })
            index += 2
            continue
          }
          index += length
          continue
        }
        if (char === "\r") {
          events.push({ type: "enter" })
          index += 1
          continue
        }
        if (char === "\n") {
          events.push({ type: "char", value: "\n" })
          index += 1
          continue
        }
        if (char === "\x7f" || char === "\x08") {
          events.push({ type: "backspace" })
          index += 1
          continue
        }
        if (char === "\t") {
          events.push({ type: "tab" })
          index += 1
          continue
        }
        const code = buffer.charCodeAt(index)
        if (code >= 0x01 && code <= 0x1a) {
          events.push({ type: "ctrl", value: String.fromCharCode(code + 96) })
          index += 1
          continue
        }
        if (code < 0x20) {
          index += 1
          continue
        }
        const point = buffer.codePointAt(index)!
        // A trailing lone high surrogate may be half of a code point whose
        // other half arrives in the next read: hold it back.
        if (point >= 0xd800 && point <= 0xdbff && index + 1 >= buffer.length) break
        const text = String.fromCodePoint(point)
        events.push({ type: "char", value: text })
        index += text.length
      }
      carry = index < buffer.length ? buffer.slice(index) : ""
      if (!inPaste && carry.length > CARRY_LIMIT) carry = ""
      return events
    },
    flushPendingEscape() {
      if (inPaste) return []
      if (carry === "\x1b") {
        carry = ""
        return [{ type: "escape" }]
      }
      if (carry === "\x1bO") {
        carry = ""
        return [{ type: "escape" }, { type: "char", value: "O" }]
      }
      if (carry === "\x1b\x1b" || carry === "\x1b\x1b[") {
        // A window-expired ESC pair is a double escape under the alt-pair
        // convention; the stale "[" fragment of a dead sequence drops.
        carry = ""
        return [{ type: "escape" }, { type: "escape" }]
      }
      return []
    },
    hasPendingEscape() {
      return !inPaste && (carry === "\x1b" || carry === "\x1bO" || carry === "\x1b\x1b" || carry === "\x1b\x1b[")
    },
  }
}
