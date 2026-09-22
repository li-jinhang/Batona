package com.dshlink.app.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.dshlink.app.SettingsStore
import com.dshlink.app.data.Binding
import com.dshlink.app.data.GatewayClient
import com.dshlink.app.data.AccessFailure
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable
fun PairScreen(store: SettingsStore, gatewayClient: GatewayClient? = null, onPaired: (String) -> Unit) {
    var code by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var scanning by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val client = remember { gatewayClient ?: GatewayClient(Binding("117.72.10.87"), {}, {}) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        scanning = it
        if (!it) status = "没有相机权限也可以手动输入电脑上的配对码。"
    }
    DisposableEffect(Unit) { onDispose { client.disconnect() } }
    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("连接你的电脑", style = MaterialTheme.typography.headlineLarge)
        Text("先在电脑端用测试密钥登录，再打开「手机配对」。扫码或输入配对码后，需要电脑确认。")
        Text("旧连接串和 admin 密码已不再使用。", color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(value = code, onValueChange = { code = it }, enabled = !busy, label = { Text("电脑上的配对码") }, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(enabled = !busy && code.isNotBlank(), onClick = {
                scope.launch {
                    busy = true
                    try {
                        val clean = code.trim().removePrefix("dsh-pair://").trimEnd('/').uppercase()
                        val deviceSecret = store.deviceSecret()
                        val request = client.access("pair-request", buildJsonObject { put("code", clean); put("deviceSecret", deviceSecret); put("name", Build.MODEL) })
                        status = "请在电脑端允许这部手机。"
                        while (true) {
                            delay(1500)
                            val result = try {
                                client.access("pair-result", buildJsonObject { put("requestId", request["requestId"]!!); put("proof", request["proof"]!!) })
                            } catch (e: AccessFailure) {
                                if (e.code != "rate-limited") throw e
                                delay(5000); continue
                            } catch (_: java.io.IOException) {
                                status = "网络暂时中断，正在等待恢复；请保持电脑配对页打开。"
                                delay(3000); continue
                            }
                            val token = result["token"]?.jsonPrimitive?.content
                            if (token != null) { store.saveAccess(token); onPaired(token); break }
                        }
                    } catch (e: kotlinx.coroutines.CancellationException) { throw e }
                    catch (e: Exception) { status = e.message ?: "连接失败，请重新打开电脑配对页。" }
                    finally { busy = false }
                }
            }) { Text(if (busy) "等待电脑确认…" else "请求配对") }
            OutlinedButton(enabled = !busy, onClick = { permission.launch(Manifest.permission.CAMERA) }) { Text("扫码") }
        }
        if (scanning) { CameraScanner(onDetected = { code = it; scanning = false }, modifier = Modifier.fillMaxWidth().height(250.dp)); OutlinedButton(onClick = { scanning = false }) { Text("关闭相机") } }
        Text(status, color = MaterialTheme.colorScheme.primary)
    }
}
