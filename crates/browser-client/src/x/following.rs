//! X Following list scanning and follow-back filtering.
use crate::BrowserClient;
use anyhow::Result;
use browser_core::{BrowserCommand, BrowserResponse};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

impl BrowserClient {
    /// Scan the active X Following page and return a deduplicated JSON result.
    ///
    /// Transient transport/page errors are retried up to three times. If a scan
    /// cannot continue, the response keeps the users already collected and
    /// describes the failure in stop_reason/errors.
    pub fn get_following(&mut self) -> Result<BrowserResponse> {
        let mut users: HashMap<String, Value> = HashMap::new();
        let mut page = Value::Null;
        let mut errors: Vec<Value> = Vec::new();
        let mut rounds = 0_usize;
        let mut retry_count = 0_usize;
        let mut consecutive_empty = 0_usize;
        let mut stagnant_rounds = 0_usize;
        let mut scan_complete = false;
        let mut stop_reason = "max_rounds_reached";

        while rounds < 100 {
            let mut batch_response = None;
            for attempt in 0..3 {
                match self.execute(BrowserCommand::GetFollowing { limit: Some(50) }) {
                    Ok(response) if response.ok => {
                        batch_response = Some(response);
                        break;
                    }
                    Ok(response) => {
                        let message = response.error.unwrap_or_else(|| "Following 页面返回错误".to_owned());
                        errors.push(json!({
                            "stage": "load_users",
                            "round": rounds + 1,
                            "attempt": attempt + 1,
                            "message": message
                        }));
                        if attempt == 2 {
                            stop_reason = classify_stop_reason(&message);
                        }
                    }
                    Err(error) => {
                        let message = error.to_string();
                        errors.push(json!({
                            "stage": "browser_request",
                            "round": rounds + 1,
                            "attempt": attempt + 1,
                            "message": message
                        }));
                        if attempt == 2 {
                            stop_reason = classify_stop_reason(&message);
                        }
                    }
                }
                retry_count += 1;
                if attempt < 2 {
                    thread::sleep(Duration::from_millis(1200 * (attempt as u64 + 1)));
                }
            }

            let Some(response) = batch_response else {
                break;
            };
            let result = response.result.unwrap_or(Value::Null);
            if result.get("success").and_then(Value::as_bool) != Some(true) {
                stop_reason = "invalid_batch";
                errors.push(json!({
                    "stage": "parse_batch",
                    "round": rounds + 1,
                    "message": "Following 页面返回了无效批次"
                }));
                break;
            }

            page = result.get("page").cloned().unwrap_or(Value::Null);
            if let Some(batch_errors) = result.get("errors").and_then(Value::as_array) {
                errors.extend(batch_errors.iter().cloned().map(|mut error| {
                    if let Some(object) = error.as_object_mut() {
                        object.insert("round".to_owned(), json!(rounds + 1));
                    }
                    error
                }));
            }

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
                    .map(|name| format!("@{}", name.to_ascii_lowercase()))
                    .or_else(|| user.get("profile_url").and_then(Value::as_str).map(str::to_owned))
                    .or_else(|| user.get("display_name").and_then(Value::as_str).map(|name| format!("unknown:{name}")))
                    .unwrap_or_else(|| format!("unknown:{rounds}:{index}"));

                match users.get_mut(&key) {
                    Some(existing)
                        if existing.get("follow_status").and_then(Value::as_str) == Some("unknown")
                            && user.get("follow_status").and_then(Value::as_str) != Some("unknown") =>
                    {
                        *existing = user;
                    }
                    Some(_) => {}
                    None => {
                        users.insert(key, user);
                    }
                }
            }

            let added = users.len().saturating_sub(before);
            consecutive_empty = if added == 0 { consecutive_empty + 1 } else { 0 };
            rounds += 1;

            let Some(has_more) = result.pointer("/scroll/has_more").and_then(Value::as_bool) else {
                stop_reason = "invalid_scroll_state";
                errors.push(json!({
                    "stage": "scroll",
                    "round": rounds,
                    "message": "页面未返回有效的滚动状态"
                }));
                break;
            };
            let moved = result.pointer("/scroll/moved").and_then(Value::as_bool).unwrap_or(false);
            stagnant_rounds = if moved { 0 } else { stagnant_rounds + 1 };

            if !has_more {
                scan_complete = true;
                stop_reason = "reached_bottom";
                break;
            }
            if consecutive_empty >= 5 && stagnant_rounds >= 3 {
                stop_reason = "no_new_users";
                break;
            }
            if stagnant_rounds >= 5 {
                stop_reason = "scroll_stalled";
                break;
            }

            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos() as usize;
            let delay_ms = 1800 + ((nanos + rounds) % 1201);
            thread::sleep(Duration::from_millis(delay_ms as u64));
            if rounds % 8 == 0 {
                let rest_seconds = 12 + ((nanos / 7 + rounds) % 20);
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

        let mutual_count = users.iter()
            .filter(|user| user.get("follow_status").and_then(Value::as_str) == Some("mutual"))
            .count();
        let not_mutual_count = users.iter()
            .filter(|user| user.get("follow_status").and_then(Value::as_str) == Some("not_mutual"))
            .count();
        let unknown_count = users.len().saturating_sub(mutual_count + not_mutual_count);
        let total = users.len();

        Ok(BrowserResponse {
            id: None,
            ok: true,
            result: Some(json!({
                "success": scan_complete,
                "page": page,
                "scan_complete": scan_complete,
                "stop_reason": stop_reason,
                "total": total,
                "scanned": total,
                "mutual_count": mutual_count,
                "not_following_back_count": not_mutual_count,
                "unknown_count": unknown_count,
                "rounds": rounds,
                "retry_count": retry_count,
                "users": users,
                "errors": errors
            })),
            error: None,
        })
    }

    /// Return only accounts that do not follow the current user back.
    pub fn get_not_following_back(&mut self) -> Result<Vec<Value>> {
        let response = self.get_following()?;
        if !response.ok {
            anyhow::bail!(
                "{}",
                response.error.unwrap_or_else(|| "X Following 扫描失败".to_owned())
            );
        }

        let result = response.result.unwrap_or(Value::Null);
        Ok(result.get("users").and_then(Value::as_array).cloned().unwrap_or_default()
            .into_iter()
            .filter(|user| user.get("follow_status").and_then(Value::as_str) == Some("not_mutual"))
            .collect())
    }
}

fn classify_stop_reason(message: &str) -> &'static str {
    let lower = message.to_ascii_lowercase();
    if lower.contains("rate") || message.contains("限流") || message.contains("过于频繁") {
        "rate_limited"
    } else if message.contains("验证") || lower.contains("challenge") {
        "challenge_detected"
    } else if message.contains("页面") || lower.contains("tab") || lower.contains("not found") {
        "page_error"
    } else {
        "browser_request_error"
    }
}
