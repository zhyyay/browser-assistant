//! A small, readable snapshot composed from page metadata and rendered text.
use anyhow::Result;
use serde_json::{Value, json};

use crate::BrowserClient;

impl BrowserClient {
    /// Capture basic page metadata and rendered body text.
    ///
    /// This is intentionally lightweight: it does not serialize the full DOM or
    /// retain element handles. Use find_elements() for targeted element lookup.
    pub fn snapshot(&mut self, max_chars: Option<usize>) -> Result<Value> {
        let page = self.page_info()?;
        let text = self.dom_text(max_chars)?;
        Ok(json!({
            "page": page,
            "content": text
        }))
    }
}
