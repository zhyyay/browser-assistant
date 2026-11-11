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

支持动作：`get_page_info`、`get_dom_text`、`find_elements`、`get_x_posts`、`post_x_tweet`、`reply_to_x_post`、`get_following`、`get_element_rect`、`click`、`type_text`、`scroll`。

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

### X 时间线推文回复

Rust 客户端可调用 `BrowserClient::reply_to_x_post(post_id, text)` 回复当前已加载时间线中的指定推文。先调用 `get_x_posts()` 获取推文列表，再将目标推文的数字 `id` 和回复文本传入。扩展按 `/status/{post_id}` 精确定位对应的 `article[data-testid="tweet"]`，只点击该推文自己的回复按钮；不会用列表序号或猜测坐标替代 ID。打开回复窗口后，还会核对窗口内包含相同推文 ID，再定位编辑框、通过 CDP 输入并回读验证，最后点击一次提交按钮。

响应成功时 `result.status = "sent"`、`confirmed = true`，并包含 X 页面返回的 `confirmation` 文本和 `post_id`。点击提交后若未检测到成功提示，则返回 `confirmation_unknown`、`submitted = true`、`confirmed = false`；调用方不得自动重试，避免重复回复。推文不在当前已加载 DOM、ID 无效、回复按钮不可用、窗口目标不匹配、限流或安全验证时会在提交前报错。该流程不读取 Cookie 或登录凭据，且不绕过 X 的限流或安全验证。

### X 自动发帖

Rust 客户端可调用 `BrowserClient::post_x_tweet(content)` 发布文本推文。Native Messaging 命令为 `post_x_tweet`，参数为 `{"text":"要发布的内容"}`。执行前要求当前活动页面位于 `x.com)，且页面存在可见、可用的 X 发帖编辑框。

执行流程：每次任务开始时随机打乱三种编辑框入口并依次尝试：①通过 CDP 向 X 侧边栏「主页」派发鼠标事件；②通过 Chrome 标签页导航 API 打开 `https://x.com/compose/post`；③进入 `https://x.com/home` 并通过 CDP 滚轮事件滚动到页面顶部。每种入口都等待目标 URL 和发帖编辑框实际加载后才继续；某个入口失败可尝试下一个。找到编辑框后统一检查页面与安全验证/限流提示 → 鼠标点击编辑框 → `Ctrl+A` → `Backspace` 清空旧内容 → 通过 CDP 的 Input.insertText 输入新内容 → 从 DOM 回读校验 → 通过 CDP 鼠标事件点击一次发帖按钮 → 等待 X 的发送成功提示。每次输入都会先清空目标输入框，避免重复测试时旧内容残留。提交按钮点击后绝不切换入口或自动重试，以免重复发帖。成功响应还会返回 `entry_strategy` 和 `attempted_strategies`，用于诊断本次采用的入口。成功响应的 `result.status` 为 `sent`；若按钮已点击但无法确认成功，返回 `confirmation_unknown`（`submitted=true`）。这种不确定状态不得自动重试，以免重复发帖。提交前的错误会返回明确错误码，例如 `PAGE_CHANGED`、`INVALID_CONTENT`、`COMPOSER_NOT_FOUND`、`COMPOSER_NOT_EMPTY`、`CONTENT_VERIFY_FAILED` 或 `SUBMIT_BUTTON_NOT_FOUND`。

该接口不读取 Cookie、密码或浏览器登录凭据；由当前 X 页面自身的登录状态完成发帖。调用方应在提交前向用户展示待发布内容并取得明确授权。


### CDP 浏览器输入

网页点击、文本输入和滚动统一由 Chrome 扩展通过 `chrome.debugger` 调用 Chrome DevTools Protocol（CDP）的 `Input.dispatchMouseEvent`、`Input.dispatchKeyEvent`、`Input.insertText` 执行。操作坐标使用网页视口 CSS 像素，不换算 Windows 屏幕坐标，也不激活目标窗口、不移动 Windows 全局鼠标或键盘。导航使用 `chrome.tabs.update`，DOM 读取和操作前的目标定位仍由扩展脚本完成。

扩展需要新增 Chrome `debugger` 权限。首次附加调试器时，Chrome 可能显示“扩展程序正在调试此浏览器”提示；调试器被 DevTools 或其他扩展占用时，CDP 操作会明确失败，不会回退到系统级输入。CDP 连接按标签页复用；每个标签页的点击、输入和滚动序列会串行执行，避免并发 Rust 请求交叉发送鼠标/键盘事件。Service Worker 重启后，会先通过 chrome.debugger.getTargets() 检查目标，再用 Browser.getVersion 探测已有会话；只有确认当前扩展可继续使用该会话时才复用，否则明确报错，不会把其他扩展或 DevTools 的连接误当作自己的连接。标签页关闭或调试器分离后清理状态。

Native Host 不再提供 `desktop_input`，Windows `SendInput` 模块从正常编译和调用链移除。当前改造不读取 Cookie、密码或浏览器登录凭据。后台标签页是否能完成具体交互仍取决于网页自身行为；CDP 不等于完全隐身或绕过网站风控。

