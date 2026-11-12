//! CSS-selector based element lookup and interaction.
use anyhow::{Result, bail};
use browser_core::BrowserCommand;
use serde_json::Value;

use crate::BrowserClient;

impl BrowserClient {
    /// Find visible or hidden DOM elements matching a CSS selector.
    pub fn find_elements(&mut self, selector: &str, limit: Option<usize>) -> Result<Value> {
        let selector = selector.trim();
        if selector.is_empty() {
            bail!("CSS selector cannot be empty");
        }
        self.execute_value(BrowserCommand::FindElements {
            selector: selector.to_owned(),
            limit,
        })
    }

    /// Click the first element matching a CSS selector using CDP input.
    pub fn click(&mut self, selector: &str) -> Result<Value> {
        let selector = selector.trim();
        if selector.is_empty() {
            bail!("CSS selector cannot be empty");
        }
        self.execute_value(BrowserCommand::Click {
            selector: selector.to_owned(),
        })
    }
}
