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
