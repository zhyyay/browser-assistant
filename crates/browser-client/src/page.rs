//! Basic page inspection APIs.
use anyhow::Result;
use browser_core::BrowserCommand;
use serde_json::Value;

use crate::BrowserClient;

impl BrowserClient {
    /// Return URL, title and document ready state for the active tab.
    pub fn page_info(&mut self) -> Result<Value> {
        self.execute_value(BrowserCommand::GetPageInfo)
    }

    /// Return visible page text, limited to the requested number of characters.
    pub fn dom_text(&mut self, max_chars: Option<usize>) -> Result<Value> {
        self.execute_value(BrowserCommand::GetDomText { max_chars })
    }
}
