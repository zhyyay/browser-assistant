use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    sync::mpsc::{self, Sender},
    thread,
    time::Duration,
};
use anyhow::{Context, Result};
use browser_core::{
    ipc::{ipc_token_path, IpcEnvelope, IPC_MAX_LINE_BYTES, IPC_SOCKET_NAME},
    BrowserCommand, BrowserRequest, BrowserResponse,
};
use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions};
use serde_json::{json, Value};
use uuid::Uuid;


const MAX_MESSAGE_SIZE: usize = 8 * 1024 * 1024;
const ALLOWED_ACTIONS: &[&str] = &[
    "open_automation_window", "get_page_info", "reload_page", "get_dom_text", "find_elements", "get_x_posts", "post_x_tweet", "reply_to_x_post", "get_following",
    "get_element_rect", "click", "type_text", "scroll",
];

enum HostEvent {
    ExtensionMessage(Value),
    DesktopRequest { request: BrowserRequest, reply: Sender<Value> },
    ExtensionDisconnected,
}

fn read_message<R: Read>(reader: &mut R) -> Result<Option<Value>> {
    let mut header = [0_u8; 4];
    let mut offset = 0;
    while offset < header.len() {
        match reader.read(&mut header[offset..])? {
            0 if offset == 0 => return Ok(None),
            0 => anyhow::bail!("unexpected EOF in Native Messaging header"),
            count => offset += count,
        }
    }
    let length = u32::from_ne_bytes(header) as usize;
    if length == 0 || length > MAX_MESSAGE_SIZE {
        anyhow::bail!("invalid Native Messaging frame length: {length}");
    }
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload).context("reading Native Messaging payload")?;
    Ok(Some(serde_json::from_slice(&payload).context("decoding Native Messaging JSON")?))
}

fn write_message<W: Write>(writer: &mut W, value: &Value) -> Result<()> {
    let payload = serde_json::to_vec(value)?;
    if payload.len() > MAX_MESSAGE_SIZE {
        anyhow::bail!("response exceeds maximum frame length");
    }
    writer.write_all(&(payload.len() as u32).to_ne_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()?;
    Ok(())
}

fn response(id: Option<String>, ok: bool, result: Option<Value>, error: Option<String>) -> Value {
    serde_json::to_value(BrowserResponse { id, ok, result, error })
        .expect("BrowserResponse serialization should not fail")
}

fn handle_message(message: Value) -> Value {
    let id = message.get("id").and_then(Value::as_str).map(str::to_owned);
    let command = message.get("command").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
    match command {
        "ping" => response(id, true, Some(json!({"message":"pong","host":"browser-assistant","protocol_version":1})), None),
        "authorize_command" => {
            let action = params.get("action").and_then(Value::as_str).unwrap_or("");
            if ALLOWED_ACTIONS.contains(&action) {
                response(id, true, Some(json!({"authorized":true,"action":action})), None)
            } else {
                response(id, false, None, Some(format!("action is not allowed: {action}")))
            }
        }
        _ => response(id, false, None, Some(format!("unsupported host command: {command}"))),
    }
}

fn load_or_create_token() -> Result<String> {
    let path = ipc_token_path()?;
    fs::create_dir_all(path.parent().context("IPC token path has no parent")?)?;
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            let token = Uuid::new_v4().to_string();
            file.write_all(token.as_bytes())?;
            file.flush()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
            }
            Ok(token)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let token = fs::read_to_string(&path)?.trim().to_owned();
            if token.is_empty() { anyhow::bail!("existing IPC token is empty: {}", path.display()); }
            Ok(token)
        }
        Err(error) => Err(error).context("creating IPC token"),
    }
}

fn spawn_extension_reader(tx: Sender<HostEvent>) {
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        loop {
            match read_message(&mut input) {
                Ok(Some(message)) => if tx.send(HostEvent::ExtensionMessage(message)).is_err() { return; },
                Ok(None) | Err(_) => {
                    let _ = tx.send(HostEvent::ExtensionDisconnected);
                    return;
                }
            }
        }
    });
}

fn spawn_ipc_listener(tx: Sender<HostEvent>, token: String) -> Result<()> {
    let name = IPC_SOCKET_NAME.to_ns_name::<GenericNamespaced>()?;
    let listener = ListenerOptions::new().name(name).create_sync()
        .context("creating local IPC listener")?;
    thread::spawn(move || {
        for incoming in listener.incoming() {
            let stream = match incoming { Ok(stream) => stream, Err(_) => continue };
            let tx = tx.clone();
            let token = token.clone();
            thread::spawn(move || {
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                let read = reader.by_ref().take((IPC_MAX_LINE_BYTES + 1) as u64).read_line(&mut line);
                let envelope: IpcEnvelope = match read {
                    Ok(count) if count > 0 && count <= IPC_MAX_LINE_BYTES => match serde_json::from_str(&line) {
                        Ok(value) => value,
                        Err(error) => {
                            let _ = write_ipc_response(reader.get_mut(), response(None, false, None, Some(format!("invalid IPC JSON: {error}"))));
                            return;
                        }
                    },
                    Ok(_) => {
                        let _ = write_ipc_response(reader.get_mut(), response(None, false, None, Some("empty or oversized IPC request".into())));
                        return;
                    }
                    Err(error) => {
                        let _ = write_ipc_response(reader.get_mut(), response(None, false, None, Some(format!("reading IPC request: {error}"))));
                        return;
                    }
                };
                if envelope.token != token {
                    let _ = write_ipc_response(reader.get_mut(), response(Some(envelope.request.id), false, None, Some("IPC authentication failed".into())));
                    return;
                }

                let request_id = envelope.request.id.clone();
                // X 发帖包含页面输入、提交和成功提示确认，单独给予更长等待时间。
                // 其他浏览器命令仍保持 45 秒，避免影响普通操作的响应速度。
                let command_timeout = if matches!(
                    &envelope.request.command,
                    BrowserCommand::PostXTweet { .. }
                ) {
                    Duration::from_secs(120)
                } else {
                    Duration::from_secs(45)
                };
                let (reply_tx, reply_rx) = mpsc::channel();
                if tx.send(HostEvent::DesktopRequest { request: envelope.request, reply: reply_tx }).is_err() {
                    return;
                }
                match reply_rx.recv_timeout(command_timeout) {
                    Ok(value) => {
                        let actual_id = value.get("id").and_then(Value::as_str);
                        if actual_id != Some(request_id.as_str()) {
                            let error = format!(
                                "Native Host correlation failure: request_id={}, extension_response_id={}",
                                request_id,
                                actual_id.unwrap_or("<missing>")
                            );
                            let _ = write_ipc_response(
                                reader.get_mut(),
                                response(Some(request_id), false, None, Some(error)),
                            );
                        } else {
                            let _ = write_ipc_response(reader.get_mut(), value);
                        }
                    }
                    Err(_) => {
                        let _ = write_ipc_response(
                            reader.get_mut(),
                            response(Some(request_id), false, None, Some(format!(
                                "browser command timed out after {} seconds",
                                command_timeout.as_secs()
                            ))),
                        );
                    }
                }
            });
        }
    });
    Ok(())
}

fn write_ipc_response<W: Write>(writer: &mut W, value: Value) -> Result<()> {
    serde_json::to_writer(&mut *writer, &value)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn page_action_name(command: &BrowserCommand) -> Option<&'static str> {
    match command {
        BrowserCommand::OpenAutomationWindow => Some("open_automation_window"),
        BrowserCommand::GetPageInfo => Some("get_page_info"),
        BrowserCommand::ReloadPage => Some("reload_page"),
        BrowserCommand::GetXPosts { .. } => Some("get_x_posts"),
        BrowserCommand::PostXTweet { .. } => Some("post_x_tweet"),
        BrowserCommand::ReplyToXPost { .. } => Some("reply_to_x_post"),
        BrowserCommand::GetFollowing { .. } => Some("get_following"),
        BrowserCommand::GetDomText { .. } => Some("get_dom_text"),
        BrowserCommand::FindElements { .. } => Some("find_elements"),
        BrowserCommand::GetElementRect { .. } => Some("get_element_rect"),
        BrowserCommand::Click { .. } => Some("click"),
        BrowserCommand::TypeText { .. } => Some("type_text"),
        BrowserCommand::Scroll { .. } => Some("scroll"),
        BrowserCommand::Ping | BrowserCommand::AuthorizeCommand { .. } => None,
    }
}

fn main() -> Result<()> {
    // stdout is exclusively reserved for Chrome Native Messaging frames.
    let token = load_or_create_token()?;
    let (event_tx, event_rx) = mpsc::channel();
    spawn_extension_reader(event_tx.clone());
    spawn_ipc_listener(event_tx, token)?;

    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut pending: HashMap<String, Sender<Value>> = HashMap::new();

    while let Ok(event) = event_rx.recv() {
        match event {
            HostEvent::DesktopRequest { request, reply } => {
                if matches!(&request.command, BrowserCommand::Ping) {
                    let _ = reply.send(response(Some(request.id), true, Some(json!({"message":"pong","host":"browser-assistant"})), None));
                    continue;
                }
                let Some(action) = page_action_name(&request.command) else {
                    let _ = reply.send(response(Some(request.id), false, None, Some("command is not available over desktop IPC".into())));
                    continue;
                };
                if !ALLOWED_ACTIONS.contains(&action) {
                    let _ = reply.send(response(Some(request.id), false, None, Some(format!("action is not allowed: {action}"))));
                    continue;
                }

                let id = request.id.clone();
                let mut message = serde_json::to_value(request)?;
                message["type"] = Value::String("desktop_command".into());
                pending.insert(id.clone(), reply);
                if let Err(error) = write_message(&mut output, &message) {
                    if let Some(waiter) = pending.remove(&id) {
                        let _ = waiter.send(response(Some(id), false, None, Some(format!("sending command to Chrome: {error}"))));
                    }
                }
            }
            HostEvent::ExtensionMessage(message) => {
                let id = message.get("id").and_then(Value::as_str).map(str::to_owned);
                if let Some(id) = id.as_deref() {
                    if let Some(waiter) = pending.remove(id) {
                        let _ = waiter.send(message);
                        continue;
                    }
                }

                // Extension command responses must never be treated as new host commands.
                // Doing so can emit an unrelated Native Messaging frame and hide stale IDs.
                if message.get("ok").and_then(Value::as_bool).is_some() {
                    eprintln!(
                        "[browser-assistant-host] ignored unmatched extension response: id={}",
                        id.as_deref().unwrap_or("<missing>")
                    );
                    continue;
                }

                write_message(&mut output, &handle_message(message))?;
            }
            HostEvent::ExtensionDisconnected => {
                for (id, waiter) in pending.drain() {
                    let _ = waiter.send(response(Some(id), false, None, Some("Chrome Native Messaging connection closed".into())));
                }
                break;
            }
        }
    }
    Ok(())
}
