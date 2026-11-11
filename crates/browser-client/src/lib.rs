//! Synchronous Rust client for the Browser Assistant local IPC endpoint.
use std::{
    io::{BufRead, BufReader, Write},
    sync::atomic::{AtomicU64, Ordering},
};
use anyhow::{Context, Result, bail};
use browser_core::{
    ipc::{ipc_token_path, IpcEnvelope, IPC_SOCKET_NAME},
    BrowserCommand, BrowserRequest, BrowserResponse,
};
use interprocess::local_socket::{prelude::*, GenericNamespaced, Stream};

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

pub struct BrowserClient {
    reader: Option<BufReader<Stream>>,
    token: String,
}

fn connect_stream() -> Result<BufReader<Stream>> {
    let name = IPC_SOCKET_NAME.to_ns_name::<GenericNamespaced>()?;
    let stream = Stream::connect(name)
        .context("cannot connect to Browser Assistant; is its Chrome Native Host running?")?;
    Ok(BufReader::new(stream))
}

impl BrowserClient {
    /// Connect after the Chrome extension has started the Native Messaging Host.
    pub fn connect() -> Result<Self> {
        let token_path = ipc_token_path()?;
        let token = std::fs::read_to_string(&token_path)
            .with_context(|| format!("cannot read IPC token at {}; open Browser Assistant first", token_path.display()))?
            .trim().to_owned();
        if token.is_empty() {
            bail!("Browser Assistant IPC token is empty");
        }
        Ok(Self { reader: Some(connect_stream()?), token })
    }

    /// Read structured X posts from the currently active X page.
    ///
    /// The page parser only returns posts already loaded in the DOM; it does not scroll.
    /// A missing limit defaults to 20 and the extension clamps it to 1..=100.
    pub fn get_x_posts(&mut self, limit: Option<usize>) -> Result<BrowserResponse> {
        self.execute(BrowserCommand::GetXPosts { limit })
    }

    /// Scan the active X Following page and return a deduplicated JSON result.
    ///
    /// Each browser call reads one DOM batch and scrolls once. The client waits
    /// between batches to avoid issuing rapid consecutive page operations.
    pub fn get_following(&mut self) -> Result<BrowserResponse> {
        use std::{collections::HashMap, thread, time::{Duration, SystemTime, UNIX_EPOCH}};

        let mut users: HashMap<String, serde_json::Value> = HashMap::new();
        let mut page = serde_json::Value::Null;
        let mut rounds = 0_usize;
        let mut consecutive_empty = 0_usize;

        loop {
            let response = self.execute(BrowserCommand::GetFollowing { limit: Some(30) })?;
            if !response.ok {
                return Ok(response);
            }
            let result = response.result.unwrap_or(serde_json::Value::Null);
            if result.get("success").and_then(serde_json::Value::as_bool) != Some(true) {
                return Ok(BrowserResponse {
                    id: None,
                    ok: false,
                    result: Some(result),
                    error: Some("当前页面不是可扫描的 X Following 页面".to_owned()),
                });
            }
            page = result.get("page").cloned().unwrap_or(serde_json::Value::Null);
            let batch = result.get("users").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
            let before = users.len();
            for user in batch {
                if let Some(username) = user.get("username").and_then(serde_json::Value::as_str) {
                    users.entry(username.to_ascii_lowercase()).or_insert(user);
                }
            }
            let added = users.len().saturating_sub(before);
            consecutive_empty = if added == 0 { consecutive_empty + 1 } else { 0 };
            rounds += 1;

            let has_more = result.pointer("/scroll/has_more").and_then(serde_json::Value::as_bool).unwrap_or(false);
            if !has_more || consecutive_empty >= 5 {
                break;
            }

            let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_nanos() as usize;
            let delay_seconds = 2 + ((nanos + rounds) % 3);
            thread::sleep(Duration::from_secs(delay_seconds as u64));
            if rounds % 10 == 0 {
                let rest_seconds = 15 + ((nanos / 7 + rounds) % 16);
                thread::sleep(Duration::from_secs(rest_seconds as u64));
            }
        }

        let mut users: Vec<serde_json::Value> = users.into_values().collect();
        users.sort_by(|a, b| {
            a.get("username").and_then(serde_json::Value::as_str)
                .unwrap_or("").cmp(b.get("username").and_then(serde_json::Value::as_str).unwrap_or(""))
        });
        let mutual_count = users.iter().filter(|user| user.get("follow_status").and_then(serde_json::Value::as_str) == Some("mutual")).count();
        let not_mutual_count = users.iter().filter(|user| user.get("follow_status").and_then(serde_json::Value::as_str) == Some("not_mutual")).count();
        let unknown_count = users.len().saturating_sub(mutual_count + not_mutual_count);
        let total = users.len();

        Ok(BrowserResponse {
            id: None,
            ok: true,
            result: Some(serde_json::json!({
                "success": true,
                "page": page,
                "total": total,
                "scanned": total,
                "mutual_count": mutual_count,
                "not_following_back_count": not_mutual_count,
                "unknown_count": unknown_count,
                "users": users
            })),
            error: None,
        })
    }

    /// Send one command. Each request uses a short-lived local IPC connection.
    /// The client reconnects automatically for subsequent calls.
    pub fn execute(&mut self, command: BrowserCommand) -> Result<BrowserResponse> {
        let id = format!("desktop-{}-{}", std::process::id(), NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed));
        let envelope = IpcEnvelope {
            token: self.token.clone(),
            request: BrowserRequest { id: id.clone(), command },
        };
        let mut reader = match self.reader.take() {
            Some(reader) => reader,
            None => connect_stream()?,
        };

        let mut payload = serde_json::to_vec(&envelope)?;
        payload.push(b'\n');
        reader.get_mut().write_all(&payload).context("writing IPC request")?;
        reader.get_mut().flush()?;

        let mut line = String::new();
        reader.read_line(&mut line).context("reading IPC response")?;
        if line.is_empty() {
            bail!("Browser Assistant IPC connection closed before a response");
        }
        let response: BrowserResponse = serde_json::from_str(&line).context("decoding IPC response")?;
        if response.id.as_deref() != Some(id.as_str()) {
            bail!("IPC response id does not match the request");
        }
        // The host currently serves one request per connection. Reconnect on the next execute().
        drop(reader);
        Ok(response)
    }
}
