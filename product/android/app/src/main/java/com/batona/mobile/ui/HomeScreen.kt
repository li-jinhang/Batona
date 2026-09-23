package com.batona.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedIconButton
import androidx.compose.ui.unit.sp
import com.batona.mobile.ui.theme.BatonaAmber
import com.batona.mobile.ui.theme.BatonaAmberSurface
import com.batona.mobile.ui.theme.BatonaGreen
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.batona.mobile.BuildConfig
import com.batona.mobile.AgentNotification
import com.batona.mobile.SettingsStore
import com.batona.mobile.data.AgentEvent
import com.batona.mobile.data.AgentProfile
import com.batona.mobile.data.Binding
import com.batona.mobile.data.CodexMirrorCache
import com.batona.mobile.data.GatewayClient
import com.batona.mobile.data.GatewayFailure
import com.batona.mobile.data.GatewaySession
import com.batona.mobile.data.ModelRef
import com.batona.mobile.data.QuestionItem
import com.batona.mobile.data.ServerRequest
import com.batona.mobile.data.SessionNode
import com.batona.mobile.data.WorkspaceNode
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

private val json = Json { ignoreUnknownKeys = true }

internal data class ChatLine(val id: Long, val kind: String, val text: String = "", val toolName: String = "", val reasoning: String = "")

internal data class PendingFrame(
    val kind: String, val rpcId: String, val toolName: String = "",
    val reason: String = "", val questions: List<QuestionItem> = emptyList(),
)

internal class HomeState(val backend: String) {
    val label: String get() = if (backend == "codex") "Codex" else "DSH"
    // 网关推送没有 backend 字段；只接收此入口恢复/创建过的网关会话。
    val gatewaySessionIds: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()
    val worktree = mutableStateListOf<WorkspaceNode>()
    val expanded = mutableStateMapOf<String, Boolean>()
    val olderExpanded = mutableStateMapOf<String, Boolean>()
    val lines = mutableStateListOf<ChatLine>()
    val models = mutableStateListOf<ModelRef>()
    val profiles = mutableStateListOf<AgentProfile>()
    val profileBySession = mutableStateMapOf<String, String>()

    var currentId by mutableStateOf<String?>(null)          // gatewaySession.id（聊天视图）
    var currentBackendSessionId by mutableStateOf<String?>(null) // 用于 Codex 离线镜像键
    var currentTitle by mutableStateOf<String?>(null)        // 聊天顶部：会话标题
    var currentWsTitle by mutableStateOf<String?>(null)      // 聊天顶部：所属工作区名
    var offlineMirror by mutableStateOf(false)               // 仅浏览 Codex 已缓存历史，禁止发送
    var entering by mutableStateOf(false)                    // 正在进入会话（切视图 + 加载历史）
    var pending by mutableStateOf<PendingFrame?>(null)
    var connected by mutableStateOf(false)
    var selectedModel by mutableStateOf<ModelRef?>(null)
    var showModels by mutableStateOf(false)
    var showEfforts by mutableStateOf(false)
    var showProfiles by mutableStateOf(false)
    var permissionSyncing by mutableStateOf(false)
    var permissionError by mutableStateOf<String?>(null)
    var loading by mutableStateOf(false)
    var treeError by mutableStateOf<String?>(null)
    var sessionError by mutableStateOf<String?>(null)
    var requestedSessionId by mutableStateOf<String?>(null)
    var historyRevision by mutableIntStateOf(0)
    var createAfterWorkspace by mutableStateOf(false)
    // 已读会话（DSH sessionId 集）：点进会话后取消"未读绿点"
    val readSessions = mutableStateListOf<String>()
    var input by mutableStateOf("")
    var busy by mutableStateOf(false)
    var sending by mutableStateOf(false)
    var answering by mutableStateOf(false)
    var wsPath by mutableStateOf("")      // 新工作区路径
    var showNewWs by mutableStateOf(false) // 是否显示"新建工作区"输入行
    var showDirBrowser by mutableStateOf(false) // 是否显示目录浏览
    var dirEntries by mutableStateOf<List<String>>(emptyList()) // 当前目录子目录
    var dirRoots by mutableStateOf<List<String>>(emptyList())   // 盘符根
    var dirPath by mutableStateOf("")     // 当前浏览目录
    var dirLoading by mutableStateOf(false)
    var renaming by mutableStateOf<String?>(null) // 正在重命名的会话 id（null=无）
    var renameText by mutableStateOf("")          // 重命名输入框文本
    var archiving by mutableStateOf<String?>(null) // 待确认归档的会话 id
    var deletingWs by mutableStateOf<String?>(null) // 待确认删除的工作区 id
    var onTitleChanged: (() -> Unit)? = null       // 会话标题变化时回调（刷新工作区树）
    var onAgentNotice: ((String) -> Unit)? = null  // 不携带消息正文的状态通知
    var codexCachedTree: List<WorkspaceNode> = emptyList()
    val codexCachedHistories = mutableStateMapOf<String, List<AgentEvent>>()
    private var streamingAsst = false              // 最后一条是否正被 assistant/chunk 流式累积

    suspend fun openSession(id: String, resume: suspend (String, String) -> GatewaySession?) {
        requestedSessionId = id
        currentId = null
        currentBackendSessionId = null
        selectedModel = null
        entering = true
        sessionError = null
        try {
            val session = resume(backend, id) ?: throw GatewayFailure("invalid-response")
            gatewaySessionIds.add(session.id)
            currentId = session.id
            currentBackendSessionId = session.backendSessionId
            currentTitle = session.title ?: currentTitle
            selectedModel = session.model
            offlineMirror = false
            entering = false
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            sessionError = if (failure is GatewayFailure) failure.message else "会话加载失败，请重试。"
            // Keep the chat page open with retry/back instead of silently returning to the list.
        }
    }

    /** 更新工作区树中某会话的标题（session/title 事件触达时） */
    fun updateSessionTitle(sid: String?, title: String?) {
        if (sid == null || title.isNullOrBlank()) return
        // 就地更新该会话在 worktree 里的标题（用 copy 生成新节点替换）
        for (i in worktree.indices) {
            val node = worktree[i]
            val idx = node.sessions.indexOfFirst { it.sessionId == sid }
            if (idx >= 0) {
                val newSessions = node.sessions.toMutableList()
                newSessions[idx] = newSessions[idx].copy(title = title)
                worktree[i] = node.copy(sessions = newSessions)
            }
        }
        if (currentId == sid) currentTitle = title
    }

    /** 当前可见树的会话状态随 PC/手机任一端的事件更新；下一次快照会作为权威纠正。 */
    fun updateSessionState(sid: String?, nextState: String?) {
        if (sid == null || nextState.isNullOrBlank()) return
        for (i in worktree.indices) {
            val node = worktree[i]
            val idx = node.sessions.indexOfFirst { it.sessionId == sid }
            if (idx >= 0) {
                val copy = node.sessions.toMutableList()
                copy[idx] = copy[idx].copy(state = nextState, updatedAt = System.currentTimeMillis())
                worktree[i] = node.copy(sessions = copy)
            }
        }
    }

    /** 追加一条事件到聊天：用 streamingAsst 去重"流式 chunk 累积"与"最终 assistant/message"的重复 */
    fun appendEvent(ev: AgentEvent) {
        when (ev.type) {
            "user/message" -> {
                streamingAsst = false
                // 去重：若最后一条 user 行与该事件正文相同（乐观添加 + DSH 回传同一消息），不重复添加
                val last = lines.lastOrNull()
                val text = ev.text ?: ""
                if (last != null && last.kind == "user" && last.text == text) return
                lines.add(ChatLine(System.nanoTime(), "user", text))
            }
            "assistant/message" -> {
                // 上一条是流式累积中的 assistant → 用最终 message 替换它，避免重复
                val last = lines.lastOrNull()
                if (streamingAsst && last != null && last.kind == "assistant") {
                    lines[lines.size - 1] = last.copy(text = ev.text ?: last.text, reasoning = ev.reasoning ?: last.reasoning)
                } else {
                    lines.add(ChatLine(System.nanoTime(), "assistant", ev.text ?: "", reasoning = ev.reasoning ?: ""))
                }
                streamingAsst = false
            }
            "assistant/chunk" -> {
                val last = lines.lastOrNull()
                val r = ev.reasoning ?: ""
                val t = ev.text ?: ""
                if (streamingAsst && last != null && last.kind == "assistant") {
                    // 正在流式累积：追加到当前 assistant 行
                    lines[lines.size - 1] = last.copy(text = last.text + t, reasoning = last.reasoning + r)
                } else {
                    // 新一条 assistant 开始流式：另起一行
                    lines.add(ChatLine(System.nanoTime(), "assistant", t, reasoning = r))
                }
                streamingAsst = true
            }
            "tool/call" -> { streamingAsst = false; lines.add(ChatLine(System.nanoTime(), "tool", "正在执行", ev.toolName ?: "工具")) }
            "tool/result" -> { streamingAsst = false; lines.add(ChatLine(System.nanoTime(), "tool", ev.summary ?: if (ev.ok == true) "已完成" else "执行失败", ev.toolName ?: "工具")) }
            "session/title" -> lines.add(ChatLine(System.nanoTime(), "system", "标题：${ev.title}"))
            "error" -> { streamingAsst = false; lines.add(ChatLine(System.nanoTime(), "system", "错误：${ev.message ?: "Codex 执行失败"}")) }
            // 骨架事件（turn/start·turn/end·step/start·step/end·done）不显示：只重置流式标记，避免噪音行（如"- turn/start -"）
            else -> { streamingAsst = false; /* 忽略骨架事件 */ }
        }
    }

    fun handlePush(frame: ServerRequest) {
        try {
            val sessionId = frame.payload.jsonObject["sessionId"]?.jsonPrimitive?.content ?: return
            if (sessionId != currentId && sessionId !in gatewaySessionIds) return
            when (frame.method) {
                "session/event" -> {
                    val o = frame.payload.jsonObject
                    val sid = o["sessionId"]?.jsonPrimitive?.content
                    val ev = json.decodeFromJsonElement(AgentEvent.serializer(), o["event"] ?: o)
                    // 会话标题事件：不放进聊天，更新树标题并触发刷新（电脑端自动总结标题后手机端即时更新）
                    if (ev.type == "session/title") {
                        updateSessionTitle(sid, ev.title)
                        onTitleChanged?.invoke()
                        return
                    }
                    when (ev.type) {
                        "turn/start" -> updateSessionState(sid, "running")
                        "turn/end", "done" -> { updateSessionState(sid, "done"); onAgentNotice?.invoke("completed") }
                        "error" -> { updateSessionState(sid, "error"); onAgentNotice?.invoke("failed") }
                    }
                    // 只渲染当前会话的事件，避免其他会话消息混入
                    if (sid == null || currentId == null || sid != currentId) return
                    android.util.Log.w("BATONA", "push session/event sid=$sid cur=$currentId type=${ev.type}")
                    appendEvent(ev)
                }
                "approval/requested" -> {
                    val o = frame.payload.jsonObject
                    val sid = o["sessionId"]?.jsonPrimitive?.content
                    if (sid == null || currentId == null || sid != currentId) return
                    pending = PendingFrame("approval", frame.rpcId,
                        o["toolName"]?.jsonPrimitive?.content ?: "",
                        o["reason"]?.jsonPrimitive?.content ?: "")
                    onAgentNotice?.invoke("approval")
                    lines.add(ChatLine(System.nanoTime(), "system", "⚠️ 等待审批：${pending?.toolName}"))
                    updateSessionState(sid, "waiting-approval")
                }
                "question/requested" -> {
                    val o = frame.payload.jsonObject
                    val sid = o["sessionId"]?.jsonPrimitive?.content
                    android.util.Log.w("BATONA", "push question sid=$sid cur=$currentId rpc=${frame.rpcId} qs=${o["questions"]?.toString()?.take(80)}")
                    if (sid == null || currentId == null || sid != currentId) { android.util.Log.w("BATONA", "question SKIPPED (not current)"); return }
                    val qs = o["questions"]?.let {
                        json.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(QuestionItem.serializer()), it)
                    } ?: emptyList()
                    pending = PendingFrame("question", frame.rpcId, questions = qs)
                    onAgentNotice?.invoke("question")
                    lines.add(ChatLine(System.nanoTime(), "system", "❓ ${qs.firstOrNull()?.prompt ?: "问题"}"))
                    updateSessionState(sid, "waiting-question")
                }
            }
        } catch (_: Exception) { /* 忽略畸形帧 */ }
    }
}

@Composable
private fun BackendEffects(state: HomeState, client: GatewayClient, store: SettingsStore) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    state.onAgentNotice = { kind -> AgentNotification.post(context, kind) }

    fun saveCodexMirror() {
        val projection = state.worktree.map { node -> node.copy(sessions = node.sessions.take(5)) }
        val histories = state.codexCachedHistories.mapValues { (_, events) -> events.takeLast(200) }
        scope.launch { store.saveCodexMirror(CodexMirrorCache(projection, histories, System.currentTimeMillis())) }
    }

    // 仅加载已绑定手机自己的本地副本。重新绑定或注销时 SettingsStore.clear() 会清除它。
    LaunchedEffect(Unit) {
        if (state.backend != "codex") return@LaunchedEffect
        store.loadCodexMirror()?.let { cache ->
            state.codexCachedTree = cache.worktree
            state.codexCachedHistories.clear()
            state.codexCachedHistories.putAll(cache.histories.mapValues { (_, events) -> events.takeLast(200) })
            if (!state.connected) state.worktree.addAll(cache.worktree)
        }
    }

    // 等 WebSocket 连上后再加载当前后端；Codex 与 DSH 的会话/工作区绝不混在同一树里。
    LaunchedEffect(state.connected, state.backend) {
        android.util.Log.w("BATONA", "connectedEffect backend=${state.backend} connected=${state.connected}")
        if (!state.connected) {
            state.loading = false
            return@LaunchedEffect
        }
        state.loading = true
        state.refreshTree(client, store)
        runCatching {
            android.util.Log.w("BATONA", "worktree loaded size=${state.worktree.size}")
            state.models.clear(); state.models.addAll(client.modelList(state.backend))
            state.profiles.clear()
            if (state.backend == "codex") state.profiles.addAll(client.agentProfileList("codex").filter { it.available })
        }
        state.loading = false
    }

    fun refreshTree() = scope.launch { state.refreshTree(client, store) }

    // PC 桌面端已有 Codex 会话也会改动持久记录；定期取 PC 权威快照让手机状态追上。
    LaunchedEffect(state.connected, state.backend) {
        if (!state.connected) return@LaunchedEffect
        while (true) {
            kotlinx.coroutines.delay(5_000)
            state.refreshTree(client, store)
        }
    }
    // session/title 事件到达时刷新工作区树（网关已有标题缓存，拉取即得最新标题）
    state.onTitleChanged = { refreshTree() }

    // 当前会话历史（聊天会话变化时加载）
    LaunchedEffect(state.currentId, state.historyRevision) {
        try {
            val id = state.currentId ?: return@LaunchedEffect
            if (state.offlineMirror) return@LaunchedEffect
            state.sessionError = null
            state.lines.clear()
            val history = client.sessionHistory(id)
            android.util.Log.w("BATONA", "history sid=$id size=${history.size} first=${history.firstOrNull()?.type}")
            state.lines.addAll(history.map { ev -> ChatLine(System.nanoTime(), kindOf(ev), textOf(ev), ev.toolName ?: "", reasoning = ev.reasoning ?: "") })
            state.lines.add(ChatLine(System.nanoTime(), "system", "已连接到会话"))
            val backendSessionId = state.currentBackendSessionId
            if (state.backend == "codex" && backendSessionId != null) {
                state.codexCachedHistories[backendSessionId] = history.takeLast(200)
                saveCodexMirror()
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            state.sessionError = if (failure is GatewayFailure) failure.message else "历史加载失败，请重试。"
        }
    }
}

private suspend fun HomeState.refreshTree(client: GatewayClient, store: SettingsStore) {
    if (!connected) return
    try {
    val tree = client.workspaceTree(backend)
    worktree.clear()
    worktree.addAll(tree)
    treeError = null
    // PC 隧道恢复不一定触发手机 WebSocket 重连；补取初次离线时没拿到的能力。
    if (models.isEmpty()) models.addAll(client.modelList(backend))
    if (backend == "codex" && profiles.isEmpty()) profiles.addAll(client.agentProfileList(backend).filter { it.available })
    // 刷新不改变用户的展开选择，也不修改另一入口的列表或缓存。
    if (backend == "codex") {
        codexCachedTree = tree.map { it.copy(sessions = it.sessions.take(5)) }
        store.saveCodexMirror(CodexMirrorCache(codexCachedTree,
            codexCachedHistories.mapValues { it.value.takeLast(200) }, System.currentTimeMillis()))
    }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (failure: Exception) {
        treeError = if (failure is GatewayFailure) failure.message else "工作区同步失败，请重试。"
    }
}

@Composable
fun HomeScreen(binding: Binding, token: String, store: SettingsStore, onLogout: () -> Unit) {
    val scope = rememberCoroutineScope()
    val dshState = remember(binding, token) { HomeState("dsh") }
    val codexState = remember(binding, token) { HomeState("codex") }
    var tab by remember { mutableIntStateOf(0) }
    val state = if (tab == 1) codexState else dshState
    val client = remember(binding, token) {
        GatewayClient(binding,
            onPush = { frame -> dshState.handlePush(frame); codexState.handlePush(frame) },
            onConnChange = { connected -> dshState.connected = connected; codexState.connected = connected },
            onAuthFailed = { onLogout() },
        ).apply { this.token = token }
    }
    DisposableEffect(client) { client.connect(); onDispose { client.disconnect() } }
    // 两个入口一直保留状态和事件订阅；切换导航不会重置会话、草稿或待审批内容。
    key(dshState) { BackendEffects(dshState, client, store) }
    key(codexState) { BackendEffects(codexState, client, store) }
    fun refreshTree() = scope.launch { state.refreshTree(client, store) }

    Scaffold(
        bottomBar = {
            val keyboardOpen = WindowInsets.ime.getBottom(LocalDensity.current) > 0
            if (!keyboardOpen) BackendNavigation(tab) { tab = it }
        },
    ) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
          key(tab) {
            when (tab) {
                0, 1 -> ChatTab(state, client,
                    backend = state.backend,
                    onSelectSession = { sessionId, wsTitle ->
                        // 立即切入聊天视图（loading），历史异步加载，避免等网关往返
                        state.entering = true
                        state.currentWsTitle = wsTitle
                        state.currentTitle = state.worktree.flatMap { it.sessions }.firstOrNull { it.sessionId == sessionId }?.title
                        state.lines.clear()
                        state.pending = null   // 切换会话：清掉上一会话的提问/审批
                        state.selectedModel = null
                        state.readSessions.add(sessionId)   // 标记已读：取消未读绿点
                        if (state.backend == "codex" && !state.connected) {
                            val cached = state.codexCachedHistories[sessionId]
                            if (cached != null) {
                                state.currentBackendSessionId = sessionId
                                state.currentId = "offline:$sessionId"
                                state.currentTitle = state.worktree.asSequence().flatMap { it.sessions.asSequence() }.firstOrNull { it.sessionId == sessionId }?.title
                                state.lines.addAll(cached.map { ev -> ChatLine(System.nanoTime(), kindOf(ev), textOf(ev), ev.toolName ?: "", reasoning = ev.reasoning ?: "") })
                                state.lines.add(ChatLine(System.nanoTime(), "system", "离线缓存：恢复网络后可继续发送"))
                                state.offlineMirror = true
                            }
                            state.entering = false
                            return@ChatTab
                        }
                        scope.launch {
                            state.openSession(sessionId, client::resumeSession)
                        }
                    },
                    onBack = { state.currentId = null; state.currentBackendSessionId = null; state.entering = false; state.offlineMirror = false; state.lines.clear(); state.pending = null; state.sessionError = null },
                    onRetry = {
                        if (state.currentId != null) state.historyRevision++
                        else state.requestedSessionId?.let { id -> scope.launch { state.openSession(id, client::resumeSession) } }
                    },
                    onToggle = { wsId -> state.expanded[wsId] = !(state.expanded[wsId] ?: false) },
                    onNewSession = { wsId, wsTitle, wsPath ->
                        if (state.backend == "codex" && wsPath == null) {
                            state.createAfterWorkspace = true
                            state.showNewWs = true
                            return@ChatTab
                        }
                        state.entering = true
                        state.currentWsTitle = wsTitle
                        state.lines.clear()
                        state.pending = null   // 新建会话：清上一会话提问/审批
                        scope.launch {
                            val profile = state.profiles.firstOrNull()?.id
                            val gs = client.sessionCreate(state.backend, "新会话", wsId, wsPath, state.selectedModel, profile)
                            if (gs != null) {
                                state.gatewaySessionIds.add(gs.id)
                                state.currentId = gs.id; state.currentBackendSessionId = gs.backendSessionId; state.currentTitle = gs.title; state.offlineMirror = false
                                state.selectedModel = gs.model
                                profile?.let { state.profileBySession[gs.id] = it }
                            }
                            state.entering = false
                            refreshTree()
                        }
                    },
                    onDeleteWs = { wsId -> scope.launch { client.workspaceDelete(wsId, state.backend); refreshTree() } },
                    onArchive = { sid -> scope.launch { client.archiveSession(sid, state.backend); refreshTree() } },
                    onNewWorkspace = { path ->
                        scope.launch {
                            val created = client.workspaceCreate(path, state.backend)
                            state.wsPath = ""; state.showNewWs = false
                            if (state.createAfterWorkspace && created.workspace != null) {
                                state.createAfterWorkspace = false
                                state.entering = true
                                state.currentWsTitle = created.workspace.title
                                val profile = state.profiles.firstOrNull()?.id
                                val gs = client.sessionCreate(state.backend, "新会话", created.workspace.workspaceId, created.workspace.path, state.selectedModel, profile)
                                if (gs != null) {
                                    state.gatewaySessionIds.add(gs.id)
                                    state.currentId = gs.id; state.currentBackendSessionId = gs.backendSessionId; state.currentTitle = gs.title; state.offlineMirror = false
                                    state.selectedModel = gs.model
                                    profile?.let { state.profileBySession[gs.id] = it }
                                }
                                state.entering = false
                            }
                            refreshTree()
                        }
                    },
                    onAnswer = { payload ->
                        val p = state.pending ?: return@ChatTab
                        if (!state.connected || state.offlineMirror || state.answering) return@ChatTab
                        val sessionId = state.currentId ?: return@ChatTab
                        state.answering = true
                        scope.launch {
                            try {
                                val result = client.respond(sessionId, p.rpcId, payload)
                                if (!result.ok) throw GatewayFailure(result.error?.code ?: "request-failed")
                                if (state.pending?.rpcId == p.rpcId) state.pending = null
                            } catch (cancelled: CancellationException) { throw cancelled }
                            catch (e: Exception) { state.sessionError = e.message ?: "应答失败，请重试。" }
                            finally { state.answering = false }
                        }
                    },
                    onWsChanged = { refreshTree() },
                )
                2 -> Box(Modifier.fillMaxSize().testTag("claude-code-placeholder")) // Reserved; no backend or controls yet.
                3 -> SettingsTab(binding, state, onLogout)
            }
          }
        }
    }
}

@Composable
internal fun BackendNavigation(selected: Int, onSelect: (Int) -> Unit) {
    NavigationBar(containerColor = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp) {
        val labels = listOf("DSH", "Codex", "Claude Code", "设置")
        val icons = listOf(Icons.Outlined.ChatBubbleOutline, Icons.Outlined.Code, Icons.Outlined.Terminal, Icons.Outlined.Settings)
        labels.forEachIndexed { index, label ->
            NavigationBarItem(selected = selected == index, onClick = { onSelect(index) },
                colors = NavigationBarItemDefaults.colors(selectedIconColor = MaterialTheme.colorScheme.primary,
                    selectedTextColor = MaterialTheme.colorScheme.primary, indicatorColor = MaterialTheme.colorScheme.primaryContainer),
                icon = { Icon(icons[index], null) },
                label = { Text(label, maxLines = 1, fontSize = if (index == 2) 11.sp else 12.sp) })
        }
    }
}

// ── 会话 Tab：工作区树 + 聊天 ─────────────────────────────────────────
@Composable
internal fun ChatTab(
    state: HomeState,
    client: GatewayClient,
    backend: String,
    onSelectSession: (sessionId: String, wsTitle: String) -> Unit,
    onBack: () -> Unit,
    onToggle: (String) -> Unit,
    onNewSession: (wsId: String?, wsTitle: String?, wsPath: String?) -> Unit,
    onDeleteWs: (String) -> Unit,
    onArchive: (String) -> Unit,
    onNewWorkspace: (String) -> Unit,
    onAnswer: (kotlinx.serialization.json.JsonObject) -> Unit,
    onWsChanged: () -> Unit,
    onRetry: () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    if (state.showModels) {
        AlertDialog(
            onDismissRequest = { state.showModels = false },
            title = { Text("${state.label} · 选择模型") },
            text = { ModelsTab(state, onSelect = { model ->
                if (state.busy || !state.connected || state.offlineMirror) return@ModelsTab
                state.busy = true
                scope.launch {
                    val sessionId = state.currentId
                    try {
                        if (sessionId == null) return@launch
                        val result = client.modelSelect(sessionId, model)
                        if (!result.ok) throw GatewayFailure(result.error?.code ?: "request-failed")
                        if (state.currentId == sessionId) {
                            state.selectedModel = model
                            state.sessionError = null
                        }
                        state.showModels = false
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (e: Exception) {
                        state.sessionError = e.message ?: "模型切换失败，请重试。"
                        state.showModels = false
                    } finally { state.busy = false }
                }
            }) },
            confirmButton = { TextButton(onClick = { state.showModels = false }) { Text("关闭") } },
        )
    }
    if (state.showEfforts) {
        AlertDialog(
            onDismissRequest = { state.showEfforts = false },
            title = { Text("Codex · 思考强度") },
            text = { EffortsTab(state, onSelect = { selection ->
                if (state.busy || !state.connected || state.offlineMirror) return@EffortsTab
                val sessionId = state.currentId ?: return@EffortsTab
                state.busy = true
                scope.launch {
                    try {
                        val result = client.modelSelect(sessionId, selection)
                        if (!result.ok) throw GatewayFailure(result.error?.code ?: "request-failed")
                        if (state.currentId == sessionId) {
                            state.selectedModel = selection
                            state.sessionError = null
                        }
                        state.showEfforts = false
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (e: Exception) {
                        state.sessionError = e.message ?: "思考强度切换失败，请重试。"
                        state.showEfforts = false
                    } finally { state.busy = false }
                }
            }) },
            confirmButton = { TextButton(onClick = { state.showEfforts = false }) { Text("关闭") } },
        )
    }
    // 列表视图：未选会话且非进入中；否则聊天主视图
    if (state.currentId == null && !state.entering) {
        Column(Modifier.fillMaxSize().testTag("backend-page-${state.backend}").padding(horizontal = 16.dp)) {
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                BatonaMark()
                Text(state.label, Modifier.weight(1f).padding(start = 10.dp), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    Box(Modifier.size(8.dp).background(if (state.connected) BatonaGreen else MaterialTheme.colorScheme.error, CircleShape))
                    Text(if (state.connected) "网关已连接" else "离线", color = if (state.connected) BatonaGreen else MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelMedium)
                }
                IconButton(onClick = onWsChanged, enabled = state.connected && !state.loading) { Icon(Icons.Outlined.Refresh, "刷新工作区") }
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("工作区", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                TextButton(onClick = { state.createAfterWorkspace = false; state.showNewWs = true }, enabled = state.connected) {
                    Icon(Icons.Outlined.Add, null, Modifier.size(18.dp)); Text("新建工作区")
                }
            }
            if (state.loading) Text("正在同步 ${state.label} 工作区…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (!state.loading && backend == "codex" && state.profiles.isEmpty() && state.connected) {
                Text("Codex 暂不可用，请检查电脑端登录与连接。", Modifier.padding(vertical = 6.dp), style = MaterialTheme.typography.bodySmall, color = BatonaAmber)
            }
            state.treeError?.let {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(it, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = onWsChanged, enabled = state.connected) { Text("重试") }
                }
            }
            if (state.showNewWs) NewWorkspaceDialog(state, client,
                onDismiss = { state.showNewWs = false; state.createAfterWorkspace = false }, onCreate = onNewWorkspace)
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (state.worktree.isEmpty() && !state.loading && state.treeError == null) {
                    item { Text("暂无 ${state.label} 工作区与会话。可新建会话或添加电脑上的工作区。", Modifier.padding(vertical = 32.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                items(state.worktree, key = { it.workspace.workspaceId }) { node ->
                    WorkspaceCard(node, state, initiallyOpen = node.workspace.workspaceId == state.worktree.firstOrNull()?.workspace?.workspaceId,
                        onSelect = onSelectSession, onNewSession = onNewSession)
                }
            }
            Button(onClick = { onNewSession(null, null, null) }, enabled = state.connected,
                modifier = Modifier.align(Alignment.CenterHorizontally).padding(vertical = 12.dp).heightIn(min = 48.dp),
                shape = RoundedCornerShape(10.dp)) {
                Icon(Icons.Outlined.Add, null); Spacer(Modifier.width(8.dp)); Text("新建会话")
            }
            // ── 会话重命名对话框 ──
            if (state.renaming != null) {
                val scope = rememberCoroutineScope()
                AlertDialog(
                    onDismissRequest = { state.renaming = null },
                    title = { Text("重命名会话") },
                    text = {
                        OutlinedTextField(state.renameText, { state.renameText = it }, modifier = Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("新标题") })
                    },
                    confirmButton = {
                        TextButton(onClick = {
                            val sid = state.renaming
                            val title = state.renameText.trim()
                            state.renaming = null
                            if (sid != null && title.isNotEmpty()) {
                                scope.launch {
                                    runCatching { client.sessionRename(sid, title, backend) }
                                    onWsChanged()   // 刷新树，标题即时更新
                                }
                            }
                        }, enabled = state.renameText.isNotBlank()) { Text("保存") }
                    },
                    dismissButton = { TextButton(onClick = { state.renaming = null }) { Text("取消") } },
                )
            }
            // ── 会话归档确认对话框 ──
            if (state.archiving != null) {
                val scope = rememberCoroutineScope()
                AlertDialog(
                    onDismissRequest = { state.archiving = null },
                    title = { Text("归档会话") },
                    text = { Text("归档后该会话将从工作区隐藏（电脑端仍保留，可在 ${state.label} 侧找回）。确定归档？") },
                    confirmButton = {
                        TextButton(onClick = {
                            val sid = state.archiving
                            state.archiving = null
                            if (sid != null) {
                                scope.launch {
                                    runCatching { onArchive(sid) }
                                    onWsChanged()   // 刷新树，归档会话将消失
                                }
                            }
                        }) { Text("确认归档", color = MaterialTheme.colorScheme.error) }
                    },
                    dismissButton = { TextButton(onClick = { state.archiving = null }) { Text("取消") } },
                )
            }
            // ── 删除工作区确认对话框 ──
            if (state.deletingWs != null) {
                val scope = rememberCoroutineScope()
                AlertDialog(
                    onDismissRequest = { state.deletingWs = null },
                    title = { Text("删除工作区") },
                    text = { Text("删除工作区会将其从列表中移除（目录与数据仍保留在电脑端）。确定删除 ${state.label} 工作区？") },
                    confirmButton = {
                        TextButton(onClick = {
                            val wsId = state.deletingWs
                            state.deletingWs = null
                            if (wsId != null) {
                                scope.launch {
                                    runCatching { onDeleteWs(wsId) }
                                    onWsChanged()   // 刷新树，删除的工作区将消失
                                }
                            }
                        }) { Text("确认删除", color = MaterialTheme.colorScheme.error) }
                    },
                    dismissButton = { TextButton(onClick = { state.deletingWs = null }) { Text("取消") } },
                )
            }
        }
    } else {
        // ── 聊天主视图：顶部常驻信息栏 + 主体对话流 + 底部输入框 ──
        val scope = rememberCoroutineScope()
        BackHandler(onBack = onBack)
        Column(Modifier.fillMaxSize().imePadding().padding(horizontal = 12.dp)) {
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) { Icon(Icons.Outlined.ArrowBack, "返回会话列表") }
                Column(Modifier.weight(1f)) {
                    Text(state.currentTitle ?: "${state.label} 会话", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(listOfNotNull(state.label, state.currentWsTitle).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                var chatMenu by remember { mutableStateOf(false) }
                Box {
                    IconButton(onClick = { chatMenu = true }) { Icon(Icons.Outlined.MoreVert, "会话操作") }
                    DropdownMenu(chatMenu, onDismissRequest = { chatMenu = false }) {
                        DropdownMenuItem(text = { Text("新建会话") }, enabled = state.connected, onClick = { chatMenu = false; onNewSession(null, state.currentWsTitle, null) })
                        DropdownMenuItem(text = { Text("刷新历史") }, enabled = state.connected, onClick = { chatMenu = false; onRetry() })
                    }
                }
            }
            val nativeState = state.worktree.asSequence().flatMap { it.sessions.asSequence() }
                .firstOrNull { it.sessionId == state.currentBackendSessionId }?.state ?: "idle"
            val activityState = when {
                state.pending?.kind == "approval" -> "waiting-approval"
                state.pending?.kind == "question" -> "waiting-question"
                else -> nativeState
            }
            Surface(color = if (state.pending != null) BatonaAmberSurface else MaterialTheme.colorScheme.surface,
                shape = RoundedCornerShape(8.dp), border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
                Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (!state.connected || state.offlineMirror) Text("离线 · 仅浏览", Modifier.weight(1f), color = BatonaAmber, style = MaterialTheme.typography.labelMedium)
                    else SessionStatus(activityState, Modifier.weight(1f))
                    var cancelling by remember { mutableStateOf(false) }
                    TextButton(enabled = state.connected && !state.offlineMirror && state.currentId != null && !cancelling &&
                        activityState in listOf("running", "busy", "streaming", "waiting-approval", "waiting-question"),
                        onClick = {
                            val id = state.currentId ?: return@TextButton
                            cancelling = true
                            scope.launch {
                                try {
                                    val result = client.sessionCancel(id)
                                    if (!result.ok) throw GatewayFailure(result.error?.code ?: "request-failed")
                                } catch (cancelled: CancellationException) { throw cancelled }
                                catch (e: Exception) { state.sessionError = e.message ?: "停止失败，请重试。" }
                                finally { cancelling = false }
                            }
                        }) { Icon(Icons.Outlined.Stop, null, Modifier.size(16.dp)); Text(if (cancelling) "停止中" else "停止") }
                }
            }
            // 历史加载中提示
            if (state.currentId == null && state.sessionError == null) {
                Text("正在加载会话…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp))
            }
            state.sessionError?.let { message ->
                Card(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Column(Modifier.padding(12.dp)) {
                        Text(message, color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = onRetry) { Text("重试加载") }
                    }
                }
            }

            val listState = rememberLazyListState()
            LazyColumn(state = listState, modifier = Modifier.weight(1f).padding(top = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.lines, key = { it.id }) { line -> ChatLineRow(line, state.label) }
                state.pending?.let { p ->
                    item(key = "pending-${p.rpcId}") {
                        Surface(shape = RoundedCornerShape(10.dp), color = BatonaAmberSurface, border = BorderStroke(1.dp, Color(0xFFF0C875))) {
                            Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(Icons.Outlined.Security, null, Modifier.size(20.dp), tint = BatonaAmber)
                                    Text(if (p.kind == "approval") "请求批准" else "需要你的回答", Modifier.padding(start = 8.dp), fontWeight = FontWeight.SemiBold, color = BatonaAmber)
                                }
                                if (p.kind == "approval") {
                                    if (p.toolName.isNotBlank()) Text(p.toolName, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium)
                                    if (p.reason.isNotBlank()) Text(p.reason, style = MaterialTheme.typography.bodyMedium)
                                    val canAnswer = state.connected && !state.offlineMirror && !state.answering
                                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                        OutlinedButton(enabled = canAnswer, shape = RoundedCornerShape(8.dp), modifier = Modifier.weight(1f), onClick = { onAnswer(buildJsonObject { put("outcome", "rejected") }) }) { Text("拒绝") }
                                        Button(enabled = canAnswer, shape = RoundedCornerShape(8.dp), modifier = Modifier.weight(1f), onClick = { onAnswer(buildJsonObject { put("outcome", "allowed-once") }) }) { Text(if (state.answering) "提交中…" else "允许一次") }
                                    }
                                } else QuestionCard(p.questions, onAnswer, enabled = state.connected && !state.offlineMirror && !state.answering)
                            }
                        }
                    }
                }
                item { Spacer(Modifier.height(4.dp)) }
            }
            LaunchedEffect(state.lines.size, state.pending?.rpcId) {
                if (state.lines.isNotEmpty() || state.pending != null) listState.animateScrollToItem((listState.layoutInfo.totalItemsCount - 1).coerceAtLeast(0))
            }

            ConversationControls(state, client)

            // 底部输入框（仅聊天视图）
            if (state.sending) Text("正在电脑端提交…", style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
            ChatComposer(
                input = state.input,
                onInput = { state.input = it },
                enabled = state.connected && state.currentId != null && !state.offlineMirror && !state.busy,
                onSend = {
                    val id = state.currentId ?: return@ChatComposer
                    state.busy = true
                    state.sending = true
                    scope.launch {
                        val prompt = state.input
                        try {
                            val result = client.sessionPrompt(id, prompt,
                                if (state.backend == "codex") null else state.profileBySession[id])
                            if (!result.ok) throw GatewayFailure(result.error?.code ?: "request-failed")
                            if (state.currentId == id) {
                                state.lines.add(ChatLine(System.nanoTime(), "user", prompt))
                                if (state.input == prompt) state.input = ""
                                state.sessionError = null
                            }
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (failure: Exception) {
                            if (state.currentId == id)
                                state.sessionError = if (failure is GatewayFailure) failure.message else "发送失败，输入已保留，请重试。"
                        } finally { state.busy = false; state.sending = false }
                    }
                },
            )
        }
    }
}

/** Compact controls keep the conversation visible; choices only appear on demand. */
@Composable
internal fun ConversationControls(state: HomeState, client: GatewayClient) {
    val scope = rememberCoroutineScope()
    val selectedId = state.currentId?.let { state.profileBySession[it] }
    val selectedProfile = state.profiles.firstOrNull { it.id == selectedId }
    val enabled = state.currentId != null && state.connected && !state.offlineMirror && !state.busy
    val closePermissions: () -> Unit = {
        val sessionId = state.currentId
        state.showProfiles = false
        state.permissionError = null
        if (sessionId != null) scope.launch { runCatching { client.permissionMenu(sessionId, false) } }
    }
    if (state.showProfiles) {
        AlertDialog(
            onDismissRequest = closePermissions,
            title = { Text("Codex · 权限") },
            text = {
                Column(Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState())) {
                    if (state.permissionSyncing) Text("正在同步电脑端权限菜单…")
                    state.permissionError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    state.profiles.forEach { profile ->
                        TextButton(
                            onClick = {
                                val sessionId = state.currentId ?: return@TextButton
                                state.permissionSyncing = true
                                state.permissionError = null
                                scope.launch {
                                    try {
                                        val confirmed = client.permissionSelect(sessionId, profile.id)
                                        if (confirmed.profileId != profile.id) throw GatewayFailure("native-profile-unavailable")
                                        if (state.currentId == sessionId) {
                                            state.profileBySession[sessionId] = profile.id
                                            state.sessionError = null
                                        }
                                        closePermissions()
                                    } catch (cancelled: CancellationException) { throw cancelled }
                                    catch (e: Exception) { state.permissionError = e.message ?: "权限切换失败，请在电脑端确认。" }
                                    finally { state.permissionSyncing = false }
                                }
                            },
                            enabled = enabled && !state.permissionSyncing && profile.available,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(profile.label, fontWeight = FontWeight.Medium)
                                if (profile.description.isNotBlank()) Text(profile.description,
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (selectedId == profile.id) Text("✓", modifier = Modifier.padding(start = 8.dp))
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = closePermissions) { Text("关闭") } },
        )
    }
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (state.backend == "codex") {
            OutlinedButton(
                shape = RoundedCornerShape(8.dp), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp),
                onClick = {
                    val sessionId = state.currentId ?: return@OutlinedButton
                    state.showProfiles = true
                    state.permissionSyncing = true
                    state.permissionError = null
                    scope.launch {
                        try {
                            val current = client.permissionMenu(sessionId, true)
                            if (state.currentId == sessionId && current.profileId != null) state.profileBySession[sessionId] = current.profileId
                            if (!state.showProfiles || state.currentId != sessionId) {
                                runCatching { client.permissionMenu(sessionId, false) }
                            }
                        } catch (cancelled: CancellationException) { throw cancelled }
                        catch (e: Exception) { state.permissionError = e.message ?: "电脑端权限菜单未能打开。" }
                        finally { state.permissionSyncing = false }
                    }
                },
                enabled = enabled && state.profiles.isNotEmpty(),
                modifier = Modifier.weight(1f).semantics { contentDescription = "选择权限" },
            ) {
                val tint = if (selectedId == "full-access") Color(0xFFE87932) else MaterialTheme.colorScheme.primary
                Icon(Icons.Filled.Security, null, Modifier.size(16.dp), tint = if (enabled) tint else MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(6.dp))
                Text(selectedProfile?.label ?: "跟随电脑端", maxLines = 1, overflow = TextOverflow.Ellipsis,
                    color = if (enabled) tint else MaterialTheme.colorScheme.onSurfaceVariant)
                Icon(Icons.Filled.ArrowDropDown, null, Modifier.size(16.dp))
            }
        } else Spacer(Modifier.weight(1f))
        OutlinedButton(
            shape = RoundedCornerShape(8.dp), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp),
            onClick = { state.showModels = true }, enabled = enabled,
            modifier = Modifier.weight(1f).semantics { contentDescription = "选择模型" },
        ) {
            Icon(Icons.Filled.Memory, null, Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            val model = state.selectedModel
            val displayModel = model?.displayName ?: state.models.firstOrNull { it.provider == model?.provider && it.model == model.model }?.displayName ?: model?.model
            Text(displayModel ?: "模型未同步",
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Icon(Icons.Filled.ArrowDropDown, null, Modifier.size(16.dp))
        }
    }
    if (state.backend == "codex") {
        OutlinedButton(
            onClick = { state.showEfforts = true },
            enabled = enabled && state.selectedModel != null,
            shape = RoundedCornerShape(8.dp),
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp).semantics { contentDescription = "选择思考强度" },
        ) {
            Text("思考强度 · ${effortLabel(state.selectedModel?.reasoningEffort)}")
            Spacer(Modifier.width(4.dp))
            Icon(Icons.Filled.ArrowDropDown, null, Modifier.size(16.dp))
        }
    }
}

@Composable
private fun ChatLineRow(line: ChatLine, backendLabel: String) {
    val bg = when (line.kind) {
        "user" -> MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
        "tool" -> MaterialTheme.colorScheme.surface
        "system", "done" -> Color.Transparent
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    val color = when (line.kind) {
        "system", "done" -> MaterialTheme.colorScheme.onSurfaceVariant
        else -> MaterialTheme.colorScheme.onSurface
    }
    // 折叠配色：思考过程默认收起，点击展开
    var showThinking by remember(line.id) { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth().padding(vertical = 3.dp), contentAlignment = if (line.kind == "user") Alignment.CenterEnd else Alignment.CenterStart) {
        Column(Modifier.widthIn(max = if (line.kind == "user") 320.dp else 600.dp), horizontalAlignment = if (line.kind == "user") Alignment.End else Alignment.Start) {
            if (line.kind == "assistant") {
                Row(Modifier.padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Terminal, null, Modifier.size(18.dp))
                    Text(backendLabel, Modifier.padding(start = 8.dp), style = MaterialTheme.typography.labelMedium)
                }
            }
            // 思考过程（assistant 且有 reasoning）：可折叠
            if (line.kind == "assistant" && line.reasoning.isNotBlank()) {
                Surface(
                    modifier = Modifier.padding(bottom = 4.dp).clickable { showThinking = !showThinking },
                    color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
                    shape = RoundedCornerShape(6.dp),
                ) {
                    Row(
                        Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(if (showThinking) "▾" else "▸", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(" 思考过程", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (showThinking) {
                    SelectionContainer {
                        Text(
                            markdownToAnnotated(line.reasoning),
                            modifier = Modifier.padding(start = 8.dp, end = 8.dp, bottom = 4.dp),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            // 正文（assistant/user 走轻量 Markdown 渲染，消除 * / # 等外露）
            if (line.kind == "assistant" || line.kind == "user") {
                if (line.text.isNotBlank()) {   // 空正文不渲染气泡，避免"思考过程"下出现空文本栏
                    SelectionContainer {
                        Text(
                            markdownToAnnotated(line.text),
                            color = color,
                            modifier = Modifier.background(bg, RoundedCornerShape(10.dp)).padding(10.dp),
                            style = MaterialTheme.typography.bodyLarge,   // 加大正文字号
                        )
                    }
                }
            } else if (line.kind == "tool") {
                var expanded by remember(line.id) { mutableStateOf(false) }
                Surface(color = MaterialTheme.colorScheme.surface, shape = RoundedCornerShape(10.dp),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                    modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded }) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.Description, null, Modifier.size(20.dp))
                            Text(line.toolName.ifBlank { "工具调用" }, Modifier.weight(1f).padding(horizontal = 8.dp),
                                fontWeight = FontWeight.Medium, style = MaterialTheme.typography.bodyMedium)
                            Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, if (expanded) "收起工具详情" else "展开工具详情", Modifier.size(18.dp))
                        }
                        Text(line.text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = if (expanded) Int.MAX_VALUE else 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            } else {
                Text(
                    text = when (line.kind) {
                        "tool" -> "🔧 ${line.toolName}${if (line.text.isNotEmpty()) "\n${line.text}" else ""}"
                        "system", "done" -> "— ${line.text} —"
                        else -> line.text
                    },
                    color = color,
                    modifier = Modifier.background(bg, RoundedCornerShape(10.dp)).padding(10.dp),
                    fontFamily = if (line.kind == "tool") FontFamily.Monospace else null,
                    style = if (line.kind == "system" || line.kind == "done") MaterialTheme.typography.bodySmall else MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

/**
 * 创建工作区弹窗：顶部路径输入框 + 下方目录树（常驻，不分视图切换）。
 * 点目录进入下级并把该目录填入输入框；「↑ 上级」返回；「创建」用输入框路径创建。
 */
@Composable
private fun NewWorkspaceDialog(state: HomeState, client: GatewayClient, onDismiss: () -> Unit, onCreate: (String) -> Unit) {
    val scope = rememberCoroutineScope()

    fun load(p: String, pick: Boolean) {
        state.dirLoading = true
        scope.launch {
            val d = client.dirList(p)
            state.dirPath = d.path
            if (d.roots != null) state.dirRoots = d.roots
            if (d.dirs != null) { state.dirEntries = d.dirs; state.dirRoots = emptyList() }
            if (pick) state.wsPath = d.path   // 进入目录时同步到路径输入框
            state.dirLoading = false
        }
    }
    // 打开弹窗：重置目录浏览到盘符根
    LaunchedEffect(Unit) { state.dirPath = ""; state.dirEntries = emptyList(); state.dirRoots = emptyList(); load("", pick = false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("创建工作区") },
        text = {
            Column {
                // 顶部：路径输入框（贴顶）
                OutlinedTextField(
                    state.wsPath, { state.wsPath = it },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("如 D:\\_Projects\\26-009DSHplugin") },
                    singleLine = true,
                )
                // 下方：目录树
                Spacer(Modifier.height(8.dp))
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    if (state.dirPath.isNotEmpty()) {
                        TextButton(onClick = { load(parentOf(state.dirPath), pick = true) }, enabled = !state.dirLoading) { Text("↑ 上级") }
                    }
                    Text(
                        state.dirPath.ifEmpty { "选择盘符" },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f).padding(start = 6.dp),
                    )
                }
                if (state.dirLoading) {
                    // 固定高度占位，避免加载时弹窗伸缩抖动
                    Box(Modifier.fillMaxWidth().height(240.dp), contentAlignment = Alignment.Center) {
                        Text("加载中…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                } else {
                    val items = if (state.dirRoots.isNotEmpty()) state.dirRoots else state.dirEntries
                    LazyColumn(Modifier.fillMaxWidth().height(240.dp)) {
                        items(items) { name ->
                            val full = if (state.dirRoots.isNotEmpty()) name else joinPath(state.dirPath, name)
                            Row(
                                Modifier.fillMaxWidth().clickable { if (!state.dirLoading) load(full, pick = true) }
                                    .padding(vertical = 8.dp, horizontal = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text("📁 $name", style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                val p = state.wsPath.trim()
                if (p.isNotEmpty()) { onCreate(p); onDismiss() }
            }, enabled = state.wsPath.trim().isNotEmpty() && !state.dirLoading) { Text("创建") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

/**
 * 目录浏览辅助：列盘符根/子目录路径处理（见 parentOf/joinPath）。
 */
private fun parentOf(p: String): String {
    // Windows 路径：去掉最后一段，返回上级目录。
    //   D:\a\b → D:\a；D:\a → D:\；D:\（本身）→ ""（回到盘符列表）
    if (p.isEmpty()) return ""
    val trimmed = p.trimEnd('\\', '/')          // 去掉尾部反斜杠（如 "D:\a\" → "D:\a"）
    if (trimmed.isEmpty()) return ""
    val idx = trimmed.lastIndexOf('\\')
    if (idx < 0) return ""                       // 无分隔符（如 "D:"）→ 盘符根，回列表
    val parent = trimmed.substring(0, idx)       // 去掉最后一段，剩下前缀
    // 若前缀形如盘符（"D:"），补 "\\" 成 "D:\"（D 盘界面），而不是回盘符列表
    return if (parent.length == 2 && parent[1] == ':') "$parent\\" else parent
}

private fun joinPath(base: String, name: String): String {
    return when {
        base.isEmpty() -> name
        name.startsWith("\\") || name.startsWith("/") -> "$base$name"
        base.endsWith("\\") || base.endsWith("/") -> "$base$name"
        else -> "$base\\$name"
    }
}

/** 提问卡片：一次完整回填 Codex/DSH 请求中的全部问题，不把密文答案显示为明文。 */
@Composable
private fun QuestionCard(questions: List<QuestionItem>, onAnswer: (kotlinx.serialization.json.JsonObject) -> Unit, enabled: Boolean = true) {
    val key = questions.joinToString("|") { it.id }
    val selected = remember(key) { mutableStateMapOf<String, String>() }
    val custom = remember(key) { mutableStateMapOf<String, String>() }

    Column {
        questions.ifEmpty { listOf(QuestionItem("answer", "text", "问题")) }.forEachIndexed { questionIndex, q ->
            val opts = q.options ?: emptyList()
            Text(if (questions.size > 1) "${questionIndex + 1}. ${q.prompt}" else q.prompt, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = if (questionIndex == 0) 0.dp else 12.dp))
            // 选项编号列表
            opts.forEachIndexed { optionIndex, opt ->
                val isSel = selected[q.id] == opt.id
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 6.dp)
                        .background(if (isSel) MaterialTheme.colorScheme.primary.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f), RoundedCornerShape(10.dp))
                        .clickable { selected[q.id] = opt.id }.padding(10.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Text("${optionIndex + 1}", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(end = 6.dp))
                    Column(Modifier.weight(1f)) {
                        Text(opt.label, style = MaterialTheme.typography.bodyMedium)
                        if (!opt.description.isNullOrBlank()) {
                            Text(opt.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (isSel) Text("已选", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
            // 选项与文本都允许；Codex 的 isOther 与 DSH 的开放题都走此输入框。
            OutlinedTextField(
                custom[q.id].orEmpty(), { custom[q.id] = it },
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                placeholder = { Text(q.placeholder ?: "输入你的答案…") },
                singleLine = true,
                visualTransformation = if (q.isSecret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
            )
        }
        // 跳过 / 提交
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(enabled = enabled, onClick = { onAnswer(buildJsonObject { put("skip", true) }) }, modifier = Modifier.weight(1f)) { Text("跳过") }
            Button(onClick = {
                onAnswer(buildJsonObject {
                    put("answers", buildJsonArray {
                        questions.ifEmpty { listOf(QuestionItem("answer", "text", "问题")) }.forEach { q ->
                            add(buildJsonObject {
                                put("id", q.id)
                                put("selected", buildJsonArray { selected[q.id]?.let { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
                                custom[q.id]?.takeIf { it.isNotBlank() }?.let { put("custom", it) }
                            })
                        }
                    })
                })
            }, enabled = enabled && questions.ifEmpty { listOf(QuestionItem("answer", "text", "问题")) }.all { selected[it.id] != null || !custom[it.id].isNullOrBlank() }, modifier = Modifier.weight(1f)) { Text("提交") }
        }
    }
}

@Composable
private fun ChatComposer(input: String, onInput: (String) -> Unit, enabled: Boolean, onSend: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 8.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(input, onInput, modifier = Modifier.weight(1f), placeholder = { Text("补充你的要求…") },
            shape = RoundedCornerShape(12.dp), minLines = 1, maxLines = 4,
            colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(
                unfocusedContainerColor = MaterialTheme.colorScheme.surface,
                focusedContainerColor = MaterialTheme.colorScheme.surface,
                unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant))
        androidx.compose.material3.FilledIconButton(onClick = onSend, enabled = enabled && input.isNotBlank(),
            modifier = Modifier.padding(bottom = 4.dp).size(48.dp)) {
            Icon(Icons.Outlined.ArrowUpward, "发送")
        }
    }
}

@Composable
private fun ModelsTab(state: HomeState, onSelect: (ModelRef) -> Unit) {
    Column(Modifier.fillMaxWidth().heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
        Text("模型目录（应用于当前会话）", style = MaterialTheme.typography.titleSmall)
        if (state.models.isEmpty()) Text("暂未获取到模型，请确认电脑端 ${state.label} 可用后重试。", modifier = Modifier.padding(top = 12.dp))
        state.models.distinctBy { it.provider to it.model }.forEach { m ->
            val variants = state.models.filter { it.provider == m.provider && it.model == m.model }
            val selectedEffort = state.selectedModel?.takeIf { it.model == m.model }?.reasoningEffort
            val choice = variants.firstOrNull { it.reasoningEffort == selectedEffort }
                ?: variants.firstOrNull { it.reasoningEffort == "medium" } ?: m
            Card(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(m.displayName ?: m.model)
                        Text("${m.provider} / ${m.model}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    TextButton(onClick = { onSelect(choice) }, enabled = state.connected && !state.offlineMirror && !state.busy) {
                        Text(if (state.selectedModel?.model == m.model) "已选" else "应用")
                    }
                }
            }
        }
    }
}

@Composable
private fun EffortsTab(state: HomeState, onSelect: (ModelRef) -> Unit) {
    val selected = state.selectedModel
    val variants = state.models.filter { it.provider == selected?.provider && it.model == selected?.model && it.reasoningEffort != null }
    Column(Modifier.fillMaxWidth().heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
        if (selected == null || variants.isEmpty()) {
            Text("请先选择支持思考强度的模型。")
        } else variants.forEach { option ->
            TextButton(
                onClick = { onSelect(option) },
                enabled = state.connected && !state.offlineMirror && !state.busy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(effortLabel(option.reasoningEffort), modifier = Modifier.weight(1f))
                if (option.reasoningEffort == selected.reasoningEffort) Text("✓")
            }
        }
    }
}

private fun effortLabel(value: String?): String = when (value) {
    "low" -> "低"
    "medium" -> "中"
    "high" -> "高"
    "xhigh" -> "极高"
    "max" -> "最高"
    "ultra" -> "超强"
    else -> value ?: "未同步"
}

@Composable
private fun SettingsTab(binding: Binding, state: HomeState, onLogout: () -> Unit) {
    var confirmLogout by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("设置", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Surface(shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
            Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("连接信息", fontWeight = FontWeight.SemiBold)
                Text("服务器：${binding.serverIp}", style = MaterialTheme.typography.bodyMedium)
                Text("连接：${if (state.connected) "在线" else "离线"}", color = if (state.connected) BatonaGreen else BatonaAmber)
                Text("传输：HTTPS / WSS", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Surface(shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
            Column(Modifier.fillMaxWidth().padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Batona Mobile", fontWeight = FontWeight.SemiBold)
                Text("当前版本：${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("任务在电脑执行，手机同步工作区与会话。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        OutlinedButton(onClick = { confirmLogout = true }, modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("退出登录") }
    }
    if (confirmLogout) AlertDialog(onDismissRequest = { confirmLogout = false }, title = { Text("退出登录？") },
        text = { Text("退出后需重新配对，本机缓存将清除。电脑上的任务会继续运行。") },
        confirmButton = { TextButton(onClick = { confirmLogout = false; onLogout() }) { Text("退出登录") } },
        dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text("取消") } })
}

// ── 工具 ──────────────────────────────────────────────────────────────

/**
 * 轻量 Markdown → AnnotatedString（自研方案）。
 * 覆盖：标题 #、列表 -/数字、加粗 **x**、斜体 *x*、行内代码 `x`、fenced 代码块 ```...```。
 * 关键：逐行 + 行内 token 解析，跳过定界符字符（* ` # - 数字.），把内容真正写入，
 * 从而消除符号在手机端外露。未覆盖语法（表格/嵌套等）原样保留文本。
 */
private fun markdownToAnnotated(text: String): AnnotatedString {
    return buildAnnotatedString {
        var i = 0
        val n = text.length
        while (i < n) {
            val c = text[i]
            // fenced 代码块 ``` ... ```
            if (c == '`' && text.startsWith("```", i)) {
                val close = text.indexOf("```", i + 3)
                if (close >= 0) {
                    var bodyStart = i + 3
                    if (bodyStart < n && text[bodyStart] == '\r') bodyStart++
                    if (bodyStart < n && text[bodyStart] == '\n') bodyStart++
                    val body = text.substring(bodyStart, close).trimEnd('\n')
                    withStyle(codeStyle()) { append(body) }
                    if (close + 3 < n && text[close + 3] == '\n') append('\n')
                    i = close + 3
                    continue
                }
            }
            // 非代码块：按行处理（标题/列表/行内）
            val lineEnd = text.indexOf('\n', i).let { if (it < 0) n else it }
            val line = text.substring(i, lineEnd)
            if (!line.startsWith("```")) renderLine(line)
            if (lineEnd < n) append('\n')
            i = lineEnd + 1
        }
    }
}

/** 单行渲染：标题 / 列表 / 普通行（行内 token 解析） */
private fun androidx.compose.ui.text.AnnotatedString.Builder.renderLine(line: String) {
    // 标题：# / ## / ### ...
    val header = Regex("^(#{1,6})\\s+").find(line)
    if (header != null) {
        val level = header.value.trim().count { it == '#' }
        withStyle(SpanStyle(fontWeight = FontWeight.Bold, fontSize = articleHeaderSize(level))) {
            appendInline(line.substring(header.value.length))
        }
        return
    }
    // 无序列表：- / * / +
    val ul = Regex("^\\s*[-*+]\\s+").find(line)
    if (ul != null) { appendInline(line.substring(ul.value.length)); return }
    // 有序列表：数字.
    val ol = Regex("^\\s*\\d+\\.\\s+").find(line)
    if (ol != null) { appendInline(line.substring(ol.value.length)); return }
    // 普通行
    appendInline(line)
}

/** 行内 token 解析：加粗/斜体/行内代码/其余 */
private fun androidx.compose.ui.text.AnnotatedString.Builder.appendInline(line: String) {
    var i = 0
    val n = line.length
    while (i < n) {
        val c = line[i]
        // 行内代码 `x`
        if (c == '`') {
            val close = line.indexOf('`', i + 1)
            if (close > i + 1) {
                withStyle(codeStyle()) { append(line.substring(i + 1, close)) }
                i = close + 1
                continue
            }
        }
        // 加粗 **x**
        if (c == '*' && line.startsWith("**", i)) {
            val close = line.indexOf("**", i + 2)
            if (close > i + 2) {
                withStyle(SpanStyle(fontWeight = FontWeight.Black)) { append(line.substring(i + 2, close)) }
                i = close + 2
                continue
            }
        }
        // 斜体 *x*
        if (c == '*') {
            val close = line.indexOf('*', i + 1)
            if (close > i + 1) {
                withStyle(SpanStyle(fontStyle = androidx.compose.ui.text.font.FontStyle.Italic)) { append(line.substring(i + 1, close)) }
                i = close + 1
                continue
            }
        }
        append(c)
        i++
    }
}

private fun articleHeaderSize(level: Int): androidx.compose.ui.unit.TextUnit {
    // 标题越大字号越大（H1~H6）
    val base = 18
    return androidx.compose.ui.unit.TextUnit((base - (level - 1)).coerceAtLeast(13).toFloat(), androidx.compose.ui.unit.TextUnitType.Sp)
}

private fun codeStyle(): SpanStyle = SpanStyle(fontFamily = FontFamily.Monospace, background = Color(0x22000000))

private fun kindOf(ev: AgentEvent): String = when (ev.type) {
    "user/message" -> "user"
    "assistant/message", "assistant/chunk" -> "assistant"
    "tool/call", "tool/result" -> "tool"
    "done", "turn/end" -> "done"
    else -> "system"
}

/** 会话最新刷新时间格式化（毫秒时间戳 → 时分） */
private fun formatTime(ms: Long): String {
    if (ms <= 0) return ""
    val fmt = java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault())
    return fmt.format(java.util.Date(ms))
}

/** 会话状态点颜色：等待用户回复(未提交)→黄(不受已读影响)；未读且done→绿；已读或done→灰 */
private fun stateDotColor(state: String, read: Boolean = false): Color = when {
    // 等待用户回复：在用户真正提交/应答前始终亮黄，不受"已读"影响
    state == "waiting-question" || state == "waiting-approval" -> Color(0xFFE67E22)   // 黄
    read -> Color(0xFF8B93A3)                       // 已读(仅对 done 绿点) → 灰
    state == "done" -> Color(0xFF2ECC71)            // 未读完成 → 绿
    else -> Color(0xFF8B93A3)                       // 其他 → 灰
}

private fun textOf(ev: AgentEvent): String = when (ev.type) {
    "assistant/chunk" -> ev.text ?: ""
    "tool/call" -> "调用 ${ev.toolName}${ev.args?.toString()?.let { "\n$it" } ?: ""}"
    "tool/result" -> if (ev.ok == true) "OK ${ev.summary ?: ""}" else "ERR ${ev.message ?: ev.summary ?: ""}"
    "done", "turn/end" -> "回合完成"
    "session/title" -> "标题：${ev.title}"
    else -> ev.text ?: ev.type
}
