//! X post parsing APIs.
use crate::BrowserClient;
use anyhow::Result;
use browser_core::{BrowserCommand, BrowserResponse};

impl BrowserClient {
    /// Read structured X posts from the currently active X page.
    ///
    /// The page parser only returns posts already loaded in the DOM; it does not scroll.
    /// A missing limit defaults to 20 and the extension clamps it to 1..=100.
    pub fn get_x_posts(&mut self, limit: Option<usize>) -> Result<BrowserResponse> {
        self.execute(BrowserCommand::GetXPosts { limit })
    }
}
