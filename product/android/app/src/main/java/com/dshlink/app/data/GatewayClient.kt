package com.dshlink.app.data

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
 * 自签证书：信任所有证书（DSH Link 服务器无域名场景；生产建议换正规证书）。
 */
class GatewayClient(
    private val binding: Binding,
    private val onPush: (ServerRequest) -> Unit,
    private val onConnChange: (Boolean) -> Unit,
    private val onAuthFailed: () -> Unit = {},
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .sslSocketFactory(TrustAll.socketFactory, TrustAll.trustManager)
        .hostnameVerifier { _, _ -> true }
        .build()

    var token: String = ""

    private var ws: WebSocket? = null
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
    fun connect() {
        if (token.isEmpty()) return
        // 网关经 HTTPS 反代，WebSocket 恒为 wss://（必须是 :// 而非 //，否则 OkHttp 解析抛异常）
        val url = "wss://${binding.wsHost}:${binding.wsPort}/ws?token=${java.net.URLEncoder.encode(token, "UTF-8")}"
        val req = Request.Builder().url(url).build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                android.util.Log.w("DSHLINK", "WS OPEN url=$url")
                onConnChange(true)
                scope.launchSafe { hello() }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(text)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                android.util.Log.w("DSHLINK", "WS CLOSED code=$code reason=$reason")
                onConnChange(false)
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                android.util.Log.w("DSHLINK", "WS FAIL=${t.message} resp=${response?.code}")
                onConnChange(false)
                scheduleReconnect()
            }
        })
    }

    fun disconnect() {
        ws?.close(1000, "bye")
        ws = null
    }

    private var reconnectAttempts = 0
    private fun scheduleReconnect() {
        if (reconnectAttempts > 10) return
        val delay = (500L * (1 shl reconnectAttempts)).coerceAtMost(30_000L)
        reconnectAttempts++
        scope.launchSafe {
            kotlinx.coroutines.delay(delay)
            if (token.isNotEmpty()) connect()
        }
    }

    suspend fun call(method: String, payload: JsonElement = buildJsonObject {}): RpcResult<JsonElement> {
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
        return awaitWithTimeout(deferred)
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
        call("auth.hello", buildJsonObject { })
    }

    // ── 便捷方法（全部防御式：后端不可达/解析失败 → 返回空/默认，不抛异常）──
    suspend fun sessionList(): List<GatewaySession> =
        runCatching { call("session.list").let { r -> if (r.ok && r.value != null) json.decodeFromJsonElement(SessionListResult.serializer(), r.value!!).sessions else emptyList() } }
            .getOrElse { emptyList() }

    suspend fun sessionCreate(backend: String, title: String? = null, workspaceId: String? = null): GatewaySession? =
        runCatching {
            call("session.create", buildJsonObject {
                put("backend", backend)
                title?.let { put("title", it) }
                workspaceId?.let { put("workspaceId", it) }
            }).let { r -> if (r.ok && r.value != null) json.decodeFromJsonElement(GatewaySession.serializer(), r.value!!) else null }
        }.getOrNull()

    /** 恢复（附加）一个已有后端会话，返回可供聊天的网关会话 */
    suspend fun resumeSession(backend: String, backendSessionId: String): GatewaySession? =
        runCatching {
            call("session.resume", buildJsonObject {
                put("backend", backend)
                put("backendSessionId", backendSessionId)
            }).let { r -> if (r.ok && r.value != null) json.decodeFromJsonElement(GatewaySession.serializer(), r.value!!) else null }
        }.getOrNull()

    suspend fun sessionPrompt(sessionId: String, text: String) =
        call("session.prompt", buildJsonObject {
            put("sessionId", sessionId)
            put("parts", buildJsonArray {
                add(buildJsonObject { put("type", "text"); put("text", text) })
            })
            put("queueAction", "queue")
        })

    suspend fun sessionCancel(sessionId: String) = call("session.cancel", buildJsonObject { put("sessionId", sessionId) })

    suspend fun sessionRename(sessionId: String, title: String) =
        call("session.rename", buildJsonObject { put("sessionId", sessionId); put("title", title) })

    suspend fun sessionHistory(sessionId: String): List<AgentEvent> =
        runCatching {
            call("session.history", buildJsonObject { put("sessionId", sessionId) })
                .let { r ->
                    if (r.ok && r.value != null) {
                        val ev = json.decodeFromJsonElement(HistoryResult.serializer(), r.value!!).events
                        android.util.Log.w("DSHLINK", "historyRPC ok sid=$sessionId events=${ev.size}")
                        ev
                    } else {
                        android.util.Log.w("DSHLINK", "historyRPC kafka sid=$sessionId ok=${r.ok} err=${r.error?.code} ${r.error?.message}")
                        emptyList()
                    }
                }
        }.onFailure { android.util.Log.w("DSHLINK", "historyRPC DECODE-FAIL sid=$sessionId: ${it}") }
            .getOrElse { emptyList() }

    suspend fun respond(sessionId: String, serverRequestRpcId: String, payload: JsonElement) =
        call("respond", buildJsonObject {
            put("sessionId", sessionId)
            put("serverRequestRpcId", serverRequestRpcId)
            put("payload", payload)
        })

    suspend fun workspaceList(): List<WorkspaceView> =
        runCatching { call("workspace.list").let { r -> if (r.ok && r.value != null) json.decodeFromJsonElement(WorkspaceListResult.serializer(), r.value!!).items else emptyList() } }
            .getOrElse { emptyList() }

    suspend fun workspaceTree(): List<WorkspaceNode> =
        runCatching {
            val ret = call("workspace.tree").let { r ->
                if (r.ok && r.value != null) {
                    val items = json.decodeFromJsonElement(WorktreeResult.serializer(), r.value!!).items
                    android.util.Log.w("DSHLINK", "treeRPC ok items=${items.size}")
                    items
                } else {
                    android.util.Log.w("DSHLINK", "treeRPC kafka ok=${r.ok} err=${r.error?.code} ${r.error?.message}")
                    emptyList()
                }
            }
            ret
        }.onFailure { android.util.Log.w("DSHLINK", "treeRPC FAIL: ${it}") }
            .getOrElse { emptyList() }

    suspend fun workspaceDelete(workspaceId: String) =
        call("workspace.delete", buildJsonObject { put("workspaceId", workspaceId) })

    suspend fun archiveSession(sessionId: String) =
        call("workspace.archiveSession", buildJsonObject { put("sessionId", sessionId) })

    suspend fun workspaceCreate(path: String): WorkspaceCreateResult =
        runCatching {
            call("workspace.create", buildJsonObject { put("path", path) })
                .let { r -> if (r.ok && r.value != null) json.decodeFromJsonElement(WorkspaceCreateResult.serializer(), r.value!!) else WorkspaceCreateResult() }
        }.getOrElse { WorkspaceCreateResult() }

    /** 目录浏览：调网关 fs.listDir，path="" 返回盘符根，非空返回子目录（经 frp 读笔记本本地目录） */
    suspend fun dirList(path: String): DirListResult =
        runCatching {
            call("fs.listDir", buildJsonObject { put("path", path) })
                .let { r ->
                    if (r.ok && r.value != null) {
                        val d = json.decodeFromJsonElement(DirListResult.serializer(), r.value!!)
                        android.util.Log.w("DSHLINK", "dirRPC ok path=${d.path} dirs=${d.dirs?.size} roots=${d.roots?.size}")
                        d
                    } else {
                        android.util.Log.w("DSHLINK", "dirRPC kafka ok=${r.ok} err=${r.error?.code} ${r.error?.message}")
                        DirListResult()
                    }
                }
        }.onFailure { android.util.Log.w("DSHLINK", "dirRPC FAIL: ${it}") }
            .getOrElse { DirListResult() }

    suspend fun modelList(): List<ModelRef> =
        runCatching { call("model.list").let { r -> if (r.ok && r.value != null) json.decodeFromJsonElement(ModelListResult.serializer(), r.value!!).items else emptyList() } }
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

    suspend fun deviceList(): List<DeviceInfo> =
        runCatching { call("device.list").let { r -> if (r.ok && r.value != null) json.decodeFromJsonElement(DeviceListResult.serializer(), r.value!!).items else emptyList() } }
            .getOrElse { emptyList() }

    suspend fun deviceRevoke(deviceId: String) = call("device.revoke", buildJsonObject { put("deviceId", deviceId) })

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

/** 自签证书：信任所有（仅用于 DSH Link 无域名服务器） */
private object TrustAll {
    val trustManager: javax.net.ssl.X509TrustManager = object : javax.net.ssl.X509TrustManager {
        override fun checkClientTrusted(chain: Array<out java.security.cert.X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<out java.security.cert.X509Certificate>?, authType: String?) {}
        override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = arrayOf()
    }
    val socketFactory: javax.net.ssl.SSLSocketFactory =
        javax.net.ssl.SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustManager), null) }.socketFactory
}
