//! Shared protocol types for Browser Assistant.
pub mod ipc;
pub mod protocol;

pub use protocol::{BrowserCommand, BrowserRequest, BrowserResponse, ElementInfo, PageInfo};
