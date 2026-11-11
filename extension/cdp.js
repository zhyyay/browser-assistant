const attachedTabs = new Set();

chrome.debugger.onDetach.addListener((source) => {
  if (Number.isInteger(source.tabId)) attachedTabs.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => attachedTabs.delete(tabId));

async function ensureAttached(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("CDP 操作缺少有效标签页 ID");
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.add(tabId);
  } catch (error) {
    const message = String(error?.message || error);
    if (/already attached|another debugger/i.test(message)) {
      throw new Error("目标标签页已被 DevTools 或其他调试器占用，无法附加 CDP");
    }
    throw new Error("无法附加 Chrome CDP 调试器: " + message);
  }
}

async function send(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function click(tabId, x, y) {
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1
  });
}

async function clearFocusedEditor(tabId) {
  const key = async (type, keyName, code, vk, modifiers = 0) => send(tabId, "Input.dispatchKeyEvent", {
    type, key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers
  });
  await key("keyDown", "Control", "ControlLeft", 17, 2);
  await key("keyDown", "a", "KeyA", 65, 2);
  await key("keyUp", "a", "KeyA", 65, 2);
  await key("keyUp", "Control", "ControlLeft", 17);
  await key("keyDown", "Backspace", "Backspace", 8);
  await key("keyUp", "Backspace", "Backspace", 8);
}

export async function dispatchCdpInput(tabId, params = {}) {
  const action = params.action;
  if (action === "click") {
    await click(tabId, Number(params.x), Number(params.y));
    return { performed: true, action, input_mode: "cdp" };
  }
  if (action === "type_text") {
    const x = Number(params.x);
    const y = Number(params.y);
    await click(tabId, x, y);
    await sleep(80);
    if (params.clear_first !== false) await clearFocusedEditor(tabId);
    const text = String(params.text ?? "");
    await send(tabId, "Input.insertText", { text });
    return { performed: true, action, cleared_first: params.clear_first !== false, input_mode: "cdp" };
  }
  if (action === "scroll") {
    let remaining = Math.max(-12000, Math.min(12000, Number(params.delta_y) || 0));
    const x = Number(params.x);
    const y = Number(params.y);
    while (remaining !== 0) {
      const deltaY = Math.sign(remaining) * Math.min(Math.abs(remaining), 480);
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, deltaX: 0, deltaY
      });
      remaining -= deltaY;
      await sleep(45);
    }
    return { performed: true, action, input_mode: "cdp" };
  }
  throw new Error("不支持的 CDP 输入动作: " + String(action));
}
