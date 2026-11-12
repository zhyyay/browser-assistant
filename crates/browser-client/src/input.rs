//! Keyboard and scrolling APIs backed by Chrome DevTools Protocol input.
use anyhow::{Result, bail};
use browser_core::BrowserCommand;
use serde_json::Value;

use crate::BrowserClient;

impl BrowserClient {
    /// Replace the contents of an editable element and verify the resulting text.
    pub fn fill(&mut self, selector: &str, text: &str) -> Result<Value> {
        let selector = selector.trim();
        if selector.is_empty() {
            bail!("CSS selector cannot be empty");
        }
        if text.is_empty() {
            bail!("input text cannot be empty");
        }
        self.execute_value(BrowserCommand::TypeText {
            selector: selector.to_owned(),
            text: text.to_owned(),
        })
    }

    /// Scroll the active page by a vertical delta in CSS pixels.
    pub fn scroll(&mut self, delta_y: i32) -> Result<Value> {
        if delta_y == 0 {
            bail!("scroll delta must not be zero");
        }
        self.execute_value(BrowserCommand::Scroll { delta_y })
    }
}
