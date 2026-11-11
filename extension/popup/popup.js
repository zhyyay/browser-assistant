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
    void send({ type: "page_command", command: button.dataset.command, params });
  });
});
