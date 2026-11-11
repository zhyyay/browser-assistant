/**
 * Chrome DevTools Protocol transport for browser-owned automation tabs.
 *
 * This module never calls Windows SendInput or moves the OS cursor. All pointer,
 * keyboard and wheel events are dispatched to a specific Chrome tab via CDP.
 */
const PROTOCOL_VERSION = "1.3";
const attachedTabs = new Set();

export async function attachTab(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  attachedTabs.add(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
}

export async function detachTab(tabId) {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch (_) {
    // Chrome may have closed the tab or detached the target already.
  }
}

export async function evaluate(tabId, expression) {
  await attachTab(tabId);
  const response = await chrome.debugger.sendCommand(
    { tabId },
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, userGesture: true }
  );
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || "CDP page evaluation failed");
  }
  return response.result?.value ?? null;
}

async function elementCenter(tabId, selector) {
  const result = await evaluate(tabId, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!result) throw new Error("CDP_ELEMENT_NOT_FOUND: " + selector);
  return result;
}

export async function clickSelector(tabId, selector) {
  await attachTab(tabId);
  const point = await elementCenter(tabId, selector);
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x: point.x, y: point.y, button: "none"
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1
  });
  return { clicked: true, x: point.x, y: point.y, input_mode: "cdp" };
}

async function key(tabId, type, keyName, code, virtualKey, modifiers = 0) {
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
    type, key: keyName, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers
  });
}

export async function fillSelector(tabId, selector, text) {
  await attachTab(tabId);
  const point = await elementCenter(tabId, selector);
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1
  });

  // Ctrl+A then Backspace explicitly replaces prior input, preventing stale
  // composer text from being accidentally concatenated with the new content.
  await key(tabId, "keyDown", "a", "KeyA", 65, 2);
  await key(tabId, "keyUp", "a", "KeyA", 65, 2);
  await key(tabId, "keyDown", "Backspace", "Backspace", 8);
  await key(tabId, "keyUp", "Backspace", "Backspace", 8);
  await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text: String(text ?? "") });

  const verified = await evaluate(tabId, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    const actual = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.value : (element?.innerText || element?.textContent || "");
    return { exists: !!element, actual: String(actual).trim(), tag: element?.tagName || null };
  })()`);
  const expected = String(text ?? "").trim();
  if (!verified?.exists || verified.actual !== expected) {
    throw new Error("CDP_INPUT_VERIFY_FAILED: 页面回读内容与输入内容不一致");
  }
  return { typed: true, cleared_first: true, verified: true, input_mode: "cdp" };
}

export async function scroll(tabId, deltaY, x = 400, y = 300) {
  await attachTab(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseWheel", x, y, deltaX: 0, deltaY: Number(deltaY) || 0
  });
  return { scrolled: true, delta_y: Number(deltaY) || 0, input_mode: "cdp" };
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

export async function typeAt(tabId, x, y, text) {
  await attachTab(tabId);
  await clickAt(tabId, x, y);
  await key(tabId, "keyDown", "a", "KeyA", 65, 2);
  await key(tabId, "keyUp", "a", "KeyA", 65, 2);
  await key(tabId, "keyDown", "Backspace", "Backspace", 8);
  await key(tabId, "keyUp", "Backspace", "Backspace", 8);
  await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text: String(text ?? "") });
  return { typed: true, cleared_first: true, input_mode: "cdp" };
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
