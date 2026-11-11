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
