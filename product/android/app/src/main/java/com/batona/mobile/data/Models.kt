package com.batona.mobile.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** 网关前端协议 v1 —— 四象限 RPC 信封（与 gateway/src/proto 对齐） */

@Serializable
data class ClientRequest(val type: String = "client-request", val rpcId: String, val method: String, val payload: JsonElement)

@Serializable
data class ServerResponse(val type: String = "server-response", val rpcId: String, val result: RpcResult<JsonElement>)

@Serializable
data class ServerRequest(val type: String = "server-request", val rpcId: String, val method: String, val payload: JsonElement)

@Serializable
data class ClientResponse(val type: String = "client-response", val rpcId: String, val result: RpcResult<JsonElement>)

@Serializable
data class RpcResult<T>(val ok: Boolean, val value: T? = null, val error: RpcError? = null)

@Serializable
data class RpcError(val code: String, val message: String, val details: JsonElement? = null)

/** 登录请求/响应 */
@Serializable
data class LoginRequest(val username: String, val password: String, val totp: String? = null, val deviceName: String = "android")

@Serializable
data class LoginResponse(val ok: Boolean, val token: String? = null, val deviceId: String? = null, val error: String? = null, val otpauthUri: String? = null)

/** 会话 */
@Serializable
data class GatewaySession(val id: String, val backend: String, val backendSessionId: String, val title: String? = null, val state: String, val createdAt: Long, val model: ModelRef? = null)

@Serializable
data class SessionListResult(val sessions: List<GatewaySession> = emptyList())

/** 事件（归一化 AgentEvent 子集） */
@Serializable
data class AgentEvent(
    val type: String,
    val text: String? = null,
    val toolName: String? = null,
    val callId: String? = null,
    val args: JsonElement? = null,
    val ok: Boolean? = null,
    val summary: String? = null,
    val approvalId: String? = null,
    val reason: String? = null,
    val questionRpcId: String? = null,
    val questions: List<QuestionItem>? = null,
    val title: String? = null,
    val code: String? = null,
    val message: String? = null,
    val reasoning: String? = null,
    val model: ModelRef? = null,
    val profileId: String? = null,
    val permissionPresetId: String? = null,
    val attempt: Int? = null,
    val maxAttempts: Int? = null,
)

@Serializable
data class QuestionItem(
    val id: String,
    val kind: String,
    val prompt: String,
    val placeholder: String? = null,
    val isSecret: Boolean = false,
    val options: List<QuestionOption>? = null,
)

@Serializable
data class QuestionOption(val id: String, val label: String, val description: String? = null)

/** 工作区 */
@Serializable
data class WorkspaceView(val workspaceId: String, val path: String, val title: String, val sessionIds: List<String> = emptyList(), val createdAt: String, val updatedAt: String)

@Serializable
data class WorkspaceListResult(val items: List<WorkspaceView> = emptyList())

@Serializable
data class WorkspaceCreateResult(val workspace: WorkspaceView? = null, val created: Boolean = false)

/** 模型 */
@Serializable
data class ModelRef(val provider: String, val model: String, val reasoningEffort: String? = null, val displayName: String? = null,
    val defaultReasoningEffort: String? = null)

@Serializable
data class ModelListResult(val items: List<ModelRef> = emptyList())

/** PC 端实际校验过、手机仅可选择的 Codex 权限档。 */
@Serializable
data class AgentProfile(val id: String, val label: String, val description: String, val available: Boolean = false)

@Serializable
data class AgentProfileListResult(val items: List<AgentProfile> = emptyList())

@Serializable
data class PermissionMenuState(val profileId: String? = null)

/** DSH 当前会话的原生权限预设；available 由 DSH permissions 投影验证。 */
@Serializable
data class SessionPermissionPresetOption(
    val id: String,
    val label: String,
    val description: String,
    val available: Boolean = false,
)

@Serializable
data class SessionPermissionPresetState(
    val supported: Boolean = false,
    val currentValue: String? = null,
    val options: List<SessionPermissionPresetOption> = emptyList(),
)

/** 设备 */
@Serializable
data class DeviceInfo(val deviceId: String, val name: String, val registeredAt: Long, val revoked: Boolean)

@Serializable
data class DeviceListResult(val items: List<DeviceInfo> = emptyList())

/** 历史 */
@Serializable
data class HistoryResult(val events: List<AgentEvent> = emptyList())

/** 工作区树（工作区 → 会话层级） */
@Serializable
data class WorktreeResult(val items: List<WorkspaceNode> = emptyList(), val ungroupedSessions: List<SessionNode> = emptyList())

/** 目录浏览结果：path 当前目录；roots 盘符根（path 为空时）；dirs 子目录（path 非空时） */
@Serializable
data class DirListResult(val path: String = "", val dirs: List<String>? = null, val roots: List<String>? = null)

@Serializable
data class WorkspaceNode(val workspace: WorkspaceMini, val sessions: List<SessionNode> = emptyList())

@Serializable
data class WorkspaceMini(val workspaceId: String, val path: String, val title: String, val createdAt: String)

@Serializable
data class SessionNode(val sessionId: String, val title: String? = null, val state: String = "idle", val updatedAt: Long = 0)

/**
 * 仅供已绑定手机离线浏览的 Codex 镜像；不保存令牌、连接串或待处理的审批/提问答案。
 * 工作区仅留最近 5 个会话，单会话最多留 200 个已经过 PC 脱敏的事件。
 */
@Serializable
data class CodexMirrorCache(
    val worktree: List<WorkspaceNode> = emptyList(),
    val histories: Map<String, List<AgentEvent>> = emptyMap(),
    val savedAt: Long = 0,
    val ungroupedSessions: List<SessionNode> = emptyList(),
)
