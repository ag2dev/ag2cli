type ConfigRecord = Record<string, unknown>

function isPlainRecord(value: unknown): value is ConfigRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (!isPlainRecord(value)) return value

  const output: ConfigRecord = {}
  for (const [key, item] of Object.entries(value)) output[key] = cloneValue(item)
  return output
}

function mergeRecord(low: ConfigRecord, high: ConfigRecord): ConfigRecord {
  const output = cloneValue(low) as ConfigRecord
  for (const [key, highValue] of Object.entries(high)) {
    const lowValue = output[key]
    if (isPlainRecord(lowValue) && isPlainRecord(highValue)) {
      output[key] = mergeRecord(lowValue, highValue)
    } else {
      output[key] = cloneValue(highValue)
    }
  }
  return output
}

/**
 * Merge configuration sources from lowest to highest precedence.
 * Plain objects merge recursively; arrays and scalar values replace wholesale.
 */
export function mergeConfigSources<T extends ConfigRecord>(...sources: readonly (Partial<T> | undefined)[]): T {
  let merged: ConfigRecord = {}
  for (const source of sources) {
    if (source === undefined) continue
    if (!isPlainRecord(source)) throw new Error("Configuration source must be an object")
    merged = mergeRecord(merged, source)
  }
  return merged as T
}
