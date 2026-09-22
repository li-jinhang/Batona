package com.batona.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.batona.mobile.data.WorkspaceNode
import com.batona.mobile.ui.theme.BatonaAmber
import com.batona.mobile.ui.theme.BatonaGreen
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
internal fun BatonaMark(modifier: Modifier = Modifier) {
    Surface(modifier.size(27.dp), shape = CircleShape, color = MaterialTheme.colorScheme.primary) {
        Box(Modifier.padding(6.dp).background(Color.White, CircleShape))
    }
}

internal fun sessionStatusLabel(state: String): String = when (state) {
    "waiting-approval" -> "等待批准"
    "waiting-question" -> "等待回答"
    "running", "busy", "streaming" -> "运行中"
    "done", "completed" -> "已完成"
    "error", "failed" -> "失败"
    "cancelled", "canceled" -> "已停止"
    else -> "空闲"
}

@Composable
internal fun SessionStatus(state: String, modifier: Modifier = Modifier) {
    val color = when (state) {
        "waiting-approval", "waiting-question" -> BatonaAmber
        "done", "completed" -> BatonaGreen
        "error", "failed" -> MaterialTheme.colorScheme.error
        "running", "busy", "streaming" -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.size(8.dp).background(color, CircleShape))
        Text(sessionStatusLabel(state), style = MaterialTheme.typography.labelMedium, color = color)
    }
}

@Composable
internal fun WorkspaceCard(
    node: WorkspaceNode, state: HomeState, initiallyOpen: Boolean,
    onSelect: (String, String) -> Unit, onNewSession: (String?, String?, String?) -> Unit,
) {
    val ws = node.workspace
    val open = state.expanded[ws.workspaceId] ?: initiallyOpen
    val showOlder = state.olderExpanded[ws.workspaceId] ?: false
    var workspaceMenu by remember { mutableStateOf(false) }
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(Modifier.weight(1f).clickable { state.expanded[ws.workspaceId] = !open }.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Folder, null, Modifier.size(26.dp))
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text(ws.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${node.sessions.size} 个会话", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                IconButton(onClick = { onNewSession(ws.workspaceId, ws.title, ws.path) }, enabled = state.connected) {
                    Icon(Icons.Outlined.Add, "在 ${ws.title} 新建会话")
                }
                Box {
                    IconButton(onClick = { workspaceMenu = true }) { Icon(Icons.Outlined.MoreVert, "工作区菜单 ${ws.title}") }
                    DropdownMenu(workspaceMenu, onDismissRequest = { workspaceMenu = false }) {
                        DropdownMenuItem(text = { Text("移除工作区") }, enabled = state.connected,
                            onClick = { workspaceMenu = false; state.deletingWs = ws.workspaceId })
                    }
                }
                IconButton(onClick = { state.expanded[ws.workspaceId] = !open }) { Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, if (open) "收起 ${ws.title}" else "展开 ${ws.title}") }
            }
            if (open) {
                val sessions = if (showOlder) node.sessions else node.sessions.take(5)
                sessions.forEachIndexed { index, session ->
                    var menu by remember(session.sessionId) { mutableStateOf(false) }
                    Row(Modifier.fillMaxWidth().testTag("session-${session.sessionId}")
                        .clickable { onSelect(session.sessionId, ws.title) }.padding(start = 12.dp, top = 6.dp, bottom = 6.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                            Text(session.title ?: session.sessionId, maxLines = 2, overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                            SessionStatus(session.state)
                        }
                        if (session.updatedAt > 0) Text(SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(session.updatedAt)),
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Box {
                            IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, "会话菜单 ${session.title ?: session.sessionId}", Modifier.size(20.dp)) }
                            DropdownMenu(menu, onDismissRequest = { menu = false }) {
                                DropdownMenuItem(text = { Text("重命名") }, enabled = state.connected,
                                    onClick = { menu = false; state.renaming = session.sessionId; state.renameText = session.title ?: session.sessionId })
                                DropdownMenuItem(text = { Text("归档会话") }, enabled = state.connected,
                                    onClick = { menu = false; state.archiving = session.sessionId })
                            }
                        }
                    }
                    if (index != sessions.lastIndex) HorizontalDivider(Modifier.padding(horizontal = 12.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .6f))
                }
                if (node.sessions.size > 5) TextButton(onClick = { state.olderExpanded[ws.workspaceId] = !showOlder }) {
                    Text(if (showOlder) "收起较早会话" else "查看更早会话（${node.sessions.size - 5}）")
                }
                if (node.sessions.isEmpty()) Text("暂无会话，点击 + 开始", Modifier.padding(12.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
