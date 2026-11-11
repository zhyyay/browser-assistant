# Native Messaging 协议

每条消息由 4 字节本机字节序无符号长度头和 UTF-8 JSON 正文组成，最大 8 MiB。

## 请求

```json
{ "id": "request-1", "command": "ping", "params": {} }
```

## 响应

```json
{ "id": "request-1", "ok": true, "result": { "message": "pong" } }
```

## 命令流程

页面操作由扩展发起前，先向 Rust Host 请求 `authorize_command`。Rust Host 校验动作是否在允许列表中，扩展收到授权后才在当前活动标签页执行。这样 Rust Host 参与每次命令的授权与响应。

支持动作：`get_page_info`、`get_dom_text`、`find_elements`、`get_x_posts`、`get_following`、`get_element_rect`、`click`、`type_text`、`scroll`。

### X 推文解析

请求示例：`{"id":"x-posts-1","command":"get_x_posts","params":{"limit":20}}`。仅解析当前活动 X 页面已加载的 `article[data-testid="tweet"]`，不自动滚动；`limit` 默认 20，范围 1–100。响应 `result` 为 JSON 对象，包含 `page`、`count`、`requested_limit` 和 `posts`。每条推文包含 `id`、`url`、`text`、`author`、`created_at`、`metrics` 与 `actions`。无法从页面读取的字段返回 `null`，不会猜测。

当前 Native Messaging 通道由 Chrome 扩展启动 Rust Host。Rust 桌面程序主动发起浏览器命令所需的本机 IPC 服务仍是后续工作；当前版本不能宣称已经实现独立 Rust 桌面端到浏览器的主动控制。

### X Following 互关检测

Rust 客户端调用 `BrowserClient::get_following()`。扩展每轮读取当前 Following 页面中最多 30 个 `[data-testid="UserCell"]` 用户卡片，并向下滚动一屏的一部分；Rust 客户端以 2–4 秒间隔调用下一轮，每 10 轮额外休息 15–30 秒。用户名去重，结束后一次性返回 JSON，不使用 SQLite。

执行前校验当前地址必须是 `https://x.com/{username}/following`。其他页面会返回错误，不执行滚动或扫描。回关状态为 `mutual`（识别到「关注了你」或 “Follows you”）、`not_mutual`（已识别账号但没有该标记）或 `unknown`（无法解析用户名）。结果包含 `page`、`scan_complete`、`stop_reason`、`total`、`scanned`、三类计数和 `users` 数组。若连续 5 轮没有新增账号，会停止并将 `scan_complete` 标记为 `false`，避免把不完整结果伪装成完整扫描；检测到限流提示则立即返回错误。
