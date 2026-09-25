package com.batona.mobile.ui

import android.app.Application
import android.graphics.Bitmap
import com.batona.mobile.ui.theme.BatonaTheme
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.batona.mobile.SettingsStore
import com.batona.mobile.data.AgentProfile
import com.batona.mobile.data.Binding
import com.batona.mobile.data.GatewayClient
import com.batona.mobile.data.ModelRef
import com.batona.mobile.data.SessionPermissionPresetOption
import com.batona.mobile.data.SessionPermissionPresetState
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Isolated UI fixtures: no login, saved credentials, or production requests. */
@RunWith(AndroidJUnit4::class)
class BackendNavigationTest {
    @get:Rule val compose = createComposeRule()

    private fun capture(name: String) {
        compose.waitForIdle()
        val app = ApplicationProvider.getApplicationContext<Application>()
        File(app.getExternalFilesDir(null), name).outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    @Test fun bottomNavigationOpensSeparateBackendPages() {
        val store = SettingsStore(ApplicationProvider.getApplicationContext<Application>())
        compose.setContent {
            BatonaTheme {
                HomeScreen(Binding("127.0.0.1"), token = "", store = store, onLogout = {})
            }
        }
        compose.onNodeWithTag("backend-page-dsh").assertIsDisplayed()
        compose.onNodeWithTag("agent-logo-dsh").assertIsDisplayed()
        capture("android-dsh-agent-icon.png")
        compose.onNodeWithText("模型", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText("Codex").performClick()
        compose.onNodeWithTag("backend-page-codex").assertIsDisplayed()
        compose.onNodeWithTag("agent-logo-codex").assertIsDisplayed()
        capture("android-codex-agent-icon.png")
        compose.onNodeWithTag("backend-page-dsh").assertDoesNotExist()
        compose.onNodeWithText("设备").assertDoesNotExist()
        compose.onNodeWithText("Claude Code").performClick()
        compose.onNodeWithTag("claude-code-placeholder").assertIsDisplayed()
        compose.onNodeWithTag("claude-code-placeholder").onChildren().assertCountEquals(0)
        compose.onNodeWithText("已注册设备（吊销后立即失效）").assertDoesNotExist()
        compose.onNodeWithTag("backend-page-codex").assertDoesNotExist()
        compose.onNodeWithText("设置").performClick()
        compose.onNodeWithText("当前版本：${com.batona.mobile.BuildConfig.VERSION_NAME}").assertIsDisplayed()
        compose.onNodeWithText("DSH").performClick()
        compose.onNodeWithTag("backend-page-dsh").assertIsDisplayed()
        compose.onNodeWithTag("claude-code-placeholder").assertDoesNotExist()
    }

    @Test fun codexChatKeepsModelPickerAndPermissionChoices() {
        val state = HomeState("codex").apply {
            connected = true
            currentId = "ui-fixture"
            currentTitle = "UI test conversation"
            currentWsTitle = "UI test workspace"
            models.add(ModelRef("codex", "test-model", displayName = "UI test model"))
            selectedModel = ModelRef("codex", "test-model", reasoningEffort = "high")
            profiles.addAll(listOf(
                AgentProfile("full-access", "完全访问", "", true),
                AgentProfile("help", "帮我审批", "", true),
                AgentProfile("ask", "请求批准", "", true),
            ))
        }
        val client = GatewayClient(Binding("127.0.0.1"), onPush = {}, onConnChange = {})
        compose.setContent {
            BatonaTheme {
                ChatTab(state, client, backend = "codex", onSelectSession = { _, _ -> },
                    onBack = {}, onToggle = {}, onNewSession = { _, _, _ -> }, onDeleteWs = {},
                    onArchive = {}, onNewWorkspace = {}, onAnswer = {}, onWsChanged = {})
            }
        }
        compose.onNodeWithTag("agent-logo-codex").assertDoesNotExist()
        compose.onNodeWithText("Codex").assertDoesNotExist()
        compose.onNodeWithText("本次请求的 Codex 权限").assertDoesNotExist()
        compose.onNodeWithText("UI test model").assertExists()
        compose.onNodeWithContentDescription("选择思考强度").assertIsDisplayed()
        compose.onNodeWithText("会话默认模型").assertDoesNotExist()
        compose.onNodeWithText("帮我审批").assertDoesNotExist()
        compose.onNodeWithContentDescription("选择权限").performClick()
        compose.onNodeWithText("Codex · 权限").assertIsDisplayed()
        compose.onNodeWithText("帮我审批").assertIsDisplayed()
        compose.onNodeWithText("完全访问").performClick()
        compose.onNodeWithText("切换为完全访问？").assertIsDisplayed()
        compose.onNodeWithText("确认完全访问").assertIsDisplayed()
        compose.onNodeWithText("取消").performClick()
        compose.onNodeWithText("Codex · 权限").assertIsDisplayed()
        compose.onNodeWithText("关闭").performClick()
        compose.onNodeWithText("Codex · 权限").assertDoesNotExist()
        compose.onNodeWithText("跟随电脑端").assertIsDisplayed()
        compose.onNodeWithTag("chat-input").performTextInput("unsent UI draft")
        compose.onNodeWithContentDescription("选择模型").performClick()
        compose.onNodeWithText("模型选择").assertIsDisplayed()
        compose.onAllNodesWithText("UI test model").assertCountEquals(2)
        compose.onNodeWithText("关闭").performClick()
        compose.onNodeWithText("unsent UI draft").assertIsDisplayed()
        client.disconnect()
    }

    @Test fun modelCardSelectsOnTapAndShowsOnlyFriendlyName() {
        val state = HomeState("codex").apply {
            connected = true
            selectedModel = ModelRef("openai", "gpt-6-sol", "high", "GPT-6 Sol")
            models.add(selectedModel!!)
            models.add(ModelRef("openai", "gpt-6-astra", "high", "GPT-6 Astra"))
        }
        var selected: ModelRef? = null
        compose.setContent { BatonaTheme { ModelsTab(state) { selected = it } } }
        compose.onNodeWithText("openai / gpt-6-sol").assertDoesNotExist()
        compose.onNodeWithText("应用").assertDoesNotExist()
        compose.onNodeWithText("已选").assertDoesNotExist()
        compose.onAllNodesWithContentDescription("当前模型").assertCountEquals(1)
        compose.onNodeWithTag("model-option-openai-gpt-6-astra").performClick()
        compose.runOnIdle { org.junit.Assert.assertEquals("gpt-6-astra", selected?.model) }
    }

    @Test fun scannerOccupiesFullHeightAndCanBeClosed() {
        var closed = false
        compose.setContent { BatonaTheme { FullScreenScanner(onDetected = {}, onDismiss = { closed = true }) } }
        compose.onNodeWithTag("scanner-fullscreen").assertIsDisplayed().assertHeightIsAtLeast(500.dp)
        compose.onNodeWithContentDescription("关闭扫码").performClick()
        compose.runOnIdle { org.junit.Assert.assertTrue(closed) }
    }

    @Test fun dshChatAddsSessionPermissionBeforeModelAndConfirmsFullAccess() {
        val state = HomeState("dsh").apply {
            connected = true
            currentId = "dsh-ui-fixture"
            currentTitle = "DSH permission test"
            currentWsTitle = "Workspace"
            listOf("off", "low", "high", "max").forEach { effort ->
                models.add(ModelRef("dsh", "test-model", effort, "DSH test model"))
            }
            selectedModel = ModelRef("dsh", "test-model", "high", "DSH test model")
            dshPermissionBySession[currentId!!] = SessionPermissionPresetState(
                supported = true,
                currentValue = "workspace-write",
                options = listOf(
                    SessionPermissionPresetOption("read-only", "只读", "只读权限，不允许修改工作区文件。", true),
                    SessionPermissionPresetOption("workspace-write", "工作区写入", "允许在工作区内修改；需要审批的操作仍会请求确认。", true),
                    SessionPermissionPresetOption("danger-full-access", "完全访问", "移除沙箱限制并跳过工具审批。", true),
                ),
            )
        }
        val client = GatewayClient(Binding("127.0.0.1"), onPush = {}, onConnChange = {})
        compose.setContent {
            BatonaTheme {
                ChatTab(state, client, backend = "dsh", onSelectSession = { _, _ -> },
                    onBack = {}, onToggle = {}, onNewSession = { _, _, _ -> }, onDeleteWs = {},
                    onArchive = {}, onNewWorkspace = {}, onAnswer = {}, onWsChanged = {})
            }
        }
        compose.onNodeWithTag("agent-logo-dsh").assertDoesNotExist()
        compose.onNodeWithContentDescription("选择DSH权限").assertIsDisplayed().performClick()
        compose.onNodeWithText("DSH · 权限").assertIsDisplayed()
        compose.onAllNodesWithText("工作区写入").assertCountEquals(2)
        compose.onNodeWithText("完全访问").performClick()
        compose.onNodeWithText("切换为完全访问？").assertIsDisplayed()
        compose.onNodeWithText("确认完全访问").assertIsDisplayed()
        compose.onNodeWithText("取消").performClick()
        compose.onNodeWithText("DSH · 权限").assertIsDisplayed()
        compose.onNodeWithContentDescription("选择模型").assertIsDisplayed()
        compose.onNodeWithContentDescription("选择思考强度").performClick()
        compose.onNodeWithText("DSH · 思考强度").assertIsDisplayed()
        listOf("off", "low", "high", "max").forEach { effort ->
            compose.onNodeWithTag("effort-option-$effort").assertIsDisplayed()
        }
        client.disconnect()
    }
}
