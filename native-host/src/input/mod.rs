//! OS-level input dispatch used by the browser extension for visible user-like actions.
use anyhow::Result;
use serde_json::{json, Value};

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "windows")]
pub fn execute(params: &Value) -> Result<Value> {
    windows::execute(params)
}

#[cfg(not(target_os = "windows"))]
pub fn execute(_params: &Value) -> Result<Value> {
    anyhow::bail!("OS-level mouse and keyboard input is currently supported on Windows only")
}
