/**
 * SearchField: a query field over an injected editor seam. The editor
 * kernel arrives as a kit from the coordinator — tasks never import a
 * sibling owner — so the field is a real editor (graphemes, caret,
 * paste, history keys) rather than a string accumulator, and the same
 * algorithm instance serves the composer and every task query.
 */
import type { TuiIntent } from "../../keys/index.js"
import type { SearchEditor, SearchEditorKit } from "./contracts.js"

export class SearchField {
  private readonly editor: SearchEditor

  constructor(kit: SearchEditorKit) {
    this.editor = kit.create()
  }

  /**
   * Route one input-bearing intent into the editor; true when the
   * query changed. Activate never arrives here — Enter belongs to the
   * task's choose action, not the field.
   */
  handle(intent: TuiIntent): boolean {
    return this.editor.dispatch(intent) !== undefined
  }

  get query(): string {
    return this.editor.text
  }

  get caret(): number {
    return this.editor.caretOffset
  }
}
