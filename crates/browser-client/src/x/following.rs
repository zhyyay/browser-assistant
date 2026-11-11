//! X Following list scanning and follow-back filtering.
use crate::BrowserClient;
use anyhow::Result;
use browser_core::{BrowserCommand, BrowserResponse};
use serde_json::Value;
use std::{
    collections::HashMap,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

impl BrowserClient {
    /// Scan the active X Following page and return a deduplicated JSON result.
    ///
    /// Each browser call reads one DOM batch and scrolls once. The client waits
    /// between batches to avoid issuing rapid consecutive page operations.
    pub fn get_following(&mut self) -> Result<BrowserResponse> {
        let mut users: HashMap<String, Value> = HashMap::new();
        let mut page = Value::Null;
        let mut rounds = 0_usize;
        let mut consecutive_empty = 0_usize;
        let mut scan_complete = false;
        let mut stop_reason = "no_new_users";

        loop {
            let response = self.execute(BrowserCommand::GetFollowing { limit: Some(30) })?;
            if !response.ok {
                return Ok(response);
            }

            let result = response.result.unwrap_or(Value::Null);
            if result.get("success").and_then(Value::as_bool) != Some(true) {
                return Ok(BrowserResponse {
                    id: None,
                    ok: false,
                    result: Some(result),
                    error: Some("当前页面不是可扫描的 X Following 页面".to_owned()),
                });
            }

            page = result.get("page").cloned().unwrap_or(Value::Null);
            let batch = result
                .get("users")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let before = users.len();

            for (index, user) in batch.into_iter().enumerate() {
                let key = user
                    .get("username")
                    .and_then(Value::as_str)
                    .map(str::to_ascii_lowercase)
                    .or_else(|| {
                        user.get("profile_url")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .or_else(|| {
                        user.get("display_name")
                            .and_then(Value::as_str)
                            .map(|name| format!("unknown:{name}"))
                    })
                    .unwrap_or_else(|| format!("unknown:{rounds}:{index}"));

                users.entry(key).or_insert(user);
            }

            let added = users.len().saturating_sub(before);
            consecutive_empty = if added == 0 {
                consecutive_empty + 1
            } else {
                0
            };
            rounds += 1;

            let has_more = result
                .pointer("/scroll/has_more")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            if !has_more {
                scan_complete = true;
                stop_reason = "reached_bottom";
                break;
            }
            if consecutive_empty >= 5 {
                stop_reason = "no_new_users_after_5_rounds";
                break;
            }

            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos() as usize;
            let delay_seconds = 2 + ((nanos + rounds) % 3);
            thread::sleep(Duration::from_secs(delay_seconds as u64));

            if rounds % 10 == 0 {
                let rest_seconds = 15 + ((nanos / 7 + rounds) % 16);
                thread::sleep(Duration::from_secs(rest_seconds as u64));
            }
        }

        let mut users: Vec<Value> = users.into_values().collect();
        users.sort_by(|a, b| {
            a.get("username")
                .and_then(Value::as_str)
                .unwrap_or("")
                .cmp(b.get("username").and_then(Value::as_str).unwrap_or(""))
        });

        let mutual_count = users
            .iter()
            .filter(|user| user.get("follow_status").and_then(Value::as_str) == Some("mutual"))
            .count();
        let not_mutual_count = users
            .iter()
            .filter(|user| user.get("follow_status").and_then(Value::as_str) == Some("not_mutual"))
            .count();
        let unknown_count = users.len().saturating_sub(mutual_count + not_mutual_count);
        let total = users.len();

        Ok(BrowserResponse {
            id: None,
            ok: true,
            result: Some(serde_json::json!({
                "success": true,
                "page": page,
                "scan_complete": scan_complete,
                "stop_reason": stop_reason,
                "total": total,
                "scanned": total,
                "mutual_count": mutual_count,
                "not_following_back_count": not_mutual_count,
                "unknown_count": unknown_count,
                "users": users
            })),
            error: None,
        })
    }

    /// Return only accounts that do not follow the current user back.
    ///
    /// This performs a full Following scan first. The returned vector contains
    /// the original JSON objects for users whose follow_status is "not_mutual".
    pub fn get_not_following_back(&mut self) -> Result<Vec<Value>> {
        let response = self.get_following()?;
        if !response.ok {
            anyhow::bail!(
                "{}",
                response.error.unwrap_or_else(|| "X Following 扫描失败".to_owned())
            );
        }

        let result = response.result.unwrap_or(Value::Null);
        let users = result
            .get("users")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        Ok(users
            .into_iter()
            .filter(|user| {
                user.get("follow_status").and_then(Value::as_str) == Some("not_mutual")
            })
            .collect())
    }
}
