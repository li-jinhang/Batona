package com.dshlink.app

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

/**
 * 手机只显示状态型本地通知，不将模型输出、命令、路径或审批理由放进系统通知栏。
 * WebSocket 未运行时不伪造后台推送；恢复连接后由权威会话快照同步状态。
 */
object AgentNotification {
    private const val CHANNEL_ID = "agent-status"

    fun post(context: Context, kind: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Agent 状态", NotificationManager.IMPORTANCE_DEFAULT))
        val (title, text) = when (kind) {
            "approval" -> "需要审批" to "一个 Agent 操作正在等待你的决定"
            "question" -> "需要回答" to "一个 Agent 会话正在等待你的输入"
            "failed" -> "任务失败" to "一个 Agent 会话执行失败，请打开应用查看"
            else -> "任务完成" to "一个 Agent 会话已完成"
        }
        val notification = android.app.Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .build()
        manager.notify(kind.hashCode(), notification)
    }
}
