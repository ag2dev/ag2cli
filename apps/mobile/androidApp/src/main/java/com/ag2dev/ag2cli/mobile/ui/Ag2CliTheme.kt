package com.ag2dev.ag2cli.mobile.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

data class AppPalette(
    val success: Color,
    val warning: Color,
    val danger: Color,
    val info: Color,
    val codeBackground: Color,
)

private val LightPalette = AppPalette(
    success = Color(0xFF25734A),
    warning = Color(0xFF9A5A00),
    danger = Color(0xFFE7000B),
    info = Color(0xFF52525B),
    codeBackground = Color(0xFFF4F4F5),
)

private val DarkPalette = AppPalette(
    success = Color(0xFF6BCB91),
    warning = Color(0xFFF2B44A),
    danger = Color(0xFFFF6467),
    info = Color(0xFFA1A1AA),
    codeBackground = Color(0xFF202023),
)

val LocalAppPalette = staticCompositionLocalOf { LightPalette }

// Keep these semantic Material roles mapped to the Web brand tokens in
// apps/web/src/styles/theme.css; Compose still owns Android-specific components and layout.
private val LightColors = lightColorScheme(
    primary = Color(0xFF737373),
    onPrimary = Color(0xFFFAFAFA),
    primaryContainer = Color(0xFFE5E5E5),
    onPrimaryContainer = Color(0xFF171717),
    secondary = Color(0xFFF5F5F5),
    onSecondary = Color(0xFF171717),
    secondaryContainer = Color(0xFFF5F5F5),
    onSecondaryContainer = Color(0xFF171717),
    tertiary = Color(0xFF717171),
    onTertiary = Color(0xFFFAFAFA),
    tertiaryContainer = Color(0xFFF5F5F5),
    onTertiaryContainer = Color(0xFF171717),
    background = Color(0xFFFFFFFF),
    onBackground = Color(0xFF0A0A0A),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF0A0A0A),
    surfaceVariant = Color(0xFFF5F5F5),
    onSurfaceVariant = Color(0xFF717171),
    outline = Color(0xFFE5E5E5),
    outlineVariant = Color(0xFFE5E5E5),
    error = Color(0xFFE7000B),
    onError = Color(0xFFFAFAFA),
    errorContainer = Color(0xFFFDE8E7),
    onErrorContainer = Color(0xFF7A271A),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF737373),
    onPrimary = Color(0xFFFAFAFA),
    primaryContainer = Color(0xFF404040),
    onPrimaryContainer = Color(0xFFFAFAFA),
    secondary = Color(0xFF262626),
    onSecondary = Color(0xFFFAFAFA),
    secondaryContainer = Color(0xFF404040),
    onSecondaryContainer = Color(0xFFFAFAFA),
    tertiary = Color(0xFFA1A1A1),
    onTertiary = Color(0xFF0A0A0A),
    tertiaryContainer = Color(0xFF404040),
    onTertiaryContainer = Color(0xFFFAFAFA),
    background = Color(0xFF0A0A0A),
    onBackground = Color(0xFFFAFAFA),
    surface = Color(0xFF191919),
    onSurface = Color(0xFFFAFAFA),
    surfaceVariant = Color(0xFF262626),
    onSurfaceVariant = Color(0xFFA1A1A1),
    outline = Color(0xFF383838),
    outlineVariant = Color(0xFF525252),
    error = Color(0xFFFF6467),
    onError = Color(0xFF262626),
    errorContainer = Color(0xFF4A2524),
    onErrorContainer = Color(0xFFFFDAD6),
)

@Composable
fun Ag2CliTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    CompositionLocalProvider(LocalAppPalette provides if (dark) DarkPalette else LightPalette) {
        MaterialTheme(
            colorScheme = if (dark) DarkColors else LightColors,
            content = content,
        )
    }
}
