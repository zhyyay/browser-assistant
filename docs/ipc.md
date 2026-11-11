# Rust 桌面端 IPC

## 通信链路

```text
Rust desktop client
  -- local socket (Windows named pipe / Unix domain socket) -->
Rust Native Messaging Host
  -- Chrome Native Messaging (4-byte length + JSON) -->
Chrome extension service worker
  -- chrome.scripting.executeScript -->
Active HTTP/HTTPS tab
```

Native Messaging 和桌面 IPC 是独立通道。Chrome 启动 Native Host 时提供的 stdin/stdout 只用于扩展与 Host 通信，桌面程序不直接访问它们。

## IPC 约定

- 套接字名：`zhyyay.browser-assistant.v1`；Windows 使用 Named Pipe，其他支持平台使用 Unix domain socket。
- 请求和响应为单行 UTF-8 JSON，以换行符分帧；单条请求最大 1 MiB。
- 每个请求包含唯一 `id`，响应回传相同的 `id`。
- 每条 IPC 请求都校验 per-user token。
- Windows Token 路径：`%LOCALAPPDATA%\\BrowserAssistant\\ipc.token`。
- 其他平台：XDG 配置目录或 `~/.config/browser-assistant/ipc.token`。
- 首次启动 Host 时创建 Token；桌面端在 Chrome 扩展已连接后读取它。

请求示例：

```json
{
  "token": "<per-user-token>",
  "request": { "id": "desktop-123-1", "command": "get_page_info", "params": {} }
}
```

响应示例：

```json
{
  "id": "desktop-123-1",
  "ok": true,
  "result": { "url": "https://example.com", "title": "Example", "ready_state": "complete" }
}
```

## Rust 客户端示例

桌面应用 Cargo.toml：

```toml
browser-assistant-client = { path = "../browser-assistant/crates/browser-client" }
browser-core = { path = "../browser-assistant/crates/browser-core" }
```

调用：

```rust
use browser_assistant_client::BrowserClient;
use browser_core::BrowserCommand;

let mut browser = BrowserClient::connect()?;
let response = browser.execute(BrowserCommand::GetPageInfo)?;
if !response.ok {
    anyhow::bail!("{}", response.error.unwrap_or_else(|| "browser command failed".into()));
}
println!("{}", response.result.unwrap_or_default());
```

## 生命周期与限制

- 必须先由 Chrome 扩展启动 Native Host；Host 不会自行启动 Chrome。
- 每条 IPC 连接只处理一条请求；Rust 客户端在每次 execute 后关闭连接，并在下一条命令时自动重连。
- 单条浏览器命令等待上限 45 秒。
- 命令作用于 Chrome 最后聚焦窗口的活动 HTTP/HTTPS 标签页。
- 允许 DOM 读取、元素查找、坐标获取、点击、输入和滚动；Host 与扩展两侧均校验命令白名单。
- 当前尚未实现窗口/标签组 session 管理，也不保证页面交互完全不影响前台焦点。

## 安全说明

IPC 仅使用本机 Named Pipe / Unix domain socket，不开放 TCP 端口。请求还需携带 per-user token。Windows Token 文件放在当前用户 LocalAppData 目录，使用该目录继承的文件 ACL。仍需在实际 Windows 环境验证 ACL、并发启动和进程生命周期。
