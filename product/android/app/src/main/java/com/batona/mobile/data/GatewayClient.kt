package com.batona.mobile.data

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * 网关客户端：REST（登录）+ WebSocket（四象限 RPC）
 *
 * 事件推送（server-request）经 onPush 回调；请求-响应按 rpcId 配对。
 * 使用系统 CA 与主机名校验；不接受自签、过期或身份不匹配的证书。
 */
class GatewayClient(
    private val binding: Binding,
    private val onPush: (ServerRequest) -> Unit,
    private val onConnChange: (Boolean) -> Unit,
    private val onAuthFailed: () -> Unit = {},
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS).build(),
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    var token: String = ""

    private var ws: WebSocket? = null
    @Volatile private var authenticated = false
    private val pending = ConcurrentHashMap<String, CompletableDeferred<RpcResult<JsonElement>>>()
    private val scope = kotlinx.coroutines.CoroutineScope(Dispatchers.IO)

    // ── REST ──────────────────────────────────────────────────────────
    suspend fun login(username: String, password: String, totp: String?): LoginResponse = withContext(Dispatchers.IO) {
        val body = json.encodeToString(LoginRequest.serializer(), LoginRequest(username, password, totp))
        val req = Request.Builder()
            .url("${binding.gatewayBase}/api/auth/login")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        client.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: "{}"
            val r = json.decodeFromString(LoginResponse.serializer(), text)
            if (r.ok) token = r.token.orEmpty()
            r
        }
    }

    // ── WebSocket 四象限 RPC ─────────────────────────────────────────
    private var stopped = false
    private var reconnectJob: kotlinx.coroutines.Job? = null
    private var reconnectAttempts = 0

    fun connect() {
        if (token.isEmpty() || stopped) return
        authenticated = false
        val req = Request.Builder().url("wss://${binding.wsHost}:${binding.wsPort}/ws").build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                scope.launchSafe {
                    val result = call("auth.hello", buildJsonObject { put("token", token) })
                    if (result.ok && !stopped && ws === webSocket) { authenticated = true; reconnectAttempts = 0; onConnChange(true) }
                }
            }
            override fun onMessage(webSocket: WebSocket, text: String) { if (ws === webSocket && !stopped) handleMessage(text) }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { if (ws === webSocket) authenticated = false; webSocket.close(code, reason) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (ws !== webSocket || stopped) return
                authenticated = false
                onConnChange(false)
                if (reason == "unauthorized" || reason == "authorization-revoked") {
                    scope.launchSafe {
                        try { access("status"); scheduleReconnect() }
                        catch (e: AccessFailure) { if (e.code == "unauthorized") onAuthFailed() else scheduleReconnect() }
                        catch (_: Exception) { scheduleReconnect() }
                    }
                } else scheduleReconnect()
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (ws !== webSocket || stopped) return
                authenticated = false
                onConnChange(false); scheduleReconnect()
            }
        })
    }

    fun disconnect() {
        stopped = true; authenticated = false; reconnectJob?.cancel(); ws?.close(1000, "bye"); ws = null
        pending.values.forEach { it.complete(RpcResult(ok = false, error = RpcError("disconnected", "连接已关闭"))) }
        pending.clear()
    }
    private fun scheduleReconnect() {
        if (stopped) return
        reconnectJob?.cancel()
        pending.values.forEach { it.complete(RpcResult(ok = false, error = RpcError("disconnected", "连接中断，提交结果可能未知"))) }
        pending.clear()
        val wait = (500L * (1 shl reconnectAttempts.coerceAtMost(6))).coerceAtMost(30_000L)
        reconnectAttempts++
        reconnectJob = scope.launch {
            kotlinx.coroutines.delay(wait)
            if (!stopped && token.isNotEmpty()) connect()
        }
    }

    suspend fun access(op: String, body: kotlinx.serialization.json.JsonObject = buildJsonObject {}): kotlinx.serialization.json.JsonObject = withContext(Dispatchers.IO) {
        val req = Request.Builder().url("${binding.gatewayBase}/api/access/$op")
            .header("Authorization", "Bearer $token")
            .post(body.toString().toRequestBody("application/json".toMediaType())).build()
        client.newCall(req).execute().use { response ->
            val result = json.parseToJsonElement(response.body?.string() ?: "{}").jsonObject
            if (!response.isSuccessful) throw AccessFailure(result["error"]?.jsonPrimitive?.content ?: "connection-failed")
            result
        }
    }

    suspend fun call(method: String, payload: JsonElement = buildJsonObject {}): RpcResult<JsonElement> {
        if (method != "auth.hello" && !authenticated) return RpcResult(ok = false, error = RpcError("not-connected", "连接未完成认证，请恢复网络后重试；消息未排队。"))
        val rpcId = UUID.randomUUID().toString()
        val req = ClientRequest(rpcId = rpcId, method = method, payload = payload)
        val s = ws
        if (s == null) return RpcResult(ok = false, error = RpcError("not-connected", "WebSocket 未连接"))
        val deferred = CompletableDeferred<RpcResult<JsonElement>>()
        pending[rpcId] = deferred
        try {
            val sent = s.send(json.encodeToString(ClientRequest.serializer(), req))
            if (!sent) {
                pending.remove(rpcId)
                return RpcResult(ok = false, error = RpcError("send-failed", "发送失败"))
            }
        } catch (e: Exception) {
            pending.remove(rpcId)
            return RpcResult(ok = false, error = RpcError("send-failed", e.message ?: "发送异常"))
        }
        return try { awaitWithTimeout(deferred) } finally { pending.remove(rpcId) }
    }
    private fun handleMessage(text: String) {
        try {
            val el = json.parseToJsonElement(text).jsonObject
            when (el["type"]?.jsonPrimitive?.content) {
                "server-response" -> {
                    val r = json.decodeFromString(ServerResponse.serializer(), text)
                    pending.remove(r.rpcId)?.complete(r.result)
                }
                "server-request" -> {
                    val r = json.decodeFromString(ServerRequest.serializer(), text)
                    onPush(r)
                }
            }
        } catch (_: Exception) { /* 忽略畸形帧 */ }
    }

    private suspend fun hello() {
        call("auth.hello", buildJsonObject { put("token", token) })
    }

    // ── 便捷方法（全部防御式：后端不可达/解析失败 → 返回空/默认，不抛异常）──
    suspend fun sessionList(): List<GatewaySession> =
        runCatching { call("session.list").let { r -> if (r.ok && r.value != null) json.decodeFromJsonElement(SessionListResult.serializer(), r.value!!).sessions else emptyList() } }
            .getOrElse { emptyList() }

    suspend fun sessionCreate(
        backend: String,
        title: String? = null,
        workspaceId: String? = null,
        workspacePath: String? = null,
        model: ModelRef? = null,
        agentPreset: String? = null,
    ): GatewaySession? =
        runCatching {
            call("session.create", buildJsonObject {
                put("backend", backend)
                title?.let { put("title", it) }
                workspaceId?.let { put("workspaceId", it) }
                workspacePath?.let { put("workspacePath", it) }
                agentPreset?.let { put("agentPreset", it) }
                model?.let { put("model", modelJson(it)) }
            }).let { r -> if (r.ok && r.value != null) json.decodeFromJsonElement(GatewaySession.serializer(), r.value!!) else null }
        }.getOrNull()

    /** 恢复（附加）一个已有后端会话，返回可供聊天的网关会话 */
    suspend fun resumeSession(backend: String, backendSessionId: String): GatewaySession? =
        run {
            call("session.resume", buildJsonObject {
                put("backend", backend)
                put("backendSessionId", backendSessionId)
            }).let { r -> json.decodeFromJsonElement(GatewaySession.serializer(), r.requireValue()) }
        }

    suspend fun sessionPrompt(sessionId: String, text: String, agentPreset: String? = null) =
        call("session.prompt", buildJsonObject {
            put("sessionId", sessionId)
            put("parts", buildJsonArray {
                add(buildJsonObject { put("type", "text"); put("text", text) })
            })
            put("queueAction", "queue")
            agentPreset?.let { put("agentPreset", it) }
        })

    suspend fun sessionCancel(sessionId: String) = call("session.cancel", buildJsonObject { put("sessionId", sessionId) })

    suspend fun sessionRename(sessionId: String, title: String, backend: String? = null) =
        call("session.rename", buildJsonObject { put("sessionId", sessionId); put("title", title); backend?.let { put("backend", it) } })

    suspend fun sessionHistory(sessionId: String): List<AgentEvent> =
        json.decodeFromJsonElement(HistoryResult.serializer(),
            call("session.history", buildJsonObject { put("sessionId", sessionId) }).requireValue()).events

    suspend fun respond(sessionId: String, serverRequestRpcId: String, payload: JsonElement) =
        call("respond", buildJsonObject {
            put("sessionId", sessionId)
            put("serverRequestRpcId", serverRequestRpcId)
            put("payload", payload)
        })

    suspend fun workspaceList(backend: String? = null): List<WorkspaceView> =
        runCatching { call("workspace.list", backendPayload(backend)).let { r -> if (r.ok && r.value != null) json.decodeFromJsonElement(WorkspaceListResult.serializer(), r.value!!).items else emptyList() } }
            .getOrElse { emptyList() }

    suspend fun workspaceTree(backend: String? = null): WorktreeResult =
        json.decodeFromJsonElement(WorktreeResult.serializer(),
            call("workspace.tree", backendPayload(backend)).requireValue())

    suspend fun workspaceDelete(workspaceId: String, backend: String? = null) =
        call("workspace.delete", buildJsonObject { put("workspaceId", workspaceId); backend?.let { put("backend", it) } })

    suspend fun archiveSession(sessionId: String, backend: String? = null) =
        call("workspace.archiveSession", buildJsonObject { put("sessionId", sessionId); backend?.let { put("backend", it) } })

    suspend fun workspaceCreate(path: String, backend: String? = null): WorkspaceCreateResult =
        runCatching {
            call("workspace.create", buildJsonObject { put("path", path); backend?.let { put("backend", it) } })
                .let { r -> if (r.ok && r.value != null) json.decodeFromJsonElement(WorkspaceCreateResult.serializer(), r.value!!) else WorkspaceCreateResult() }
        }.getOrElse { WorkspaceCreateResult() }

    /** 目录浏览：调网关 fs.listDir，path="" 返回盘符根，非空返回子目录（经 frp 读笔记本本地目录） */
    suspend fun dirList(path: String): DirListResult =
        runCatching {
            call("fs.listDir", buildJsonObject { put("path", path) })
                .let { r ->
                    if (r.ok && r.value != null) {
                        val d = json.decodeFromJsonElement(DirListResult.serializer(), r.value!!)
                        android.util.Log.w("BATONA", "dirRPC ok path=${d.path} dirs=${d.dirs?.size} roots=${d.roots?.size}")
                        d
                    } else {
                        android.util.Log.w("BATONA", "dirRPC kafka ok=${r.ok} err=${r.error?.code} ${r.error?.message}")
                        DirListResult()
                    }
                }
        }.onFailure { android.util.Log.w("BATONA", "dirRPC FAIL: ${it}") }
            .getOrElse { DirListResult() }

    suspend fun modelList(backend: String? = null): List<ModelRef> =
        runCatching { call("model.list", backendPayload(backend)).let { r -> if (r.ok && r.value != null) json.decodeFromJsonElement(ModelListResult.serializer(), r.value!!).items else emptyList() } }
            .getOrElse { emptyList() }

    suspend fun agentProfileList(backend: String): List<AgentProfile> =
        runCatching { call("agent.profile.list", backendPayload(backend)).let { r -> if (r.ok && r.value != null) json.decodeFromJsonElement(AgentProfileListResult.serializer(), r.value!!).items else emptyList() } }
            .getOrElse { emptyList() }

    suspend fun modelSelect(sessionId: String, model: ModelRef) =
        call("model.select", buildJsonObject {
            put("sessionId", sessionId)
            put("model", buildJsonObject {
                put("provider", model.provider); put("model", model.model)
                model.reasoningEffort?.let { put("reasoningEffort", it) }
                model.displayName?.let { put("displayName", it) }
            })
        })

    suspend fun permissionMenu(sessionId: String, open: Boolean): PermissionMenuState =
        call("session.permissionMenu", buildJsonObject { put("sessionId", sessionId); put("open", open) })
            .let { json.decodeFromJsonElement(PermissionMenuState.serializer(), it.requireValue()) }

    suspend fun permissionSelect(sessionId: String, profileId: String, confirmed: Boolean = false): PermissionMenuState =
        call("session.permissionSelect", buildJsonObject {
            put("sessionId", sessionId); put("profileId", profileId); put("confirmed", confirmed)
        })
            .let { json.decodeFromJsonElement(PermissionMenuState.serializer(), it.requireValue()) }

    suspend fun sessionPermissionPresetList(sessionId: String): SessionPermissionPresetState =
        call("session.permissionPresetList", buildJsonObject { put("sessionId", sessionId) })
            .let { json.decodeFromJsonElement(SessionPermissionPresetState.serializer(), it.requireValue()) }

    suspend fun sessionPermissionPresetSelect(sessionId: String, presetId: String, confirmed: Boolean): SessionPermissionPresetState =
        call("session.permissionPresetSelect", buildJsonObject {
            put("sessionId", sessionId); put("presetId", presetId); put("confirmed", confirmed)
        }).let { json.decodeFromJsonElement(SessionPermissionPresetState.serializer(), it.requireValue()) }

    suspend fun deviceList(): List<DeviceInfo> =
        runCatching { call("device.list").let { r -> if (r.ok && r.value != null) json.decodeFromJsonElement(DeviceListResult.serializer(), r.value!!).items else emptyList() } }
            .getOrElse { emptyList() }

    suspend fun deviceRevoke(deviceId: String) = call("device.revoke", buildJsonObject { put("deviceId", deviceId) })

    private fun backendPayload(backend: String?): JsonElement = buildJsonObject { backend?.let { put("backend", it) } }

    private fun modelJson(model: ModelRef): JsonElement = buildJsonObject {
        put("provider", model.provider); put("model", model.model)
        model.reasoningEffort?.let { put("reasoningEffort", it) }
        model.displayName?.let { put("displayName", it) }
    }

    private suspend fun awaitWithTimeout(deferred: CompletableDeferred<RpcResult<JsonElement>>): RpcResult<JsonElement> =
        withContext(Dispatchers.IO) {
            try {
                val r = kotlinx.coroutines.withTimeout(60_000) { deferred.await() }
                // token 失效（网关重启/吊销）：触发上层登出，引导重新登录，而非静默返回空
                if (!r.ok && (r.error?.code == "auth-required" || r.error?.code == "unauthorized")) {
                    onAuthFailed()
                }
                r
            } catch (_: Exception) {
                RpcResult(ok = false, error = RpcError("timeout", "请求超时"))
            }
        }
}

private fun Binding.wsScheme(): String = "wss"

private fun kotlinx.coroutines.CoroutineScope.launchSafe(block: suspend () -> Unit) {
    launch(Dispatchers.IO) { runCatching { block() } }
}


class AccessFailure(val code: String) : Exception(when (code) {
    "pair-invalid" -> "配对码已失效，请重新打开电脑端配对页。"
    "pair-pending" -> "已有手机等待确认，请在电脑端关闭并重新打开配对页。"
    "phone-slot-occupied" -> "此账号已绑定其他手机，请先在电脑端解除旧绑定。"
    "unauthorized" -> "授权已失效，请重新配对。"
    "pc-offline" -> "电脑暂时离线，请启动电脑端并连接隧道。"
    "rate-limited" -> "操作过于频繁，请稍后重试。"
    "upgrade-required" -> "服务器尚未切换新版，请等待管理员发布。"
    else -> "操作失败，请检查网络后重试。"
})
