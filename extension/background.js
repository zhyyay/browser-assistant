const NATIVE_HOST = "com.zhyyay.browser_assistant";
let nativePort = null;
const pending = new Map();

function connectNative() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort.onMessage.addListener((message) => {
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || "Native Host disconnected";
    for (const waiter of pending.values()) waiter.reject(new Error(error));
    pending.clear();
    nativePort = null;
  });
  return nativePort;
}

function nativeRequest(command, params = {}) {
  const port = connectNative();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Native Host request timed out"));
    }, 5000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); }
    });
    port.postMessage({ id, command, params });
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
    throw new Error("当前活动标签页不是可访问的 HTTP/HTTPS 网页");
  }
  return tab;
}

async function executeInPage(command, params = {}) {
  const tab = await getActiveTab();
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [{ command, params }],
    func: ({ command, params }) => {
      const compact = (value, max = 500) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
      const rectOf = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          viewport_x: rect.left,
          viewport_y: rect.top,
          width: rect.width,
          height: rect.height
        };
      };

      switch (command) {
        case "get_page_info":
          return { url: location.href, title: document.title, ready_state: document.readyState };
        case "get_dom_text": {
          const max = Math.min(Math.max(Number(params.max_chars) || 12000, 1), 50000);
          return { text: compact(document.body?.innerText || "", max) };
        }
        case "find_elements": {
          const selector = String(params.selector || "");
          const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 100);
          return [...document.querySelectorAll(selector)].slice(0, limit).map((element) => ({
            tag_name: element.tagName.toLowerCase(),
            text: compact(element.innerText || element.getAttribute("aria-label") || element.getAttribute("placeholder"), 300),
            selector,
            ...rectOf(element)
          }));
        }
        case "get_element_rect": {
          const element = document.querySelector(String(params.selector || ""));
          if (!element) throw new Error("element not found");
          return { ...rectOf(element), tag_name: element.tagName.toLowerCase() };
        }
        case "click": {
          const element = document.querySelector(String(params.selector || ""));
          if (!(element instanceof HTMLElement)) throw new Error("click target not found or not an HTML element");
          element.click();
          return { clicked: true };
        }
        case "type_text": {
          const element = document.querySelector(String(params.selector || ""));
          if (!element) throw new Error("element not found");
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) {
            throw new Error("target is not editable");
          }
          element.focus();
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
            setter?.call(element, String(params.text ?? ""));
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            element.textContent = String(params.text ?? "");
            element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(params.text ?? "") }));
          }
          return { typed: true };
        }
        case "scroll":
          window.scrollBy({ top: Number(params.delta_y) || 0, behavior: "instant" });
          return { scroll_y: window.scrollY };
        default:
          throw new Error("unsupported page command: " + command);
      }
    }
  });
  return injection?.result ?? null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "native_ping") {
        sendResponse(await nativeRequest("ping"));
        return;
      }
      if (message.type === "page_command") {
        const authorization = await nativeRequest("authorize_command", { action: message.command });
        if (!authorization?.ok || !authorization.result?.authorized) {
          throw new Error(authorization?.error || "Rust Host rejected the command");
        }
        const result = await executeInPage(message.command, message.params || {});
        sendResponse({ ok: true, result, authorized_by: "rust-native-host" });
        return;
      }
      sendResponse({ ok: false, error: "unknown message type" });
    } catch (error) {
      sendResponse({ ok: false, error: error.message || String(error) });
    }
  })();
  return true;
});
