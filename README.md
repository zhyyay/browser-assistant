# 浏览器助手（Browser Assistant）

一个面向 Rust 应用的 Chrome 浏览器自动化助手。采用 Chrome Extension（Manifest V3）+ Rust Native Messaging Host + 本机 IPC，提供网页 DOM 读取、元素定位和受控交互能力。

## 当前状态

v0.2.0：在基础扩展与 Native Messaging 上增加 Rust 桌面端 IPC。桌面 Rust 程序可通过本机 Named Pipe（Windows）或 Unix domain socket 向 Native Host 发送浏览器命令，再由扩展执行并返回结果。

## 架构

```text
Rust desktop client -> local IPC -> Rust Native Messaging Host
                   -> Chrome extension -> active page DOM
```

Native Messaging 与桌面 IPC 是两条独立通道。桌面端不会直接读写 Chrome 提供给 Native Host 的 stdin/stdout。

## 构建

```powershell
cargo build --workspace
```

## 加载扩展

打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，选择 `extension` 目录。

## Rust 桌面端接入

```toml
browser-assistant-client = { path = "../browser-assistant/crates/browser-client" }
browser-core = { path = "../browser-assistant/crates/browser-core" }
```

```rust
use browser_assistant_client::BrowserClient;
use browser_core::BrowserCommand;

let mut browser = BrowserClient::connect()?;
let response = browser.execute(BrowserCommand::GetPageInfo)?;
```

完整协议、Token 位置和限制见 [docs/ipc.md](docs/ipc.md)。

## 安全

使用 `activeTab` 限定页面访问；不读取 Cookie、密码或浏览器个人资料。桌面 IPC 使用本机套接字和 per-user token；Native Host 的 `allowed_origins` 必须限制为实际扩展 ID。自动化行为应遵守目标网站服务条款。

## License

当前尚未指定开源许可证。明确许可证前，不应默认拥有复制、修改或分发本项目的权利。
