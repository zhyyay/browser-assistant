const output = document.querySelector("#output");
const status = document.querySelector("#status");

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  output.textContent = JSON.stringify(response, null, 2);
  return response;
}

document.querySelector("#connect").addEventListener("click", async () => {
  status.textContent = "连接中…";
  const result = await send({ type: "native_ping" });
  status.textContent = result?.ok ? "Rust 已连接" : "连接失败";
});

document.querySelectorAll("[data-command]").forEach((button) => {
  button.addEventListener("click", () => {
    const params = {};
    if (button.dataset.selector) params.selector = button.dataset.selector;
    if (button.dataset.limit) params.limit = Number(button.dataset.limit);
    void send({ type: "page_command", command: button.dataset.command, params });
  });
});
const loadPostsButton = document.querySelector("#load-x-posts");
const replyPostSelect = document.querySelector("#reply-post");
const replyText = document.querySelector("#reply-text");
const replyButton = document.querySelector("#reply-x-post");

loadPostsButton.addEventListener("click", async () => {
  loadPostsButton.disabled = true;
  loadPostsButton.textContent = "正在解析…";
  status.textContent = "正在解析时间线";
  replyPostSelect.disabled = true;
  replyButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "page_command",
      command: "get_x_posts",
      params: { limit: 20 }
    });
    output.textContent = JSON.stringify(response, null, 2);
    const posts = response?.ok ? response.result?.posts : null;
    if (!Array.isArray(posts) || posts.length === 0) {
      throw new Error(response?.error || "没有解析到已加载的推文");
    }
    replyPostSelect.replaceChildren();
    for (const post of posts) {
      if (!post.id) continue;
      const option = document.createElement("option");
      option.value = post.id;
      const author = post.author?.username || post.author?.display_name || "未知作者";
      const preview = (post.text || "").replace(/\\s+/g, " ").slice(0, 48);
      option.textContent = author + " · " + (preview || "无正文") + " · ID " + post.id;
      replyPostSelect.append(option);
    }
    if (replyPostSelect.options.length === 0) {
      throw new Error("解析结果中没有可用于回复的推文 ID");
    }
    replyPostSelect.disabled = false;
    replyButton.disabled = false;
    status.textContent = "已解析 " + replyPostSelect.options.length + " 条推文";
  } catch (error) {
    status.textContent = "解析失败";
    output.textContent = JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2);
  } finally {
    loadPostsButton.disabled = false;
    loadPostsButton.textContent = "重新解析时间线推文";
  }
});

replyButton.addEventListener("click", async () => {
  const postId = replyPostSelect.value;
  const text = replyText.value.trim();
  if (!postId) {
    status.textContent = "请先选择目标推文";
    return;
  }
  if (!text) {
    status.textContent = "请输入回复内容";
    replyText.focus();
    return;
  }
  const selected = replyPostSelect.selectedOptions[0]?.textContent || postId;
  if (!window.confirm("即将向以下推文真实提交回复：\\n" + selected + "\\n\\n回复内容：\\n" + text + "\\n\\n确定提交吗？")) return;

  replyButton.disabled = true;
  loadPostsButton.disabled = true;
  replyButton.textContent = "正在回复…";
  status.textContent = "正在打开回复窗口";
  output.textContent = "正在定位目标推文、输入并校验回复内容；提交后不会自动重试…";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "page_command",
      command: "reply_to_x_post",
      params: { post_id: postId, text }
    });
    output.textContent = JSON.stringify(response, null, 2);
    if (response?.ok && response.result?.status === "sent" && response.result?.confirmed) {
      status.textContent = "回复成功";
      replyText.value = "";
    } else if (response?.ok && response.result?.status === "confirmation_unknown") {
      status.textContent = "提交结果待确认";
    } else {
      status.textContent = "回复失败";
    }
  } catch (error) {
    status.textContent = "回复失败";
    output.textContent = JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2);
  } finally {
    replyButton.disabled = !replyPostSelect.value;
    loadPostsButton.disabled = false;
    replyButton.textContent = "测试回复并提交";
  }
});


const scanButton = document.querySelector("#scan-not-following-back");
scanButton.addEventListener("click", async () => {
  scanButton.disabled = true;
  scanButton.textContent = "扫描中，请保持弹窗打开…";
  status.textContent = "正在分批扫描";
  output.textContent = "正在检查 X Following 页面。每批之间会等待，扫描时间取决于关注人数…";
  try {
    const response = await chrome.runtime.sendMessage({ type: "scan_not_following_back" });
    output.textContent = JSON.stringify(response, null, 2);
    if (response?.ok) {
      const result = response.result || {};
      status.textContent = result.scan_complete ? "扫描完成" : "扫描未完成";
      scanButton.textContent = "重新扫描没有回关的用户";
    } else {
      status.textContent = "扫描失败";
      scanButton.textContent = "重试扫描没有回关的用户";
    }
  } catch (error) {
    status.textContent = "扫描失败";
    output.textContent = JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2);
    scanButton.textContent = "重试扫描没有回关的用户";
  } finally {
    scanButton.disabled = false;
  }
});


const postText = document.querySelector("#post-text");
const postButton = document.querySelector("#post-x-tweet");
postButton.addEventListener("click", async () => {
  const text = postText.value.trim();
  if (!text) {
    status.textContent = "请输入发帖内容";
    postText.focus();
    return;
  }
  if (!window.confirm("确定将以下内容发布到当前登录的 X 账号吗？\\n\\n" + text)) return;

  postButton.disabled = true;
  postButton.textContent = "正在发帖…";
  status.textContent = "正在进入发帖编辑框";
  output.textContent = "正在随机选择 X 发帖入口，请勿重复点击…";
  try {
    const response = await send({
      type: "page_command",
      command: "post_x_tweet",
      params: { text }
    });
    if (response?.ok && response.result?.status === "sent") {
      status.textContent = "发帖成功";
      postButton.textContent = "再次发帖";
    } else if (response?.ok && response.result?.status === "confirmation_unknown") {
      status.textContent = "提交结果待确认";
      postButton.textContent = "请先检查 X 页面";
    } else {
      status.textContent = "发帖失败";
      postButton.textContent = "重试自动发帖";
    }
  } catch (error) {
    status.textContent = "发帖失败";
    output.textContent = JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2);
    postButton.textContent = "重试自动发帖";
  } finally {
    postButton.disabled = false;
  }
});
