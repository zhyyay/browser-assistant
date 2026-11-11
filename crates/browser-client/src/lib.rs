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
    reader: BufReader<Stream>,
    token: String,
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
        let name = IPC_SOCKET_NAME.to_ns_name::<GenericNamespaced>()?;
        let stream = Stream::connect(name)
            .context("cannot connect to Browser Assistant; is its Chrome Native Host running?")?;
        Ok(Self { reader: BufReader::new(stream), token })
    }

    /// Send one command and wait for its matching response.
    pub fn execute(&mut self, command: BrowserCommand) -> Result<BrowserResponse> {
        let id = format!("desktop-{}-{}", std::process::id(), NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed));
        let envelope = IpcEnvelope {
            token: self.token.clone(),
            request: BrowserRequest { id: id.clone(), command },
        };
        let mut payload = serde_json::to_vec(&envelope)?;
        payload.push(b'\n');
        self.reader.get_mut().write_all(&payload).context("writing IPC request")?;
        self.reader.get_mut().flush()?;

        let mut line = String::new();
        self.reader.read_line(&mut line).context("reading IPC response")?;
        if line.is_empty() {
            bail!("Browser Assistant IPC connection closed before a response");
        }
        let response: BrowserResponse = serde_json::from_str(&line).context("decoding IPC response")?;
        if response.id.as_deref() != Some(id.as_str()) {
            bail!("IPC response id does not match the request");
        }
        Ok(response)
    }
}
