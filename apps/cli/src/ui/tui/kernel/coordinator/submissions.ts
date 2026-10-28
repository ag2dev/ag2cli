/**
 * Submission receipts: one pending receipt per submit command the
 * kernel emitted, settled by the executor's accepted/rejected
 * operation-result, or closed as superseded when the session binding
 * ends first. A draft restore or a refused Enter mints nothing, and a
 * receipt for an unknown or late result stays untouched — the ledger
 * already dropped the result, so the receipt never hears about it.
 * The listing is the transcript gutter's pending-row source.
 */
export type ReceiptStatus = "pending" | "accepted" | "rejected" | "superseded"

export interface SubmissionReceipt {
  readonly id: string
  readonly text: string
  readonly status: ReceiptStatus
  /** Canonical input identity, present once the run accepted the submission. */
  readonly inputId: string | null
}

export class SubmissionReceipts {
  private readonly receipts: SubmissionReceipt[] = []
  private nextIndex = 1

  open(text: string): SubmissionReceipt {
    const receipt: SubmissionReceipt = { id: `r:${this.nextIndex}`, text, status: "pending", inputId: null }
    this.nextIndex += 1
    this.receipts.push(receipt)
    return receipt
  }

  /** Settle the oldest pending receipt; a result with no pending receipt settles nothing. */
  accept(inputId: string): SubmissionReceipt | null {
    return this.settle((receipt) => ({ ...receipt, status: "accepted" as const, inputId }))
  }

  reject(): SubmissionReceipt | null {
    return this.settle((receipt) => ({ ...receipt, status: "rejected" as const }))
  }

  /** The binding ended; pending receipts die with it. Superseded is terminal bookkeeping, never a user verdict. */
  supersede(): void {
    for (let index = 0; index < this.receipts.length; index += 1) {
      if (this.receipts[index]!.status === "pending") this.receipts[index] = { ...this.receipts[index]!, status: "superseded" }
    }
  }

  listing(): readonly SubmissionReceipt[] {
    return this.receipts.map((receipt) => ({ ...receipt }))
  }

  /** The full-frame gutter renders pending submissions only; settled receipts live in the band's feedback fallback. */
  pendingCount(): number {
    let count = 0
    for (const receipt of this.receipts) if (receipt.status === "pending") count += 1
    return count
  }

  private settle(apply: (receipt: SubmissionReceipt) => SubmissionReceipt): SubmissionReceipt | null {
    const index = this.receipts.findIndex((receipt) => receipt.status === "pending")
    if (index < 0) return null
    const settled = apply(this.receipts[index]!)
    this.receipts[index] = settled
    return { ...settled }
  }
}
