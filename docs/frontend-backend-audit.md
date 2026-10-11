# 前后端功能核对

检查日期：2026-10-11。范围：当前静态前端、API 路由、请求/响应模型、服务与数据库模型。

## 结论

删除“搜索对话”后，前端 `WorkspaceApi` 的全部 10 个接口调用均有对应后端路由和业务实现，没有发现调用不存在接口的按钮。

现有功能中，明确缺少后端持久化支持的是**回复的模型名称和 token 用量在历史对话中的恢复**。退出登录、模型偏好目前采用浏览器本地实现；若要求服务端失效或跨设备同步，还需要补充后端能力。

## 已有后端实现的功能

| 前端功能 | 后端接口 | 实现情况 |
| --- | --- | --- |
| 注册 | `POST /users/register` | 用户保存、密码哈希、重复邮箱检查 |
| 登录 | `POST /auth/login` | 密码验证、账户状态检查、JWT 签发 |
| 账户信息 | `GET /users/me` | 返回当前用户信息 |
| 最近对话、刷新 | `GET /conversations` | 按用户过滤并按更新时间排序 |
| 新对话 | `POST /conversations` | 保存标题；前端在首次发送时创建 |
| 打开历史对话 | `GET /conversations/{id}` | 检查归属并返回按时间排序的消息 |
| 发送消息、思考强度 | `POST /conversations/{id}/chat` | 调用 OpenRouter，传递历史与思考强度，成功后保存双方消息 |
| 读取密钥配置状态 | `GET /providers/openrouter` | 返回配置元数据，不返回密钥 |
| 保存、替换密钥 | `PUT /providers/openrouter` | 加密保存用户的密钥 |
| 移除密钥 | `DELETE /providers/openrouter` | 删除用户的密钥记录 |

对应代码：[`api.js`](../src/ai_workspace/static/api.js)、[`routes`](../src/ai_workspace/api/routes)、[`services`](../src/ai_workspace/services)。

## 前端已有行为，后端支持尚不完整

### 1. 历史回复的模型和 token 信息没有保存

前端 `renderMessages()` 会展示 `message.model` 和 `message.usage.total_tokens`，刚发送后的聊天响应包含这些字段。但 `ChatService.complete_turn()` 保存消息时只有角色和正文；`Message` 数据表及 `MessageResponse` 均没有 `model`、`usage` 字段。因此刷新后重新打开历史对话，正文仍在，模型名称和 token 用量消失。

补齐方向：为助手消息保存返回的模型和可空 usage，并在详情响应中返回；旧消息保留未知值。

依据：[`app.js`](../src/ai_workspace/static/app.js)、[`chat.py`](../src/ai_workspace/services/chat.py)、[`message.py`](../src/ai_workspace/models/message.py)、[`conversation.py`](../src/ai_workspace/schemas/conversation.py)。

### 2. 退出登录仅清理当前浏览器标签页

前端 `clearSession()` 清除内存及 `sessionStorage` 中的 JWT，不调用退出接口。后端只有登录接口，没有注销、令牌撤销或刷新令牌机制；现有 JWT 在过期前仍可能通过验证。当前本地退出行为已经实现；如果产品要求退出后原令牌立即失效，需要新增服务端会话或撤销机制。

依据：[`app.js`](../src/ai_workspace/static/app.js)、[`auth.py`](../src/ai_workspace/api/routes/auth.py)、[`tokens.py`](../src/ai_workspace/core/tokens.py)。

### 3. 模型和思考强度偏好仅保存在当前浏览器

前端将选择保存为 `localStorage` 中的 `workspace-model`、`workspace-effort`，不按登录用户隔离。后端接受每次聊天传入的配置，但没有用户或对话级偏好字段与读写接口。同一浏览器切换账户会沿用选择，换设备不会同步；重新打开某段对话也不会恢复该对话使用的配置。

当前本地偏好行为已经实现；账号隔离、跨设备同步或对话级恢复需要另行补齐。

依据：[`app.js`](../src/ai_workspace/static/app.js)、[`chat.py`](../src/ai_workspace/schemas/chat.py)、[`conversation.py`](../src/ai_workspace/models/conversation.py)。

## 其他联调边界

- **密钥已配置不等于密钥有效**：保存接口只做格式约束和加密保存，不请求上游验证密钥、余额或模型权限。当前 UI 显示“已配置”；真正能否调用在聊天时才确认。前端目前没有“测试连接”按钮。
- **模型兼容性没有预校验**：前端手填模型 ID，提供所有思考强度选项；后端没有模型目录或能力查询接口，直接向上游传递选择。不兼容时返回通用模型请求失败提示。
- **历史消息角色处理存在前端问题**：详情 API 已返回 `role`，但 `conversationMessages()` 仍按数组下标强制交替赋予 user/assistant，覆盖服务端角色。普通串行双消息保存时可工作；遇到其他角色或非交替历史会显示错误。这属于前端契约处理问题。
- **并发发送没有服务端排序保护**：前端只禁用当前页面的发送操作；后端未串行化同一对话的并发请求，也没有幂等请求标识。多标签页发送或断网后重发的顺序和去重仍需完善。

流式输出、停止生成、对话重命名/删除、账户资料编辑/删除、附件和多提供商目前都没有完整前端入口，因此不计入“前端已完成但后端未实现”。

## 本次修改与验证

- 删除搜索菜单、搜索框、搜索图标、标题过滤、事件监听和专用样式，更新 README 及已有浏览器回归脚本。
- 前端 API 测试：6 项通过；JavaScript 语法及 Git diff 检查通过。
- 现有 Playwright 浏览器回归通过，覆盖桌面/移动端、登录注册、密钥配置、模型设置、聊天与历史、失败恢复和退出/过期。
- 不依赖数据库的后端测试：98 项通过；Ruff 检查和格式检查通过。
- 浏览器回归 mock 了业务接口，后端适配器测试也未调用真实模型。本次未运行 PostgreSQL 集成测试或真实 OpenRouter 请求，不能据此确认实际部署的数据库与上游连通性。
