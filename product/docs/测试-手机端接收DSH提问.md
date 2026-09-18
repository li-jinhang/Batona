# 测试案例：手机端接收 DSH 提问（question/requested）

> 目的：验证手机端能**接收并显示 DSH 对用户的提问**，并在回答后让 agent 继续。
> 关联需求：FR-14（提问应答）· 网关归一化 `normalizeQuestions` · 手机端状态点（waiting-question 亮黄点）

---

## 一、前置条件

| 项 | 要求 |
|---|---|
| 网关 | 已部署最新版（含 `normalizeQuestions`，`server-gateway.tar.gz`） |
| 手机 App | 已装 **DSHLink-v0.1.28**（含提问卡片渲染 + 会话状态点） |
| DSH | 笔记本 `dsh web` 运行中，隧道在线（三灯全绿） |
| 手机 | 已登录、能打开会话并收发消息 |

> 若网关未更新：提问仍收不到（归一化在网关侧）。务必先 `install.sh --update`。

---

## 二、测试用例

### 用例 1：选择型提问（最推荐，稳定触发）

**测试消息**（在手机端某个会话里发送）：
```
请用 ask_user_question 工具向我提问，让我从「方案A」和「方案B」两个选项中选择，用于测试手机端提问展示。
```

**预期**：
1. 发送后 agent 开始处理（会话状态 → running）
2. 手机端**弹出提问卡片**，显示提问标题与「方案A」「方案B」两个选项按钮
3. 会话行（列表）该会话状态点变为**黄点**（waiting-question）
4. 取消/不答时 agent 等待；点某个选项后：

**回答后预期**：
5. 点「方案A」→ 答案发回 agent → agent 继续对话
6. 会话状态点恢复（done 绿点 / idle 灰点）
7. 网关侧无报错（`journalctl -u dsh-gateway`）

### 用例 2：文本型提问

**测试消息**：
```
请用 ask_user_question 工具向我提一个开放性问题（不提供选项），用于测试文本输入。
```

**预期**：
- 提问卡片显示输入框（非选项按钮）
- 输入文字确认后，agent 收到答案继续

### 用例 3：真实业务场景（自然地触发提问）

**测试消息**：
```
我需要清理磁盘，但不确定要清理哪个目录。请先向我确认要清理 D:\_Projects 还是 D:\Downloads，再开始。
```

**预期**：
- agent 在动手清理前调用 ask_user_question 澄清
- 手机端弹出"选择目录"提问，点选后 agent 才继续执行

---

## 三、验证步骤（用例 1 详细）

1. 手机打开会话 A（或新建会话）
2. 发用例 1 的测试消息
3. 观察聊天区：几秒内出现**提问卡片**（标题 + 「方案A」「方案B」按钮）
4. 观察会话列表 A 的副标题：状态点应为**黄点**
5. 点「方案A」
6. 观察：agent 继续回复；会话列表状态点变回（绿/灰）

---

## 四、失败排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 提问卡片不出现 | 网关未更新（缺归一化） | `install.sh --update` 部署最新网关 |
| 提问卡片空白/无按钮 | App 非 v0.1.28 | 装 v0.1.28 |
| 提问出现但点选项无反应 | 应答链路问题 | 看 `journalctl -u dsh-gateway`；App logcat `DSHLINK` |
| 会话状态点始终不变 | 网关状态未同步 | 看网关 `session/event` 是否推送 `waiting-question` |
| 消息后 DSH 未提问 | DSH 没调用 ask_user_question | 换用用例 1 措辞（明确要求用 ask_user_question 工具） |

---

## 五、系统验证点（对应本次修复）

- ✅ 网关 `normalizeQuestions`：DSH `{question,header,options:[{label,description}]}` → `{kind,prompt,options:[{id,label}]}`
- ✅ App `handlePush` question 分支正常反序列化并显示提问
- ✅ 会话状态点：`waiting-question`/`waiting-approval` 亮**黄点**，`done` 亮**绿点**

---

## 六、参考测试消息模板（可复制）

```
# 选择型
请用 ask_user_question 工具让我从「方案A」和「方案B」中选择。

# 文本型
请用 ask_user_question 工具向我提出一个开放性问题。

# 业务型（澄清后再做）
我接下来要清理磁盘。动手前请先用 ask_user_question 问我清哪个目录：D:\_Projects 还是 D:\Downloads。
```
