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

- 扩展仅声明当前功能需要的 `activeTab`、`scripting`、`tabs` 和 `nativeMessaging` 权限；不申请 `cookies`、`webRequest`、`debugger`、`history`、`downloads` 或广泛站点访问权限。
- 扩展代码不调用 Cookie API，不读取 `document.cookie`、`localStorage` 或 `sessionStorage`；Native Host 不访问 Chrome 用户数据目录或浏览器 Cookie 数据库。
- 扩展代码不包含向第三方发送页面数据的网络请求逻辑；网页自身为正常加载内容而发出的请求不属于扩展的数据上传。
- Native Messaging Host 安装清单将 `allowed_origins` 限定为安装时传入的单个 Chrome 扩展 ID。安装脚本会校验扩展 ID 格式。
- 桌面 IPC 使用本机套接字和 per-user token。请勿分享 `%LOCALAPPDATA%\BrowserAssistant\ipc.token`；能读取该 Token 的本机进程可能调用浏览器自动化接口。
- Native Host 以当前 Windows 用户身份运行，因此它仍拥有该用户的常规文件和进程权限。请只运行可信的桌面客户端和 Host 程序。

更完整的审计范围和安全边界见 [docs/security.md](docs/security.md)。

## License

当前尚未指定开源许可证。明确许可证前，不应默认拥有复制、修改或分发本项目的权利。
