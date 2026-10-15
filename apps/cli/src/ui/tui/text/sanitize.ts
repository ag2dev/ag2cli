/**
 * The single sanitize point of the Ink text kernel: no raw escape sequence
 * from any content source reaches Ink output (Ink would pass embedded ANSI
 * straight to the terminal). CSI/OSC/standalone ESC sequences and C0/C1
 * controls (except tab and newline) are removed. An OSC/DCS body ends at a
 * line break, so a missing terminator never swallows the lines after it;
 * any stray ESC or BEL the sequence leaves behind falls to the control
 * pass.
 */
// eslint-disable-next-line no-control-regex -- stripping raw escape sequences is this module's purpose
const ESCAPE_SEQUENCES = /\u001b(?:\[[0-9;:<=>?]*[ -/]*[@-~]|[\]PX^_][^\u0007\u001b\n\r]*(?:\u0007|\u001b\\)?|[ -/]*[0-~])/g
// eslint-disable-next-line no-control-regex -- C0/C1 controls except tab and newline are removed by design
const STRIPPED_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g

/** Remove escape sequences and control characters from terminal-bound text. */
export function sanitizeText(text: string): string {
  return text.replace(ESCAPE_SEQUENCES, "").replace(STRIPPED_CONTROLS, "")
}
