export type ThemeMode = "light" | "dark" | "system"

export function parseThemeMode(value: string | undefined): ThemeMode {
  return value === "dark" || value === "system" ? value : "light"
}

export function isDarkTheme(mode: ThemeMode, systemDark: boolean): boolean {
  return mode === "dark" || (mode === "system" && systemDark)
}

export function nextThemeMode(mode: ThemeMode): ThemeMode {
  return mode === "light" ? "dark" : mode === "dark" ? "system" : "light"
}
