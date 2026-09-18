package com.dshlink.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Scheme = darkColorScheme(
    primary = Color(0xFF4F8CFF),
    onPrimary = Color.White,
    background = Color(0xFF0F1115),
    onBackground = Color(0xFFE6E8EE),
    surface = Color(0xFF171A21),
    onSurface = Color(0xFFE6E8EE),
    surfaceVariant = Color(0xFF1E222B),
    onSurfaceVariant = Color(0xFF8B93A3),
    outline = Color(0xFF2A2F3A),
    secondary = Color(0xFF1E222B),
    error = Color(0xFFE74C3C),
)

@Composable
fun DSHLinkTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = Scheme,
        content = content,
    )
}
