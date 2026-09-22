package com.dshlink.app.ui

import android.app.Application
import androidx.compose.runtime.*
import androidx.compose.material3.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.fillMaxSize
import com.dshlink.app.SettingsStore
import com.dshlink.app.data.Binding
import com.dshlink.app.data.GatewayClient
import com.dshlink.app.data.AccessFailure
import kotlinx.coroutines.launch

/** Hosted access only: legacy connection strings and passwords are not an alternate login route. */
@Composable
fun App() {
    val context = LocalContext.current
    val store = remember { SettingsStore(context.applicationContext as Application) }
    val scope = rememberCoroutineScope()
    var token by remember { mutableStateOf<String?>(null) }
    var ready by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val binding = remember { Binding("117.72.10.87") }
    LaunchedEffect(Unit) { token = store.loadAccess(); ready = true }
    if (!ready) return
    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background, contentColor = MaterialTheme.colorScheme.onBackground) {
    if (token == null) PairScreen(store) { token = it }
    else key(token) {
        HomeScreen(binding, token!!, store, onLogout = {
            scope.launch {
                val client = GatewayClient(binding, {}, {}).apply { this.token = token.orEmpty() }
                try {
                    try { client.access("logout") }
                    catch (e: AccessFailure) { if (e.code != "unauthorized") throw e }
                    store.clear(); token = null
                } catch (e: Exception) { error = "退出尚未完成：" + (e.message ?: "请联网后重试") }
                finally { client.disconnect() }
            }
        })
    }
    error?.let { text ->
        AlertDialog(onDismissRequest = { error = null }, title = { Text("连接提示") },
            text = { Text(text) }, confirmButton = { TextButton(onClick = { error = null }) { Text("知道了") } })
    }
    }
}
