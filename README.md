# 浏览器助手（Browser Assistant）

一个面向 Rust 应用的 Chrome 浏览器自动化助手。采用 Chrome Extension（Manifest V3）+ Rust Native Messaging Host，逐步提供网页 DOM 读取、元素定位和受控交互能力。

## 当前状态

v0.1.0 基础骨架：Chrome MV3 扩展、Rust Native Messaging Host、Rust 协议核心，以及当前活动标签页的 DOM 读取与元素操作入口。Rust 桌面控制端主动调度浏览器所需的本机 IPC 将在后续阶段实现。

## 架构

```text
Chrome Extension -- Native Messaging --> Rust Native Host --> browser-core
```

扩展默认只在用户主动操作后访问当前活动标签页，不遍历个人标签页。

## 构建

```powershell
cargo build --workspace
```

## 加载扩展

打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，选择 `extension` 目录。

## 安全

使用 `activeTab` 限定页面访问；不读取 Cookie、密码或浏览器个人资料。Native Host 的 `allowed_origins` 必须限制为实际扩展 ID。自动化行为应遵守目标网站服务条款。

## License

当前尚未指定开源许可证。明确许可证前，不应默认拥有复制、修改或分发本项目的权利。
