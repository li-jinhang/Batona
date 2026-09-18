package com.dshlink.app.ui

import android.app.Application
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import com.dshlink.app.SettingsStore
import com.dshlink.app.data.Binding
import kotlinx.coroutines.launch

/** 根路由：未绑定 → 绑定页；未登录 → 登录页；已登录 → 主页 */
@Composable
fun App() {
    val context = LocalContext.current
    val store = remember { SettingsStore(context.applicationContext as Application) }
    val scope = rememberCoroutineScope()

    var binding by remember { mutableStateOf<Binding?>(null) }
    var token by remember { mutableStateOf<String?>(null) }
    var ready by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        binding = store.loadBinding()
        token = store.loadToken()
        ready = true
    }
    if (!ready) return

    when {
        binding == null -> BindScreen(
            onBound = { b ->
                scope.launch { store.saveBinding(b) }
                binding = b
            },
        )
        token == null -> LoginScreen(
            binding = binding!!,
            onLoggedIn = { t ->
                scope.launch { store.saveToken(t) }
                token = t
            },
        )
        else -> HomeScreen(
            binding = binding!!,
            token = token!!,
            onLogout = {
                scope.launch { store.clear() }
                token = null
            },
        )
    }
}
