use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "command", content = "params", rename_all = "snake_case")]
pub enum BrowserCommand {
    Ping,
    AuthorizeCommand { action: String },
    GetPageInfo,
    GetDomText { max_chars: Option<usize> },
    FindElements { selector: String, limit: Option<usize> },
    GetElementRect { selector: String },
    Click { selector: String },
    TypeText { selector: String, text: String },
    Scroll { delta_y: i32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserRequest {
    pub id: String,
    #[serde(flatten)]
    pub command: BrowserCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserResponse {
    pub id: Option<String>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageInfo {
    pub url: String,
    pub title: String,
    pub ready_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElementInfo {
    pub tag_name: String,
    pub text: String,
    pub selector: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
