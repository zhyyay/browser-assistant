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

Rust 客户端调用 `BrowserClient::get_following()` 获取扫描 JSON；调用 `BrowserClient::get_not_following_back()` 则只返回未回关用户数组，并且仅在 `scan_complete=true` 时返回，避免把部分扫描结果误当成完整名单。实现位于 `crates/browser-client/src/x/following.rs`。扩展弹窗提供「扫描没有回关我的用户」按钮。扫描结果直接返回 JSON，不使用 SQLite。

执行前以及每一轮扫描前都会校验目标仍是原来的 `https://x.com/{用户名}/following` 页面。每轮读取当前 DOM 中全部 `[data-testid="UserCell"]`，不再固定截取前 30 个；按用户名去重，并优先用后续识别出的明确状态更新之前的 unknown 记录。滚动定位到最后一个已加载用户卡片附近，滚动后观察列表 DOM 变化，再进入下一轮，以减少固定滚动距离造成的重复读取。

扫描最多 100 轮。普通页面加载或浏览器请求错误最多重试 3 次；每轮之间约等待 1.8–3 秒，每 8 轮额外休息约 12–32 秒。连续没有新增用户时，还会结合滚动是否停滞判断，不会仅凭重复卡片立即判定到底。连续滚动停滞或达到轮数上限会以未完成状态返回。

异常策略：
- Following 列表首次加载最多等待 10 秒；超时记为 `page_load_timeout`。
- 单张用户卡片解析失败会记录到 `errors`，继续处理其他卡片。
- 扫描期间 URL 变化或标签页关闭会停止任务。
- 检测到限流提示（如 429/请求过于频繁）或安全验证页面时立即停止，不自动重试。
- 普通加载/请求异常最多重试 3 次；重试耗尽后停止。
- 所有可恢复的停止路径尽量保留已经扫描到的用户。

扫描结果包含 `success`、`page`、`scan_complete`、`stop_reason`、`total`、`scanned`、`mutual_count`、`not_following_back_count`、`unknown_count`、`rounds`、`retry_count`、`users` 和 `errors`。其中 `users` 在完整扫描结果中包含所有识别到的用户；扩展弹窗结果中的 `users` 仅包含未回关用户。若 `scan_complete=false`，必须把结果视为部分结果，不能当作完整 Following 清单。
