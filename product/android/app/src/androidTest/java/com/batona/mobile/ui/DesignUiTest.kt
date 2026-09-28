package com.batona.mobile.ui

import android.app.Application
import android.graphics.Bitmap
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Scaffold
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import com.batona.mobile.data.*
import com.batona.mobile.ui.theme.BatonaTheme
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

/** Real Compose rendering with isolated data; no production credentials or agent calls. */
class DesignUiTest {
    @get:Rule val compose = createComposeRule()
    private val client = GatewayClient(Binding("127.0.0.1"), {}, {})

    private fun fixture() = HomeState("codex").apply {
        connected = true
        profiles.add(AgentProfile("ask", "请求批准", "批准后执行", true))
        selectedModel = ModelRef("codex", "test-model", "high", "示例模型")
        worktree.add(WorkspaceNode(WorkspaceMini("ws", "D:/Example", "Batona", ""), listOf(
            SessionNode("s1", "PC 界面优化", "waiting-approval"),
            SessionNode("s2", "整理登录流程", "done"),
            SessionNode("s3", "修复连接状态", "done"),
            SessionNode("s4", "补充运行日志", "idle"),
            SessionNode("s5", "优化模型切换", "done"),
            SessionNode("s6", "更早的会话", "done"),
        )))
        worktree.add(WorkspaceNode(WorkspaceMini("web", "D:/ExampleWeb", "个人网站", "")))
    }

    private fun show(state: HomeState, refresh: () -> Unit = {}, answer: (JsonObject) -> Unit = {}) {
        compose.setContent {
            BatonaTheme {
                val tab = if (state.backend == "codex") 1 else 0
                Scaffold(bottomBar = { HomeBottomBar(tab, state) {} }) { pad ->
                    Box(Modifier.padding(pad)) {
                        ChatTab(state, client, state.backend, onSelectSession = { _, _ -> }, onBack = {}, onToggle = {},
                            onNewSession = { _, _, _ -> }, onDeleteWs = {}, onArchive = {}, onNewWorkspace = {},
                            onAnswer = answer, onWsChanged = refresh)
                    }
                }
            }
        }
    }

    @Test fun refreshReplacesArchivedWorkspaceAndPersistedMirror() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val store = com.batona.mobile.SettingsStore(app)
        val old = WorkspaceNode(WorkspaceMini("old", "C:/old", "已归档项目", ""), listOf(SessionNode("old-session")))
        val current = WorkspaceNode(WorkspaceMini("new", "C:/new", "当前项目", ""), listOf(SessionNode("new-session")))
        val state = HomeState("codex")
        state.restoreCodexMirror(CodexMirrorCache(listOf(old), mapOf("old-session" to emptyList())))
        state.connected = true
        show(state, refresh = { state.applyWorkspaceTree(WorktreeResult(listOf(current))) })
        compose.onNodeWithText("已归档项目").assertExists()
        compose.onNodeWithContentDescription("刷新工作区").performClick()
        compose.onNodeWithText("已归档项目").assertDoesNotExist()
        compose.onNodeWithText("当前项目").assertExists()
        kotlinx.coroutines.runBlocking {
            state.persistCodexMirror(store)
            val saved = store.loadCodexMirror()!!
            assertEquals(listOf(current), saved.worktree)
            assertFalse(saved.histories.containsKey("old-session"))
        }
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val app = ApplicationProvider.getApplicationContext<Application>()
        File(app.getExternalFilesDir(null), name).outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    @Test fun workspaceCreateFailureRemainsVisibleForRetry() {
        val state = fixture().apply { showNewWs = true; wsPath = "C:/repo" }
        show(state)
        compose.waitForIdle()
        compose.runOnIdle {
            kotlinx.coroutines.runBlocking {
                state.submitWorkspace { throw GatewayFailure("codex-projects-unavailable") }
            }
        }
        compose.onNodeWithText("创建工作区").assertIsDisplayed()
        compose.onNodeWithText("C:/repo").assertIsDisplayed()
        compose.onNodeWithText(GatewayFailure("codex-projects-unavailable").message!!).assertIsDisplayed()
        compose.onNodeWithText("创建", useUnmergedTree = true).performClick()
        compose.onNodeWithText("创建工作区").assertIsDisplayed()
        compose.runOnIdle { state.workspaceCreateBusy = true }
        compose.onNodeWithText("正在创建…").assertIsNotEnabled()
        compose.onNodeWithText("取消").assertIsNotEnabled()
    }

    @Test fun workspaceMenusAndOlderSessionsRemainAccessible() {
        val state = fixture()
        show(state)
        compose.onNodeWithTag("backend-navigation").assertIsDisplayed()
        compose.onNodeWithText("PC 界面优化").assertIsDisplayed()
        compose.onNodeWithText("更早的会话").assertDoesNotExist()
        compose.onNodeWithText("归档会话").assertDoesNotExist()
        capture("android-workspaces.png")
        compose.onNodeWithContentDescription("会话菜单 PC 界面优化").performClick()
        compose.onNodeWithText("重命名").assertIsDisplayed()
        compose.onNodeWithText("归档会话").performClick()
        compose.onNodeWithText("确认归档").assertIsDisplayed()
        compose.onNodeWithText("取消").performClick()
        compose.onNodeWithText("查看更早会话（1）").performScrollTo().performClick()
        compose.onNodeWithText("更早的会话").performScrollTo().assertIsDisplayed()
        compose.onNodeWithContentDescription("收起 Batona").performScrollTo().performClick()
        compose.onNodeWithText("PC 界面优化").assertDoesNotExist()
        compose.onNodeWithContentDescription("展开 Batona").performClick()
        compose.onNodeWithText("PC 界面优化").assertIsDisplayed()
    }

    @Test fun approvalStaysVisibleAndCannotSubmitOffline() {
        val state = fixture().apply {
            currentId = "gateway-session"; currentBackendSessionId = "s1"
            currentTitle = "PC 界面优化"; currentWsTitle = "Batona"
            lines.add(ChatLine(1, "user", "按确认的方案优化 PC 界面。"))
            lines.add(ChatLine(2, "assistant", "我会调整顶部状态区，并统一后端卡片的布局。", reasoning = "先检查当前布局。"))
            lines.add(ChatLine(3, "tool", "已读取界面文件", "读取文件"))
            pending = PendingFrame("approval", "original-rpc-id", "修改文件", "调整状态栏与卡片间距。")
        }
        var response: JsonObject? = null
        show(state) { response = it }
        compose.onNodeWithTag("backend-navigation").assertDoesNotExist()
        compose.onNodeWithTag("agent-logo-codex").assertDoesNotExist()
        compose.onNodeWithText("Codex").assertDoesNotExist()
        compose.onNodeWithTag("conversation-action-panel").assertIsDisplayed()
        compose.onNodeWithText("允许一次").performScrollTo().assertIsEnabled()
        capture("android-conversation.png")
        compose.runOnIdle { state.connected = false }
        compose.onNodeWithText("允许一次").assertIsNotEnabled()
        compose.onNodeWithText("拒绝").assertIsNotEnabled()
        compose.onNodeWithContentDescription("发送").assertIsNotEnabled()
        compose.runOnIdle { state.connected = true; state.answering = true }
        compose.onNodeWithText("提交中…").assertIsNotEnabled()
        compose.runOnIdle { state.answering = false }
        compose.onNodeWithText("允许一次").performClick()
        compose.runOnIdle { assertEquals("allowed-once", response?.get("outcome")?.jsonPrimitive?.content) }
    }

    @Test fun dshConversationHidesBackendNavigationAndShowsWhiteActionPanel() {
        val state = HomeState("dsh").apply {
            connected = true
            currentId = "gateway-session"
            currentTitle = "运行测试"
            lines.add(ChatLine(1, "assistant", "会话历史"))
        }
        show(state)
        compose.onNodeWithTag("backend-navigation").assertDoesNotExist()
        compose.onNodeWithTag("agent-logo-dsh").assertDoesNotExist()
        compose.onNodeWithText("DSH").assertDoesNotExist()
        compose.onNodeWithTag("conversation-action-panel").assertIsDisplayed()
        compose.runOnIdle { state.currentId = null; state.entering = true }
        compose.onNodeWithTag("backend-navigation").assertDoesNotExist()
        compose.runOnIdle { state.entering = false }
        compose.onNodeWithTag("backend-navigation").assertIsDisplayed()
    }

    @Test fun adjacentReasoningAndToolsShareOneCollapsedAnalysisProcess() {
        val state = fixture().apply {
            currentId = "gateway-session"; currentTitle = "运行测试"; currentWsTitle = "Batona"
            lines.add(ChatLine(1, "assistant", reasoning = "先确认相关文件。"))
            lines.add(ChatLine(2, "tool", "已读取界面文件", "读取文件"))
            lines.add(ChatLine(3, "tool", "成功读取 1 个文件", "读取文件", toolPhase = "result"))
        }
        show(state)
        compose.onAllNodesWithText("分析过程").assertCountEquals(1)
        compose.onNodeWithText("已读取界面文件").assertDoesNotExist()
        compose.onNodeWithText("成功读取 1 个文件").assertDoesNotExist()
        compose.runOnIdle {
            state.lines.add(ChatLine(4, "assistant", reasoning = "核对文件版本"))
            state.lines.add(ChatLine(5, "assistant", "已经定位到问题。"))
        }
        compose.onNodeWithText("4 项").assertIsDisplayed()
        compose.onNodeWithText("已经定位到问题。").assertIsDisplayed()
        capture("android-analysis-collapsed.png")
        compose.onNodeWithContentDescription("展开分析过程").performClick()
        compose.onAllNodesWithText("思考过程").assertCountEquals(2)
        val firstThought = compose.onAllNodesWithText("思考过程")[0].fetchSemanticsNode().boundsInRoot.top
        val call = compose.onNodeWithText("工具调用 · 读取文件").fetchSemanticsNode().boundsInRoot.top
        val result = compose.onNodeWithText("工具结果 · 读取文件").fetchSemanticsNode().boundsInRoot.top
        val lastThought = compose.onAllNodesWithText("思考过程")[1].fetchSemanticsNode().boundsInRoot.top
        assertTrue("Analysis entries must retain event order", firstThought < call && call < result && result < lastThought)
        compose.onAllNodesWithContentDescription("展开思考过程")[0].performClick()
        compose.onNodeWithText("先确认相关文件。").assertIsDisplayed()
        compose.onNodeWithText("核对文件版本").assertDoesNotExist()
        compose.onNodeWithContentDescription("展开工具调用 · 读取文件").performClick()
        compose.onNodeWithText("已读取界面文件").assertIsDisplayed()
        compose.onNodeWithContentDescription("展开工具结果 · 读取文件").performClick()
        compose.onNodeWithText("成功读取 1 个文件").assertIsDisplayed()
        capture("android-analysis-expanded.png")
        compose.onNodeWithContentDescription("收起分析过程").performClick()
        compose.onNodeWithText("已读取界面文件").assertDoesNotExist()
    }

    @Test fun requestShowsThinkingAndElapsedTimeUntilCompleted() {
        var now = 0L
        val state = HomeState("codex") { now }.apply {
            connected = true
            currentId = "gateway-session"; currentTitle = "状态测试"
            input = "检查代码"
            beginSend("gateway-session")
        }
        show(state)
        compose.onNodeWithText("已处理 0 秒").assertIsDisplayed()
        compose.runOnIdle {
            state.handlePush(ServerRequest(rpcId = "thinking", method = "session/event", payload = kotlinx.serialization.json.buildJsonObject {
                put("sessionId", kotlinx.serialization.json.JsonPrimitive("gateway-session"))
                put("event", kotlinx.serialization.json.buildJsonObject {
                    put("type", kotlinx.serialization.json.JsonPrimitive("assistant/chunk"))
                    put("reasoning", kotlinx.serialization.json.JsonPrimitive("检查实现"))
                })
            }))
        }
        compose.onNodeWithText("正在思考").assertIsDisplayed()
        compose.runOnIdle { now = 5_000L }
        compose.waitUntil(3_000) {
            compose.onAllNodesWithText("已处理 5 秒").fetchSemanticsNodes().isNotEmpty()
        }
        capture("android-thinking-duration.png")
        compose.runOnIdle { state.progress = null }
        compose.onNodeWithText("已处理", substring = true).assertDoesNotExist()
        compose.onNodeWithText("正在思考").assertDoesNotExist()
    }

    @Test fun codexThinkingStrengthIsAvailableSeparatelyFromModel() {
        val state = fixture().apply {
            currentId = "gateway-session"; currentTitle = "运行测试"; currentWsTitle = "Batona"
            selectedModel = ModelRef("openai", "gpt-5.6-sol", "high", "GPT-5.6 Sol")
            models.add(ModelRef("openai", "gpt-5.6-sol", "low", "GPT-5.6 Sol"))
            models.add(ModelRef("openai", "gpt-5.6-sol", "high", "GPT-5.6 Sol"))
        }
        show(state)
        compose.onNodeWithContentDescription("选择思考强度").performClick()
        compose.onNodeWithText("Codex · 思考强度").assertIsDisplayed()
        compose.onNodeWithTag("effort-option-low").assertIsDisplayed()
        compose.onNodeWithTag("effort-option-high").assertIsDisplayed()
    }

    @Test fun questionsSupportChoicesAndTextWithoutReusingPreviousAnswers() {
        val state = fixture().apply {
            currentId = "gateway-session"; currentTitle = "界面方案"; currentWsTitle = "Batona"
            pending = PendingFrame("question", "choice-rpc", questions = listOf(
                QuestionItem("answer", "select", "选择界面方案", options = listOf(
                    QuestionOption("a", "方案 A"), QuestionOption("b", "方案 B"),
                )),
            ))
        }
        var response: JsonObject? = null
        show(state) { response = it }
        compose.onNodeWithText("提交").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("方案 A").performScrollTo().performClick()
        compose.onNodeWithText("提交").performScrollTo().performClick()
        compose.runOnIdle {
            assertEquals("a", response?.get("answers")?.jsonArray?.first()?.jsonObject?.get("selected")?.jsonArray?.first()?.jsonPrimitive?.content)
            state.pending = PendingFrame("question", "text-rpc", questions = listOf(QuestionItem("answer", "text", "补充要求")))
        }
        compose.onNodeWithText("提交").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("输入你的答案…").performScrollTo().performTextInput("保留配对流程")
        compose.runOnIdle { state.connected = false }
        compose.onNodeWithText("提交").performScrollTo().assertIsNotEnabled()
        compose.runOnIdle { state.connected = true }
        compose.onNodeWithText("提交").performClick()
        compose.runOnIdle {
            assertEquals("保留配对流程", response?.get("answers")?.jsonArray?.first()?.jsonObject?.get("custom")?.jsonPrimitive?.content)
        }
    }
}
