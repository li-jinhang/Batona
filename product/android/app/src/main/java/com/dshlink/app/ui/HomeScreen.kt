package com.dshlink.app.ui

import androidx.compose.foundation.background
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
import androidx.compose.material.icons.filled.Devices
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
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.dshlink.app.BuildConfig
import com.dshlink.app.data.AgentEvent
import com.dshlink.app.data.Binding
import com.dshlink.app.data.DeviceInfo
import com.dshlink.app.data.GatewayClient
import com.dshlink.app.data.GatewaySession
import com.dshlink.app.data.ModelRef
import com.dshlink.app.data.QuestionItem
import com.dshlink.app.data.ServerRequest
import com.dshlink.app.data.SessionNode
import com.dshlink.app.data.WorkspaceNode
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

private val json = Json { ignoreUnknownKeys = true }

private data class ChatLine(val id: Long, val kind: String, val text: String = "", val toolName: String = "", val reasoning: String = "")

private data class PendingFrame(
    val kind: String, val rpcId: String, val toolName: String = "",
    val reason: String = "", val questions: List<QuestionItem> = emptyList(),
)

private class HomeState {
    val worktree = mutableStateListOf<WorkspaceNode>()
    val expanded = mutableStateMapOf<String, Boolean>()
    val lines = mutableStateListOf<ChatLine>()
    val models = mutableStateListOf<ModelRef>()
    val devices = mutableStateListOf<DeviceInfo>()

    var currentId by mutableStateOf<String?>(null)          // gatewaySession.id（聊天视图）
    var currentTitle by mutableStateOf<String?>(null)        // 聊天顶部：会话标题
    var currentWsTitle by mutableStateOf<String?>(null)      // 聊天顶部：所属工作区名
    var entering by mutableStateOf(false)                    // 正在进入会话（切视图 + 加载历史）
    var pending by mutableStateOf<PendingFrame?>(null)
    var connected by mutableStateOf(false)
    // 已读会话（DSH sessionId 集）：点进会话后取消"未读绿点"
    val readSessions = mutableStateListOf<String>()
    var input by mutableStateOf("")
    var busy by mutableStateOf(false)
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
    private var streamingAsst = false              // 最后一条是否正被 assistant/chunk 流式累积

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
            "tool/call", "tool/result" -> { streamingAsst = false; /* 隐藏工具调用/返回信息，不显示在对话记录 */ }
            "session/title" -> lines.add(ChatLine(System.nanoTime(), "system", "标题：${ev.title}"))
            // 骨架事件（turn/start·turn/end·step/start·step/end·done）不显示：只重置流式标记，避免噪音行（如"- turn/start -"）
            else -> { streamingAsst = false; /* 忽略骨架事件 */ }
        }
    }

    fun handlePush(frame: ServerRequest) {
        try {
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
                    // 只渲染当前会话的事件，避免其他会话消息混入
                    if (sid == null || currentId == null || sid != currentId) return
                    android.util.Log.w("DSHLINK", "push session/event sid=$sid cur=$currentId type=${ev.type}")
                    appendEvent(ev)
                }
                "approval/requested" -> {
                    val o = frame.payload.jsonObject
                    val sid = o["sessionId"]?.jsonPrimitive?.content
                    if (sid == null || currentId == null || sid != currentId) return
                    pending = PendingFrame("approval", frame.rpcId,
                        o["toolName"]?.jsonPrimitive?.content ?: "",
                        o["reason"]?.jsonPrimitive?.content ?: "")
                    lines.add(ChatLine(System.nanoTime(), "system", "⚠️ 等待审批：${pending?.toolName}"))
                }
                "question/requested" -> {
                    val o = frame.payload.jsonObject
                    val sid = o["sessionId"]?.jsonPrimitive?.content
                    android.util.Log.w("DSHLINK", "push question sid=$sid cur=$currentId rpc=${frame.rpcId} qs=${o["questions"]?.toString()?.take(80)}")
                    if (sid == null || currentId == null || sid != currentId) { android.util.Log.w("DSHLINK", "question SKIPPED (not current)"); return }
                    val qs = o["questions"]?.let {
                        json.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(QuestionItem.serializer()), it)
                    } ?: emptyList()
                    pending = PendingFrame("question", frame.rpcId, questions = qs)
                    lines.add(ChatLine(System.nanoTime(), "system", "❓ ${qs.firstOrNull()?.prompt ?: "问题"}"))
                }
            }
        } catch (_: Exception) { /* 忽略畸形帧 */ }
    }
}

@Composable
fun HomeScreen(binding: Binding, token: String, onLogout: () -> Unit) {
    val scope = rememberCoroutineScope()
    val state = remember { HomeState() }
    var tab by remember { mutableIntStateOf(0) }

    val client = remember(binding, token) {
        GatewayClient(
            binding,
            onPush = { state.handlePush(it) },
            onConnChange = { state.connected = it },
            onAuthFailed = { onLogout() },
        ).apply { this.token = token }
    }

    DisposableEffect(client) { client.connect(); onDispose { client.disconnect() } }

    // 等 WebSocket 连上后再加载工作区树与初始化（避免启动瞬间 WS 未就绪导致空）
    LaunchedEffect(state.connected) {
        android.util.Log.w("DSHLINK", "connectedEffect fired connected=${state.connected}")
        if (!state.connected) return@LaunchedEffect
        runCatching {
            state.worktree.clear()
            state.worktree.addAll(client.workspaceTree())
            android.util.Log.w("DSHLINK", "worktree loaded size=${state.worktree.size}")
            state.models.clear(); state.models.addAll(client.modelList())
            state.devices.clear(); state.devices.addAll(client.deviceList())
            state.worktree.firstOrNull()?.let { state.expanded[it.workspace.workspaceId] = true }
        }
    }

    fun refreshTree() = scope.launch {
        runCatching {
            val saved = state.worktree.map { it.workspace.workspaceId }.toSet()
            state.worktree.clear()
            state.worktree.addAll(client.workspaceTree())
            state.worktree.forEach { if (saved.contains(it.workspace.workspaceId)) state.expanded[it.workspace.workspaceId] = true }
        }
    }
    // session/title 事件到达时刷新工作区树（网关已有标题缓存，拉取即得最新标题）
    state.onTitleChanged = { refreshTree() }

    // 当前会话历史（聊天会话变化时加载）
    LaunchedEffect(state.currentId) {
        runCatching {
            val id = state.currentId ?: return@LaunchedEffect
            state.lines.clear()
            val history = client.sessionHistory(id)
            android.util.Log.w("DSHLINK", "history sid=$id size=${history.size} first=${history.firstOrNull()?.type}")
            state.lines.addAll(history
                .filterNot { it.type == "tool/call" || it.type == "tool/result" }   // 隐藏工具调用/返回信息
                .map { ev -> ChatLine(System.nanoTime(), kindOf(ev), textOf(ev), ev.toolName ?: "", reasoning = ev.reasoning ?: "") })
            state.lines.add(ChatLine(System.nanoTime(), "system", "已连接到会话"))
        }
    }

    Scaffold(
        bottomBar = {
            NavigationBar {
                NavigationBarItem(selected = tab == 0, onClick = { tab = 0 }, icon = { Icon(Icons.Filled.Chat, null) }, label = { Text("会话") })
                NavigationBarItem(selected = tab == 1, onClick = { tab = 1 }, icon = { Icon(Icons.Filled.Memory, null) }, label = { Text("模型") })
                NavigationBarItem(selected = tab == 2, onClick = { tab = 2 }, icon = { Icon(Icons.Filled.Devices, null) }, label = { Text("设备") })
                NavigationBarItem(selected = tab == 3, onClick = { tab = 3 }, icon = { Icon(Icons.Filled.Settings, null) }, label = { Text("设置") })
            }
        },
    ) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
            when (tab) {
                0 -> ChatTab(state, client,
                    onSelectSession = { sessionId, wsTitle ->
                        // 立即切入聊天视图（loading），历史异步加载，避免等网关往返
                        state.entering = true
                        state.currentWsTitle = wsTitle
                        state.lines.clear()
                        state.pending = null   // 切换会话：清掉上一会话的提问/审批
                        state.readSessions.add(sessionId)   // 标记已读：取消未读绿点
                        scope.launch {
                            val gs = client.resumeSession("dsh", sessionId)
                            if (gs != null) { state.currentId = gs.id; state.currentTitle = gs.title }
                            state.entering = false
                        }
                    },
                    onBack = { state.currentId = null; state.entering = false; state.lines.clear(); state.pending = null },
                    onToggle = { wsId -> state.expanded[wsId] = !(state.expanded[wsId] ?: false) },
                    onNewSession = { wsId, wsTitle ->
                        state.entering = true
                        state.currentWsTitle = wsTitle
                        state.lines.clear()
                        state.pending = null   // 新建会话：清上一会话提问/审批
                        scope.launch {
                            val gs = client.sessionCreate("dsh", "新会话", wsId)
                            if (gs != null) { state.currentId = gs.id; state.currentTitle = gs.title }
                            state.entering = false
                            refreshTree()
                        }
                    },
                    onDeleteWs = { wsId -> scope.launch { client.workspaceDelete(wsId); refreshTree() } },
                    onArchive = { sid -> scope.launch { client.archiveSession(sid); refreshTree() } },
                    onNewWorkspace = { path ->
                        scope.launch { client.workspaceCreate(path); state.wsPath = ""; state.showNewWs = false; refreshTree() }
                    },
                    onAnswer = { payload ->
                        val p = state.pending ?: return@ChatTab
                        scope.launch { client.respond(state.currentId ?: "", p.rpcId, payload); state.pending = null }
                    },
                    onWsChanged = { refreshTree() },
                )
                1 -> ModelsTab(state, onSelect = { m -> scope.launch { state.currentId?.let { client.modelSelect(it, m) } } })
                2 -> DevicesTab(state, onRevoke = { d -> scope.launch { client.deviceRevoke(d.deviceId); state.devices.clear(); state.devices.addAll(client.deviceList()) } })
                3 -> SettingsTab(binding, state, onLogout)
            }
        }
    }
}

// ── 会话 Tab：工作区树 + 聊天 ─────────────────────────────────────────
@Composable
private fun ChatTab(
    state: HomeState,
    client: GatewayClient,
    onSelectSession: (sessionId: String, wsTitle: String) -> Unit,
    onBack: () -> Unit,
    onToggle: (String) -> Unit,
    onNewSession: (wsId: String?, wsTitle: String?) -> Unit,
    onDeleteWs: (String) -> Unit,
    onArchive: (String) -> Unit,
    onNewWorkspace: (String) -> Unit,
    onAnswer: (kotlinx.serialization.json.JsonObject) -> Unit,
    onWsChanged: () -> Unit,
) {
    // 列表视图：未选会话且非进入中；否则聊天主视图
    if (state.currentId == null && !state.entering) {
        // ── 会话列表视图：工作区树占满（可上下滑动）──
        Column(Modifier.fillMaxSize().padding(12.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { onNewSession(null, null) }) { Text("新建会话") }
                OutlinedButton(onClick = onWsChanged) { Text("刷新") }
                OutlinedButton(onClick = { state.showNewWs = true }) { Text("新工作区") }
            }
            // 创建工作区弹窗：路径输入 + 目录浏览 + 创建 都在弹窗内
            if (state.showNewWs) {
                NewWorkspaceDialog(
                    state = state,
                    client = client,
                    onDismiss = { state.showNewWs = false },
                    onCreate = onNewWorkspace,
                )
            }
            val treeState = rememberLazyListState()
            // 工作区/会话多时可上下滑动
            LazyColumn(state = treeState, modifier = Modifier.weight(1f).padding(top = 8.dp)) {
                items(state.worktree, key = { it.workspace.workspaceId }) { node ->
                    val wsId = node.workspace.workspaceId
                    val open = state.expanded[wsId] ?: false
                    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)).padding(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        IconButton(onClick = { onToggle(wsId) }) { Icon(if (open) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, contentDescription = "展开", tint = MaterialTheme.colorScheme.onSurfaceVariant) }
                        Column(Modifier.weight(1f)) {
                            Text("📁 ${node.workspace.title}", style = MaterialTheme.typography.bodyMedium)
                            Text("${node.sessions.size} 个会话", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        TextButton(onClick = { onNewSession(wsId, node.workspace.title) }) { Text("+会话") }
                        TextButton(onClick = { state.deletingWs = wsId }) { Text("删除", color = MaterialTheme.colorScheme.error) }
                    }
                    if (open) {
                        node.sessions.forEach { sNode ->
                            Row(Modifier.fillMaxWidth().padding(start = 28.dp).padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f).clickable { onSelectSession(sNode.sessionId, node.workspace.title) }) {
                                    Text(sNode.title ?: sNode.sessionId, style = MaterialTheme.typography.bodyMedium)
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        // 状态点：未读且 done 绿 / 未读且等回复 黄 / 已读或其他 灰
                                        Box(Modifier.size(8.dp).background(stateDotColor(sNode.state, state.readSessions.contains(sNode.sessionId)), CircleShape))
                                        Spacer(Modifier.width(5.dp))
                                        Text(
                                            formatTime(sNode.updatedAt),
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                                TextButton(onClick = {
                                    state.renaming = sNode.sessionId
                                    state.renameText = sNode.title ?: sNode.sessionId
                                }) { Text("改名", color = MaterialTheme.colorScheme.onSurfaceVariant) }
                                TextButton(onClick = { state.archiving = sNode.sessionId }) { Text("归档", color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            }
                        }
                    }
                }
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
                                    runCatching { client.sessionRename(sid, title) }
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
                    text = { Text("归档后该会话将从工作区隐藏（笔记本端仍保留，可在 DSH 侧找回）。确定归档？") },
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
                    text = { Text("删除工作区会将其从列表中移除（目录与数据仍保留在笔记本端，可在 DSH 侧找回）。确定删除？") },
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
        Column(Modifier.fillMaxSize().padding(12.dp)) {
            Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)).padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onBack) { Text("←", style = MaterialTheme.typography.titleMedium) }
                Column(Modifier.weight(1f)) {
                    (state.currentWsTitle ?: "").takeIf { it.isNotBlank() }?.let {
                        Text("📁 $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(state.currentTitle ?: "会话", style = MaterialTheme.typography.bodyMedium)
                }
                TextButton(onClick = { onNewSession(null, state.currentWsTitle) }) { Text("+会话") }
            }

            // 历史加载中提示
            if (state.currentId == null) {
                Text("正在加载会话…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp))
            }

            val listState = rememberLazyListState()
            LazyColumn(state = listState, modifier = Modifier.weight(1f).padding(top = 8.dp)) {
                items(state.lines) { line -> ChatLineRow(line) }
            }
            LaunchedEffect(state.lines.size) { if (state.lines.isNotEmpty()) listState.scrollToItem(state.lines.size - 1) }

            state.pending?.let { p ->
                Card(Modifier.fillMaxWidth().padding(top = 6.dp)) {
                    Column(Modifier.padding(10.dp)) {
                        if (p.kind == "approval") {
                            Text("⚠️ 审批：${p.toolName}${if (p.reason.isNotEmpty()) "\n${p.reason}" else ""}", style = MaterialTheme.typography.bodySmall)
                            Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(onClick = { onAnswer(buildJsonObject { put("outcome", "allowed-once") }) }) { Text("允许一次") }
                                OutlinedButton(onClick = { onAnswer(buildJsonObject { put("outcome", "rejected") }) }) { Text("拒绝") }
                            }
                        } else {
                            val q = p.questions.firstOrNull()
                            QuestionCard(q, onAnswer)
                        }
                    }
                }
            }

            // 底部输入框（仅聊天视图）
            ChatComposer(
                input = state.input,
                onInput = { state.input = it },
                enabled = state.currentId != null && !state.busy,
                onSend = {
                    val id = state.currentId ?: return@ChatComposer
                    state.busy = true
                    scope.launch {
                        state.lines.add(ChatLine(System.nanoTime(), "user", state.input))
                        client.sessionPrompt(id, state.input)
                        state.input = ""
                        state.busy = false
                    }
                },
            )
        }
    }
}

@Composable
private fun ChatLineRow(line: ChatLine) {
    val bg = when (line.kind) {
        "user" -> MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
        "tool" -> Color(0x1AE67E22)
        "system", "done" -> Color.Transparent
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    val color = when (line.kind) {
        "system", "done" -> MaterialTheme.colorScheme.onSurfaceVariant
        else -> MaterialTheme.colorScheme.onSurface
    }
    // 折叠配色：思考过程默认收起，点击展开
    var showThinking by remember(line) { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth().padding(vertical = 3.dp), contentAlignment = if (line.kind == "user") Alignment.CenterEnd else Alignment.CenterStart) {
        Column(Modifier.widthIn(max = if (line.kind == "user") 320.dp else 600.dp), horizontalAlignment = if (line.kind == "user") Alignment.End else Alignment.Start) {
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

/** 提问卡片（仿照电脑端）：编号选项列表 + 可输入答案 + 跳过/提交 */
@Composable
private fun QuestionCard(q: QuestionItem?, onAnswer: (kotlinx.serialization.json.JsonObject) -> Unit) {
    val opts = q?.options ?: emptyList()
    var selected by remember(q?.id) { mutableStateOf<String?>(null) }
    var custom by remember(q?.id) { mutableStateOf("") }

    Column {
        Text(q?.prompt ?: "问题", style = MaterialTheme.typography.bodyLarge)
        // 选项编号列表
        opts.forEachIndexed { idx, opt ->
            val isSel = selected == opt.id
            Row(
                Modifier.fillMaxWidth().padding(vertical = 6.dp)
                    .background(if (isSel) MaterialTheme.colorScheme.primary.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f), RoundedCornerShape(10.dp))
                    .clickable { selected = opt.id }.padding(10.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Text("${idx + 1}", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(end = 6.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(opt.label, style = MaterialTheme.typography.bodyMedium)
                        if (idx == 0) Spacer(Modifier.width(6.dp))
                    }
                    if (!opt.description.isNullOrBlank()) {
                        Text(opt.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (isSel) Text("已选", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                }
            }
        }
        // 可输入答案
        OutlinedTextField(
            custom, { custom = it },
            modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
            placeholder = { Text("输入你的答案…") },
            singleLine = true,
        )
        // 跳过 / 提交
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { onAnswer(buildJsonObject { put("skip", true) }) }, modifier = Modifier.weight(1f)) { Text("跳过本题") }
            Button(onClick = {
                // 选中的选项 label 数组 + 自定义文本（DSH 期望 { answers:[{id,selected:[label],custom?}] }）
                val selArr = if (selected != null) buildJsonArray { add(kotlinx.serialization.json.JsonPrimitive(selected!!)) } else buildJsonArray { }
                onAnswer(buildJsonObject {
                    put("selected", selArr)
                    custom.takeIf { it.isNotBlank() }?.let { put("custom", it) }
                })
            }, enabled = selected != null || custom.isNotBlank(), modifier = Modifier.weight(1f)) { Text("提交") }
        }
    }
}

@Composable
private fun ChatComposer(input: String, onInput: (String) -> Unit, enabled: Boolean, onSend: () -> Unit) {    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp).imePadding(), verticalAlignment = Alignment.Bottom) {
        OutlinedTextField(input, onInput, modifier = Modifier.weight(1f), placeholder = { Text("输入消息…") }, minLines = 1, maxLines = 4)
        Button(onClick = onSend, enabled = enabled && input.isNotBlank(), modifier = Modifier.padding(start = 8.dp).height(56.dp)) { Text("发送") }
    }
}

@Composable
private fun ModelsTab(state: HomeState, onSelect: (ModelRef) -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp)) {
        Text("模型目录（应用于当前会话）", style = MaterialTheme.typography.titleSmall)
        state.models.forEach { m ->
            Card(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(m.displayName ?: m.model)
                        Text("${m.provider} / ${m.model}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    TextButton(onClick = { onSelect(m) }, enabled = state.currentId != null) { Text("应用") }
                }
            }
        }
    }
}

@Composable
private fun DevicesTab(state: HomeState, onRevoke: (DeviceInfo) -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp)) {
        Text("已注册设备（吊销后立即失效）", style = MaterialTheme.typography.titleSmall)
        state.devices.forEach { d ->
            Card(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(d.name)
                        Text("${d.deviceId} · ${if (d.revoked) "已吊销" else "正常"}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (!d.revoked) TextButton(onClick = { onRevoke(d) }) { Text("吊销", color = MaterialTheme.colorScheme.error) }
                }
            }
        }
    }
}

@Composable
private fun SettingsTab(binding: Binding, state: HomeState, onLogout: () -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp)) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp)) {
                Text("服务器：${binding.serverIp}")
                Text("连接：${if (state.connected) "在线" else "离线"}", color = if (state.connected) Color(0xFF2ECC71) else Color(0xFFE74C3C))
                Text("frp 端口：${binding.frpPort}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("当前版本：${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Button(onClick = onLogout, modifier = Modifier.padding(top = 10.dp)) { Text("退出登录") }
            }
        }
    }
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

