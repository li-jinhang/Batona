package com.batona.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Test

class GatewayFailureTest {
    @Test
    fun nativeControlFailuresExplainThatCodexMustBeCheckedBeforeRetrying() {
        assertEquals(
            "电脑端 Codex 界面操作失败。请先查看电脑端会话状态，再决定是否重试。",
            GatewayFailure("native-control-failed:composer-write:ArgumentException").message,
        )
    }

    @Test
    fun unconfirmedSendWarnsAgainstDuplicateSubmission() {
        assertEquals(
            "电脑端未能确认发送结果。请先查看 Codex 会话，避免重复发送。",
            GatewayFailure("native-control-failed:confirm-submission:ArgumentException").message,
        )
    }

    @Test
    fun permissionErrorsDescribeAnUncertainSettingRatherThanAStoredDraft() {
        assertEquals(
            "无法确认电脑端当前 Codex 任务。若权限标签已变化，请刷新核对后再重试。",
            permissionFailureMessage(GatewayFailure("native-task-identity-mismatch")),
        )
        assertEquals(
            "权限切换结果尚未确认，请刷新核对电脑端当前档位。",
            permissionFailureMessage(GatewayFailure("bridge-error")),
        )
    }
}
