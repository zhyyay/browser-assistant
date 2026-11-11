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

支持动作：`get_page_info`、`get_dom_text`、`find_elements`、`get_element_rect`、`click`、`type_text`、`scroll`。

当前 Native Messaging 通道由 Chrome 扩展启动 Rust Host。Rust 桌面程序主动发起浏览器命令所需的本机 IPC 服务仍是后续工作；当前版本不能宣称已经实现独立 Rust 桌面端到浏览器的主动控制。
