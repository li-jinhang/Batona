package com.batona.mobile.ui

import com.batona.mobile.data.ModelRef
import com.batona.mobile.data.AgentEvent
import com.batona.mobile.data.ServerRequest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test
import kotlinx.coroutines.runBlocking
import com.batona.mobile.data.GatewayFailure
import com.batona.mobile.data.GatewaySession
import com.batona.mobile.data.WorkspaceMini
import com.batona.mobile.data.WorkspaceNode
import com.batona.mobile.data.SessionNode
import com.batona.mobile.data.RpcError
import com.batona.mobile.data.RpcResult
import com.batona.mobile.data.SessionPermissionPresetOption
import com.batona.mobile.data.SessionPermissionPresetState
import com.batona.mobile.data.requireValue

class HomeStateTest {
    @Test fun validatedRefreshRemovesArchivedCacheAndRejectsLateDiskSnapshot() {
        val state = HomeState("codex")
        val old = WorkspaceNode(WorkspaceMini("old", "C:/old", "Old", ""), listOf(SessionNode("archived")))
        val current = WorkspaceNode(WorkspaceMini("new", "C:/new", "New", ""), listOf(SessionNode("active")))
        val cache = com.batona.mobile.data.CodexMirrorCache(listOf(old), mapOf("archived" to emptyList()))
        state.restoreCodexMirror(cache)
        state.codexCachedHistories["active"] = emptyList()
        state.applyWorkspaceTree(com.batona.mobile.data.WorktreeResult(listOf(current)))
        state.restoreCodexMirror(cache)
        assertEquals(listOf(current), state.worktree.toList())
        assertEquals(setOf("active"), state.codexCachedHistories.keys.toSet())
        assertEquals(listOf(current), state.codexCachedTree)
        state.applyWorkspaceTree(com.batona.mobile.data.WorktreeResult())
        assertTrue(state.worktree.isEmpty())
        assertTrue(state.codexCachedHistories.isEmpty())
        state.restoreCodexMirror(cache)
        assertTrue(state.worktree.isEmpty())
    }

    @Test fun workspaceCreationFailureKeepsDialogAndPathForRetry() = runBlocking {
        val state = HomeState("codex").apply { showNewWs = true; wsPath = "C:/repo" }
        assertNull(state.submitWorkspace { throw GatewayFailure("codex-projects-unavailable") })
        assertTrue(state.showNewWs)
        assertEquals("C:/repo", state.wsPath)
        assertNotNull(state.workspaceCreateError)
        assertFalse(state.workspaceCreateBusy)
        assertNull(state.submitWorkspace { com.batona.mobile.data.WorkspaceCreateResult() })
        assertTrue(state.showNewWs)
        val result = state.submitWorkspace { com.batona.mobile.data.WorkspaceCreateResult(
            com.batona.mobile.data.WorkspaceView("ws", "C:/repo", "Repo", createdAt = "", updatedAt = ""), true) }
        assertNotNull(result)
        assertFalse(state.showNewWs)
        assertEquals("", state.wsPath)
        assertNull(state.workspaceCreateError)
    }

    @Test fun processingTimerSurvivesPhaseChangesAndIgnoresOtherSessions() {
        for (backend in listOf("codex", "dsh")) {
            var now = 1_000L
            val state = HomeState(backend) { now }.apply {
                currentId = "current"
                gatewaySessionIds.add("other")
                input = "test"
            }
            val sendId = state.beginSend("current")!!
            assertEquals(0L, state.processingSeconds())
            now = 6_000L
            state.finishSend("current", sendId)
            state.handlePush(event("current", "session/thinking"))
            assertEquals("thinking", state.progress)
            assertEquals(5L, state.processingSeconds())
            state.handlePush(event("current", "tool/call"))
            assertEquals("running", state.progress)
            state.handlePush(event("other", "turn/end"))
            assertEquals(5L, state.processingSeconds())
            state.handlePush(event("current", "turn/end"))
            assertNull(state.processingSeconds())
            state.input = "again"
            val nextId = state.beginSend("current")!!
            assertEquals(0L, state.processingSeconds())
            state.failSend("current", nextId)
            assertNull(state.processingSeconds())
            state.beginSend("current")
            state.clearSessionActivity()
            assertNull(state.processingSeconds())
            state.progress = "thinking"
            state.handlePush(event("current", "error"))
            assertNull(state.processingSeconds())
        }
    }

    @Test fun gatewayEventsUpdateBackendSessionAndProgressOnlyForCurrentChat() {
        val state = HomeState("codex").apply {
            currentId = "gateway-one"
            currentBackendSessionId = "thread-one"
            gatewaySessionIds.addAll(listOf("gateway-one", "gateway-two"))
            backendSessionByGateway["gateway-one"] = "thread-one"
            backendSessionByGateway["gateway-two"] = "thread-two"
            worktree.add(WorkspaceNode(WorkspaceMini("ws", "C:/repo", "Repo", ""),
                listOf(SessionNode("thread-one"), SessionNode("thread-two"))))
        }
        state.handlePush(event("gateway-one", "turn/start"))
        assertEquals("running", state.worktree[0].sessions[0].state)
        assertEquals("running", state.progress)
        state.handlePush(event("gateway-two", "turn/end"))
        assertEquals("done", state.worktree[0].sessions[1].state)
        assertEquals("running", state.progress)
        state.handlePush(event("gateway-one", "session/thinking"))
        assertEquals("thinking", state.progress)
        state.handlePush(event("gateway-one", "session/reconnecting"))
        assertEquals("reconnecting", state.progress)
        state.handlePush(ServerRequest(rpcId = "retry", method = "session/event", payload = buildJsonObject {
            put("sessionId", "gateway-one")
            putJsonObject("event") { put("type", "session/reconnecting"); put("attempt", 2); put("maxAttempts", 5) }
        }))
        assertEquals("reconnecting:2/5", state.progress)
        state.handlePush(event("gateway-one", "turn/end"))
        assertNull(state.progress)
        assertEquals("done", state.worktree[0].sessions[0].state)
    }
    @Test fun consecutiveReasoningAndToolsBecomeOneExpandableProcessUntilVisibleReply() {
        val items = conversationItems(listOf(
            ChatLine(1, "assistant", reasoning = "先定位文件"),
            ChatLine(2, "tool", "读取文件", "read", toolPhase = "call"),
            ChatLine(3, "tool", "读取完成", "read", toolPhase = "result"),
            ChatLine(4, "assistant", "找到原因。", reasoning = "核对结果"),
            ChatLine(5, "tool", "运行测试", "test", toolPhase = "call"),
            ChatLine(6, "user", "继续"),
        ))
        assertEquals(listOf("analysis-1", "message-4", "analysis-5", "message-6"), items.map { it.key })
        val first = items[0] as ConversationItem.Analysis
        assertEquals(listOf("思考过程", "工具调用 · read", "工具结果 · read", "思考过程"), first.entries.map { it.label })
        assertEquals("找到原因。", (items[1] as ConversationItem.Message).line.text)
        assertEquals("", (items[1] as ConversationItem.Message).line.reasoning)
    }

    @Test fun historySkeletonDoesNotSplitAnalysisProcess() {
        val state = HomeState("dsh")
        state.replaceHistory(listOf(
            AgentEvent("assistant/message", reasoning = "检查实现"),
            AgentEvent("step/end"),
            AgentEvent("tool/call", toolName = "read"),
            AgentEvent("tool/result", toolName = "read", summary = "完成"),
            AgentEvent("assistant/message", text = "已完成"),
        ))
        val items = conversationItems(state.lines)
        assertEquals(2, items.size)
        assertEquals(3, (items[0] as ConversationItem.Analysis).entries.size)
        assertEquals("已完成", (items[1] as ConversationItem.Message).line.text)
    }

    @Test fun changingCodexModelKeepsCurrentEffort() {
        val state = HomeState("codex")
        state.selectedModel = ModelRef("openai", "first", "high")
        val choices = listOf(ModelRef("openai", "second", "low"), ModelRef("openai", "second", "medium"), ModelRef("openai", "second", "high"))
        assertEquals("high", state.modelChoice(choices)?.reasoningEffort)
        assertEquals("low", state.modelChoice(choices.dropLast(1))?.reasoningEffort)
        state.selectedModel = null
        assertEquals("low", state.modelChoice(choices)?.reasoningEffort)
        val withDefault = choices.map { it.copy(defaultReasoningEffort = "medium") }
        assertEquals("medium", state.modelChoice(withDefault)?.reasoningEffort)
    }

    @Test fun modelSelectionNeedsConfirmedPair() {
        val requested = ModelRef("openai", "gpt-test", "medium")
        val confirmed: RpcResult<kotlinx.serialization.json.JsonElement> = RpcResult(ok = true, value = buildJsonObject {
            putJsonObject("model") { put("provider", "openai"); put("model", "gpt-test"); put("reasoningEffort", "medium") }
        })
        assertEquals(requested.reasoningEffort, confirmedModelSelection(confirmed, requested).reasoningEffort)
        assertThrows(GatewayFailure::class.java) {
            confirmedModelSelection(RpcResult<kotlinx.serialization.json.JsonElement>(ok = true, value = buildJsonObject { put("accepted", true) }), requested)
        }
    }

    @Test fun changingDshModelKeepsEffortWhenSupportedAndUsesCatalogDefaultOtherwise() {
        val state = HomeState("dsh")
        state.selectedModel = ModelRef("dsh", "first", "high")
        val choices = listOf(ModelRef("dsh", "second", "off"), ModelRef("dsh", "second", "high"))
        assertEquals("high", state.modelChoice(choices)?.reasoningEffort)
        assertEquals("off", state.modelChoice(choices.take(1))?.reasoningEffort)
    }

    @Test fun codexSendAppearsImmediatelyAndFailureRestoresDraft() {
        val state = HomeState("codex").apply { currentId = "session"; input = "hello" }
        val lineId = state.beginSend("session")
        assertNotNull(lineId)
        assertEquals("hello", state.lines.last().text)
        assertEquals("", state.input)
        state.failSend("session", lineId!!)
        assertTrue(state.lines.isEmpty())
        assertEquals("hello", state.input)
    }

    @Test fun oldSendFailureCannotClearNewSessionProgress() {
        val state = HomeState("codex").apply { currentId = "old"; input = "old request" }
        val oldLine = state.beginSend("old")!!
        state.currentId = "new"
        state.clearSessionActivity()
        state.input = "new request"
        val newLine = state.beginSend("new")!!
        state.progress = "thinking"
        state.failSend("old", oldLine)
        state.finishSend("old", oldLine)
        assertEquals("thinking", state.progress)
        assertTrue(state.busy)
        assertTrue(state.sending)
        state.finishSend("new", newLine)
        assertFalse(state.busy)
    }

    @Test fun newCodexHistoryArrivesWithoutReopeningAndDoesNotDuplicatePush() {
        val state = HomeState("codex").apply { currentId = "session" }
        state.replaceHistory(listOf(AgentEvent("user/message", text = "hello")))
        state.appendEvent(AgentEvent("assistant/message", text = "reply"))
        state.reconcileHistory(listOf(AgentEvent("user/message", text = "hello"), AgentEvent("assistant/message", text = "reply")))
        assertEquals(listOf("hello", "reply"), state.lines.map { it.text })
    }

    @Test fun historyReconcileDoesNotDuplicateAlreadyPushedTurn() {
        val state = HomeState("codex").apply { currentId = "session" }
        state.replaceHistory(emptyList())
        state.appendEvent(AgentEvent("user/message", text = "hello"))
        state.appendEvent(AgentEvent("assistant/message", text = "reply"))
        state.reconcileHistory(listOf(AgentEvent("user/message", text = "hello"), AgentEvent("assistant/message", text = "reply")))
        assertEquals(listOf("hello", "reply"), state.lines.map { it.text })
    }

    @Test fun initialHistoryDoesNotErasePendingSend() {
        val state = HomeState("codex").apply { currentId = "session"; input = "hello" }
        val lineId = state.beginSend("session")!!
        state.finishSend("session", lineId)
        state.replaceHistory(emptyList())
        assertEquals(listOf("hello"), state.lines.map { it.text })
        state.reconcileHistory(listOf(AgentEvent("user/message", text = "hello"), AgentEvent("assistant/message", text = "reply")))
        assertEquals(listOf("hello", "reply"), state.lines.map { it.text })
    }

    @Test fun lateEchoAfterHistoryDoesNotDuplicateOptimisticUserMessage() {
        val state = HomeState("codex").apply { currentId = "session"; input = "hello" }
        val lineId = state.beginSend("session")!!
        state.replaceHistory(listOf(AgentEvent("user/message", text = "hello"), AgentEvent("assistant/message", text = "reply")))
        state.finishSend("session", lineId)
        state.appendEvent(AgentEvent("user/message", text = "hello"))
        assertEquals(1, state.lines.count { it.kind == "user" && it.text == "hello" })
    }

    @Test fun sendingSameTextTwiceStillShowsBothTurns() {
        val state = HomeState("codex").apply { currentId = "session"; input = "hello" }
        val first = state.beginSend("session")!!
        state.appendEvent(AgentEvent("user/message", text = "hello"))
        state.finishSend("session", first)
        state.input = "hello"
        val second = state.beginSend("session")!!
        state.appendEvent(AgentEvent("user/message", text = "hello"))
        state.finishSend("session", second)
        assertEquals(2, state.lines.count { it.kind == "user" && it.text == "hello" })
    }

    @Test fun interveningStatusDoesNotMakeDshEchoDuplicateOptimisticUserMessage() {
        val state = HomeState("dsh").apply { currentId = "session"; input = "hello" }
        state.beginSend("session")
        state.appendEvent(AgentEvent("tool/call", toolName = "demo"))
        state.appendEvent(AgentEvent("user/message", text = "hello"))
        assertEquals(1, state.lines.count { it.kind == "user" && it.text == "hello" })
    }
    @Test fun openingExistingSessionUsesReportedModelAndClearsPreviousSelection() = runBlocking {
        val state = HomeState("codex")
        state.selectedModel = ModelRef("openai", "other-session-model")
        val wire = """{"id":"gateway","backend":"codex","backendSessionId":"existing","state":"idle","createdAt":0,"model":{"provider":"openai","model":"actual-model","reasoningEffort":"high"}}"""
        val session = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
            .decodeFromString(GatewaySession.serializer(), wire)
        state.openSession("existing") { _, _ -> session }
        assertEquals("actual-model", state.selectedModel?.model)
        assertEquals("high", state.selectedModel?.reasoningEffort)
        state.openSession("unknown") { _, _ -> GatewaySession("next", "codex", "unknown", null, "idle", 0) }
        assertNull(state.selectedModel)
    }

    @Test fun failedOpenStaysInChatAndCanRetry() = runBlocking {
        val state = HomeState("codex")
        state.input = "keep draft"
        state.openSession("existing") { _, _ -> throw GatewayFailure("codex-desktop-owned") }
        assertTrue(state.entering)
        assertNull(state.currentId)
        assertNotNull(state.sessionError)
        assertEquals("keep draft", state.input)
        state.openSession("existing") { backend, id -> GatewaySession("gateway", backend, id, "Title", "idle", 0) }
        assertFalse(state.entering)
        assertEquals("gateway", state.currentId)
        assertNull(state.sessionError)
    }

    @Test fun failedWorkspaceRpcCannotMasqueradeAsEmptyList() {
        val result = RpcResult<List<String>>(false, error = RpcError("dsh-http-error", "HTTP 401"))
        val failure = assertThrows(GatewayFailure::class.java) { result.requireValue() }
        assertEquals("dsh-http-error", failure.code)
        assertEquals(emptyList<String>(), RpcResult(true, emptyList<String>()).requireValue())
    }

    @Test fun backendTabsKeepIndependentDraftsModelsAndApprovals() {
        val dsh = HomeState("dsh")
        val codex = HomeState("codex")
        dsh.currentId = "dsh-session"
        dsh.input = "DSH draft"
        dsh.selectedModel = ModelRef("dsh", "model-a")
        codex.currentId = "codex-session"
        codex.input = "Codex draft"
        codex.profileBySession["codex-session"] = "request-approval"
        codex.pending = PendingFrame("approval", "request-1")

        // Switching tabs only selects a state, never resets or copies it.
        listOf(dsh, codex, dsh, codex).forEach { assertNotNull(it.currentId) }
        assertEquals("DSH", dsh.label)
        assertEquals("Codex", codex.label)
        assertEquals("DSH draft", dsh.input)
        assertEquals("Codex draft", codex.input)
        assertNull(codex.selectedModel)
        assertNull(dsh.pending)
        assertTrue(dsh.profileBySession.isEmpty())
        assertEquals("request-1", codex.pending?.rpcId)
    }

    @Test fun sharedSocketRoutesTitleOnlyToOwningBackend() {
        val dsh = HomeState("dsh").apply { currentId = "gateway-dsh"; currentTitle = "DSH title" }
        val codex = HomeState("codex").apply { currentId = "gateway-codex" }
        var dshRefreshes = 0
        var codexRefreshes = 0
        dsh.onTitleChanged = { dshRefreshes++ }
        codex.onTitleChanged = { codexRefreshes++ }
        val frame = event("gateway-codex", "session/title", "Codex title")
        dsh.handlePush(frame)
        codex.handlePush(frame)
        assertEquals("DSH title", dsh.currentTitle)
        assertEquals("Codex title", codex.currentTitle)
        assertEquals(0, dshRefreshes)
        assertEquals(1, codexRefreshes)
    }

    @Test fun dshPermissionPresetPushUpdatesCurrentSessionState() {
        val state = HomeState("dsh").apply {
            currentId = "gateway-dsh"
            dshPermissionBySession[currentId!!] = SessionPermissionPresetState(
                supported = true,
                currentValue = "read-only",
                options = listOf(SessionPermissionPresetOption("read-only", "只读", "", true)),
            )
        }
        val frame = ServerRequest(rpcId = "event-1", method = "session/event", payload = buildJsonObject {
            put("sessionId", "gateway-dsh")
            putJsonObject("event") {
                put("type", "session/permissionPreset")
                put("permissionPresetId", "workspace-write")
            }
        })
        state.handlePush(frame)
        assertEquals("workspace-write", state.dshPermissionBySession["gateway-dsh"]?.currentValue)
        assertTrue(state.lines.isEmpty())
    }

    @Test fun previouslyOpenedSessionNotifiesOnceEvenAfterReturningToList() {
        val dsh = HomeState("dsh")
        val codex = HomeState("codex").apply { gatewaySessionIds.add("gateway-codex") }
        val notices = mutableListOf<String>()
        dsh.onAgentNotice = { notices.add("dsh:$it") }
        codex.onAgentNotice = { notices.add("codex:$it") }
        val frame = event("gateway-codex", "turn/end")
        dsh.handlePush(frame)
        codex.handlePush(frame)
        assertEquals(listOf("codex:completed"), notices)
        assertTrue(dsh.lines.isEmpty())
        assertTrue(codex.lines.isEmpty())
    }

    @Test fun unknownSessionDoesNotRefreshEitherBackend() {
        val states = listOf(HomeState("dsh"), HomeState("codex"))
        var refreshes = 0
        states.forEach {
            it.onTitleChanged = { refreshes++ }
            it.handlePush(event("unknown", "session/title", "ignore"))
        }
        assertEquals(0, refreshes)
    }

    @Test fun desktopResolutionClosesOnlyMatchingPhoneApproval() {
        val state = HomeState("codex").apply {
            currentId = "gateway-codex"
            pending = PendingFrame("approval", "approval-1")
        }
        fun resolved(id: String) = ServerRequest(rpcId = "event-1", method = "interaction/resolved", payload = buildJsonObject {
            put("sessionId", "gateway-codex")
            putJsonArray("requestRpcIds") { add(JsonPrimitive(id)) }
        })
        state.handlePush(resolved("other-approval"))
        assertEquals("approval-1", state.pending?.rpcId)
        state.handlePush(resolved("approval-1"))
        assertNull(state.pending)
    }

    private fun event(sessionId: String, type: String, title: String = "") =
        ServerRequest(rpcId = "event-1", method = "session/event", payload = buildJsonObject {
            put("sessionId", sessionId)
            putJsonObject("event") { put("type", type); put("title", title) }
        })
}
