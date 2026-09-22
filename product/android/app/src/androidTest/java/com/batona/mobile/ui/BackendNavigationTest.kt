package com.batona.mobile.ui

import android.app.Application
import com.batona.mobile.ui.theme.BatonaTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.batona.mobile.SettingsStore
import com.batona.mobile.data.AgentProfile
import com.batona.mobile.data.Binding
import com.batona.mobile.data.GatewayClient
import com.batona.mobile.data.ModelRef
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Isolated UI fixtures: no login, saved credentials, or production requests. */
@RunWith(AndroidJUnit4::class)
class BackendNavigationTest {
    @get:Rule val compose = createComposeRule()

    @Test fun bottomNavigationOpensSeparateBackendPages() {
        val store = SettingsStore(ApplicationProvider.getApplicationContext<Application>())
        compose.setContent {
            BatonaTheme {
                HomeScreen(Binding("127.0.0.1"), token = "", store = store, onLogout = {})
            }
        }
        compose.onNodeWithTag("backend-page-dsh").assertIsDisplayed()
        compose.onNodeWithText("模型", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText("Codex").performClick()
        compose.onNodeWithTag("backend-page-codex").assertIsDisplayed()
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
                AgentProfile("full", "完全访问", "", true),
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
        compose.onNodeWithText("本次请求的 Codex 权限").assertDoesNotExist()
        compose.onNodeWithText("UI test model · high").assertIsDisplayed()
        compose.onNodeWithText("会话默认模型").assertDoesNotExist()
        compose.onNodeWithText("帮我审批").assertDoesNotExist()
        compose.onNodeWithContentDescription("选择权限").performClick()
        compose.onNodeWithText("Codex · 权限").assertIsDisplayed()
        compose.onNodeWithText("帮我审批").assertIsDisplayed()
        compose.onNodeWithText("请求批准").performClick()
        compose.onNodeWithText("Codex · 权限").assertDoesNotExist()
        compose.onNodeWithText("请求批准").assertIsDisplayed()
        compose.onNodeWithText("补充你的要求…").performTextInput("unsent UI draft")
        compose.onNodeWithContentDescription("选择模型").performClick()
        compose.onNodeWithText("Codex · 选择模型").assertIsDisplayed()
        compose.onNodeWithText("UI test model").assertIsDisplayed()
        compose.onNodeWithText("关闭").performClick()
        compose.onNodeWithText("unsent UI draft").assertIsDisplayed()
        client.disconnect()
    }
}
