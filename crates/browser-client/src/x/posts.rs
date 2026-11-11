//! X post parsing and publishing APIs.
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

    /// Publish a post on the currently active X page.
    ///
    /// The page must contain an empty, visible X composer. Existing draft text is
    /// never overwritten. A successful click without a verifiable success toast
    /// returns `confirmation_unknown`; callers must not automatically retry it.
    pub fn post_x_tweet(&mut self, text: &str) -> Result<BrowserResponse> {
        let content = text.trim();
        if content.is_empty() {
            anyhow::bail!("X 发帖内容不能为空");
        }
        self.execute(BrowserCommand::PostXTweet {
            text: content.to_owned(),
        })
    }

    /// Reply to one exact post already parsed from the currently loaded X timeline.
    ///
    /// The post ID must come from GetXPosts. The extension opens that post's reply
    /// dialog, verifies the target ID and typed text, submits once, and reports
    /// sent or confirmation_unknown. Callers must not retry an uncertain result.
    pub fn reply_to_x_post(&mut self, post_id: &str, text: &str) -> Result<BrowserResponse> {
        let post_id = post_id.trim();
        if !post_id.chars().all(|ch| ch.is_ascii_digit()) || !(5..=30).contains(&post_id.len()) {
            anyhow::bail!("X 推文 ID 无效");
        }
        let content = text.trim();
        if content.is_empty() {
            anyhow::bail!("X 回复内容不能为空");
        }
        self.execute(BrowserCommand::ReplyToXPost {
            post_id: post_id.to_owned(),
            text: content.to_owned(),
        })
    }
}
