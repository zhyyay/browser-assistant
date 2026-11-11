//! Local IPC definitions shared by the Native Host and Rust desktop clients.
use std::path::PathBuf;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use crate::BrowserRequest;

pub const IPC_SOCKET_NAME: &str = "zhyyay.browser-assistant.v1";
pub const IPC_MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcEnvelope {
    pub token: String,
    pub request: BrowserRequest,
}

pub fn ipc_token_path() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .ok_or_else(|| anyhow!("LOCALAPPDATA is not available"))?;
        return Ok(PathBuf::from(base).join("BrowserAssistant").join("ipc.token"));
    }
    #[cfg(not(windows))]
    {
        if let Some(base) = std::env::var_os("XDG_CONFIG_HOME") {
            return Ok(PathBuf::from(base).join("browser-assistant").join("ipc.token"));
        }
        let home = std::env::var_os("HOME")
            .ok_or_else(|| anyhow!("HOME is not available"))?;
        Ok(PathBuf::from(home).join(".config").join("browser-assistant").join("ipc.token"))
    }
}
