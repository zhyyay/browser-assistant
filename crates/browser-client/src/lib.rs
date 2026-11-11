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
