/** TUI-local theme identifiers shared by the JSONC schema and terminal presentation. */
export const SUPPORTED_THEMES = ["dark", "light", "dark-daltonized", "light-daltonized", "dark-ansi", "light-ansi"] as const

export type Theme = (typeof SUPPORTED_THEMES)[number]
