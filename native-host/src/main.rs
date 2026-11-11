use std::io::{self, Read, Write};

use anyhow::{Context, Result};
use browser_core::BrowserResponse;
use serde_json::{json, Value};

const MAX_MESSAGE_SIZE: usize = 8 * 1024 * 1024;
const ALLOWED_ACTIONS: &[&str] = &[
    "get_page_info", "get_dom_text", "find_elements",
    "get_element_rect", "click", "type_text", "scroll",
];

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
        "ping" => response(id, true, Some(json!({
            "message": "pong",
            "host": "browser-assistant",
            "protocol_version": 1
        })), None),
        "authorize_command" => {
            let action = params.get("action").and_then(Value::as_str).unwrap_or("");
            if ALLOWED_ACTIONS.contains(&action) {
                response(id, true, Some(json!({ "authorized": true, "action": action })), None)
            } else {
                response(id, false, None, Some(format!("action is not allowed: {action}")))
            }
        }
        _ => response(id, false, None, Some(format!("unsupported host command: {command}"))),
    }
}

fn main() -> Result<()> {
    // stdout is reserved exclusively for the Native Messaging binary protocol.
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();

    while let Some(message) = read_message(&mut input)? {
        write_message(&mut output, &handle_message(message))?;
    }
    Ok(())
}
