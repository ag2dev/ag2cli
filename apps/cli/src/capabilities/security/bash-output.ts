/** Bounded output reader for BashTool to prevent subprocess output from exhausting agent memory. */

export type BoundedOutput = {
  text: string
  bytes: number
  truncated: boolean
}

export async function readBoundedOutput(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onChunk?: (chunk: string) => void,
): Promise<BoundedOutput> {
  if (!stream) return { text: "", bytes: 0, truncated: false }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  const decoder = new TextDecoder()
  let keptBytes = 0
  let totalBytes = 0
  const notify = (text: string): void => {
    if (!text || !onChunk) return
    try {
      onChunk(text)
    } catch {
      // Live output observers are best effort and must not change execution.
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      totalBytes += value.byteLength
      if (keptBytes >= maxBytes) continue
      const size = Math.min(maxBytes - keptBytes, value.byteLength)
      const kept = value.slice(0, size)
      chunks.push(kept)
      if (kept.byteLength > 0) {
        const text = decoder.decode(kept, { stream: true })
        notify(text)
      }
      keptBytes += size
    }
    notify(decoder.decode())
  } finally {
    reader.releaseLock()
  }

  const output = new Uint8Array(keptBytes)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }

  return {
    text: new TextDecoder().decode(output),
    bytes: totalBytes,
    truncated: totalBytes > keptBytes,
  }
}
