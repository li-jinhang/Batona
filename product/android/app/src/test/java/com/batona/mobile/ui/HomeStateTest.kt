package com.batona.mobile.ui

import com.batona.mobile.data.ModelRef
import com.batona.mobile.data.ServerRequest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.*
import org.junit.Test
import kotlinx.coroutines.runBlocking
import com.batona.mobile.data.GatewayFailure
import com.batona.mobile.data.GatewaySession
import com.batona.mobile.data.RpcError
import com.batona.mobile.data.RpcResult
import com.batona.mobile.data.requireValue

class HomeStateTest {
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

    private fun event(sessionId: String, type: String, title: String = "") =
        ServerRequest(rpcId = "event-1", method = "session/event", payload = buildJsonObject {
            put("sessionId", sessionId)
            putJsonObject("event") { put("type", type); put("title", title) }
        })
}
