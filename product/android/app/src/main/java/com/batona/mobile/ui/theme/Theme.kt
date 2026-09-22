package com.batona.mobile.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

val BatonaGreen = Color(0xFF07865B)
val BatonaAmber = Color(0xFFA65E00)
val BatonaAmberSurface = Color(0xFFFFF6E4)

private val Scheme = lightColorScheme(
    primary = Color(0xFF1769E8), onPrimary = Color.White,
    primaryContainer = Color(0xFFE5F0FF), onPrimaryContainer = Color(0xFF135CC4),
    background = Color(0xFFF5F7FA), onBackground = Color(0xFF17202D),
    surface = Color.White, onSurface = Color(0xFF17202D),
    surfaceVariant = Color(0xFFEDF1F6), onSurfaceVariant = Color(0xFF63738B),
    surfaceContainer = Color.White, surfaceContainerLow = Color(0xFFF7FAFF),
    surfaceContainerHigh = Color(0xFFF0F4F9),
    outline = Color(0xFF98A8BD), outlineVariant = Color(0xFFDDE5EF),
    secondary = Color(0xFF516786), secondaryContainer = Color(0xFFE5F0FF),
    onSecondaryContainer = Color(0xFF1769E8), error = Color(0xFFB53240),
)

@Composable
fun BatonaTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Scheme, typography = Typography(),
        shapes = Shapes(small = RoundedCornerShape(8.dp), medium = RoundedCornerShape(12.dp), large = RoundedCornerShape(16.dp)),
        content = content)
}
