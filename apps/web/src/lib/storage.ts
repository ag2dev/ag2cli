export function readPreference(key: string): string | undefined {
  try {
    return window.localStorage.getItem(`ag2cli.web.${key}`) ?? undefined
  } catch {
    return undefined
  }
}

export function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(`ag2cli.web.${key}`, value)
  } catch {
    // Browsing restrictions must not prevent connecting to a host.
  }
}

export function removePreference(key: string): void {
  try {
    window.localStorage.removeItem(`ag2cli.web.${key}`)
  } catch {
    // Removal is best-effort; browsing restrictions must not block disconnecting.
  }
}

export function browserClientId(): string {
  const stored = readPreference("client-id")
  if (stored) return stored
  const id = crypto.randomUUID()
  writePreference("client-id", id)
  return id
}
