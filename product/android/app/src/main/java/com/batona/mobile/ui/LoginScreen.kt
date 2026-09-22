package com.batona.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.batona.mobile.data.Binding
import com.batona.mobile.data.GatewayClient
import kotlinx.coroutines.launch

/** 登录页：账号密码（连接串自动预填）+ 可选 TOTP */
@Composable
fun LoginScreen(binding: Binding, onLoggedIn: (String) -> Unit) {
    var username by remember { mutableStateOf(binding.gwUser) }
    var password by remember { mutableStateOf(binding.gwPass) }
    var totp by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var otpauth by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("登录网关", style = MaterialTheme.typography.headlineSmall)
        Text(binding.serverIp, color = MaterialTheme.colorScheme.onSurfaceVariant)

        Card(modifier = Modifier.fillMaxWidth().padding(top = 20.dp)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(username, { username = it }, label = { Text("账号") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(password, { password = it }, label = { Text("密码") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(totp, { totp = it }, label = { Text("TOTP 动态码（已绑定/首次绑定时填）") }, modifier = Modifier.fillMaxWidth())

                Button(onClick = {
                    busy = true; error = ""; otpauth = null
                    scope.launch {
                        try {
                            val client = GatewayClient(binding, onPush = {}, onConnChange = {})
                            val r = client.login(username, password, totp.ifBlank { null })
                            busy = false
                            if (r.ok) onLoggedIn(r.token!!)
                            else {
                                error = r.error ?: "登录失败"
                                otpauth = r.otpauthUri
                            }
                        } catch (e: Exception) {
                            busy = false
                            error = "无法连接服务器：${e.message}"
                        }
                    }
                }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                    if (busy) CircularProgressIndicator(Modifier.padding(4.dp), strokeWidth = 2.dp)
                    else Text("登录")
                }

                if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
                otpauth?.let { uri ->
                    Card {
                        Column(Modifier.padding(12.dp)) {
                            Text("首次登录：请用 Authenticator 录入以下密钥，然后再次登录输入动态码", style = MaterialTheme.typography.bodySmall)
                            Text(uri, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }
        }
    }
}
