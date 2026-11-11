/**
 * Minimal Chrome DevTools Protocol input transport.
 *
 * This module intentionally exposes only tab-scoped Input commands. It does not
 * enable the Network or Runtime domains and contains no cookie/storage readers.
 * The Windows desktop cursor and keyboard are never addressed here.
 */
const PROTOCOL_VERSION = "1.3";
const attachedTabs = new Set();

export async function attachTab(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  attachedTabs.add(tabId);
}

export async function detachTab(tabId) {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch (_) {}
}

export async function clickAt(tabId, x, y) {
  await attachTab(tabId);
  const point = { x: Number(x), y: Number(y) };
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseMoved", ...point, button: "none"
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed", ...point, button: "left", clickCount: 1
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased", ...point, button: "left", clickCount: 1
  });
  return { clicked: true, ...point, input_mode: "cdp" };
}

async function dispatchKey(tabId, type, keyName, code, virtualKey, modifiers = 0) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type, key: keyName, code, windowsVirtualKeyCode: virtualKey,
    nativeVirtualKeyCode: virtualKey, modifiers
  });
}

export async function typeAt(tabId, x, y, text) {
  await attachTab(tabId);
  await clickAt(tabId, x, y);
  // Replace rather than append, preventing stale composer content.
  await dispatchKey(tabId, "keyDown", "a", "KeyA", 65, 2);
  await dispatchKey(tabId, "keyUp", "a", "KeyA", 65, 2);
  await dispatchKey(tabId, "keyDown", "Backspace", "Backspace", 8);
  await dispatchKey(tabId, "keyUp", "Backspace", "Backspace", 8);
  await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text: String(text ?? "") });
  return { typed: true, cleared_first: true, input_mode: "cdp" };
}

export async function scroll(tabId, deltaY, x = 400, y = 300) {
  await attachTab(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseWheel", x: Number(x), y: Number(y), deltaX: 0, deltaY: Number(deltaY) || 0
  });
  return { scrolled: true, delta_y: Number(deltaY) || 0, input_mode: "cdp" };
}

export async function dispatchInput(tabId, params = {}) {
  switch (params.action) {
    case "click":
      return clickAt(tabId, params.x, params.y);
    case "type_text":
      return typeAt(tabId, params.x, params.y, params.text);
    case "scroll":
      return scroll(tabId, params.delta_y, params.x, params.y);
    case "navigate":
      await chrome.tabs.update(tabId, { url: String(params.url || "") });
      return { navigated: true, input_mode: "chrome_tabs_api" };
    default:
      throw new Error("Unsupported CDP input action: " + params.action);
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (Number.isInteger(source?.tabId)) attachedTabs.delete(source.tabId);
});
