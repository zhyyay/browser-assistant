const attachedTabs = new Set();
const attachPromises = new Map();
const operationQueues = new Map();
const pointerPositions = new Map();

chrome.debugger.onDetach.addListener((source) => {
  if (Number.isInteger(source.tabId)) {
    attachedTabs.delete(source.tabId);
    pointerPositions.delete(source.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  attachPromises.delete(tabId);
  operationQueues.delete(tabId);
  pointerPositions.delete(tabId);
});

function enqueueTabOperation(tabId, operation) {
  const previous = operationQueues.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  operationQueues.set(tabId, current);

  return current.finally(() => {
    if (operationQueues.get(tabId) === current) {
      operationQueues.delete(tabId);
    }
  });
}

function isDebuggerConflict(message) {
  return /already attached|another debugger|another extension|debugger is already attached|not attached to the tab/i.test(message);
}

async function attachOrRecover(tabId) {
  const targets = await chrome.debugger.getTargets();
  const target = targets.find((item) => item.type === "page" && item.tabId === tabId);

  if (target?.attached) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Browser.getVersion");
      attachedTabs.add(tabId);
      return;
    } catch (error) {
      const message = String(error?.message || error);
      throw new Error(
        "目标标签页已被其他调试器占用，或当前扩展无法恢复原 CDP 会话: " + message
      );
    }
  }

  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.add(tabId);
  } catch (error) {
    const message = String(error?.message || error);
    if (isDebuggerConflict(message)) {
      throw new Error("目标标签页已被 DevTools 或其他调试器占用，无法附加 CDP");
    }
    throw new Error("无法附加 Chrome CDP 调试器: " + message);
  }
}

async function ensureAttached(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new Error("CDP 操作缺少有效标签页 ID");
  }
  if (attachedTabs.has(tabId)) return;

  const pending = attachPromises.get(tabId);
  if (pending) {
    await pending;
    return;
  }

  const attachPromise = attachOrRecover(tabId);
  attachPromises.set(tabId, attachPromise);
  try {
    await attachPromise;
  } finally {
    if (attachPromises.get(tabId) === attachPromise) {
      attachPromises.delete(tabId);
    }
  }
}

async function send(tabId, method, params = {}) {
  await ensureAttached(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (error) {
    const message = String(error?.message || error);
    if (/not attached|debugger.*detached|target.*closed/i.test(message)) {
      attachedTabs.delete(tabId);
      throw new Error("CDP 会话已断开，请重新发起本次浏览器操作: " + message);
    }
    throw error;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function movePointer(tabId, x, y) {
  const targetX = Number(x);
  const targetY = Number(y);
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
    throw new Error("CDP 鼠标坐标无效");
  }

  const previous = pointerPositions.get(tabId);
  if (!previous) {
    // CDP input events are scoped to the tab and do not move the Windows cursor.
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: targetX, y: targetY
    });
    pointerPositions.set(tabId, { x: targetX, y: targetY });
    return 1;
  }

  const distance = Math.hypot(targetX - previous.x, targetY - previous.y);
  const steps = Math.max(4, Math.min(18, Math.ceil(distance / 35)));
  const control1 = {
    x: previous.x + (targetX - previous.x) * 0.32,
    y: previous.y + (targetY - previous.y) * 0.18
  };
  const control2 = {
    x: previous.x + (targetX - previous.x) * 0.78,
    y: previous.y + (targetY - previous.y) * 0.86
  };

  for (let index = 1; index <= steps; index++) {
    const t = index / steps;
    const inverse = 1 - t;
    const point = {
      x: inverse ** 3 * previous.x +
        3 * inverse ** 2 * t * control1.x +
        3 * inverse * t ** 2 * control2.x +
        t ** 3 * targetX,
      y: inverse ** 3 * previous.y +
        3 * inverse ** 2 * t * control1.y +
        3 * inverse * t ** 2 * control2.y +
        t ** 3 * targetY
    };
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: point.x, y: point.y
    });
    await sleep(12);
  }

  pointerPositions.set(tabId, { x: targetX, y: targetY });
  return steps;
}

async function click(tabId, x, y) {
  const movementSteps = await movePointer(tabId, x, y);
  // Short hover and press durations make page state changes less abrupt;
  // this is reliability pacing, not an attempt to conceal automation.
  await sleep(140);
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1
  });
  await sleep(75);
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1
  });
  return movementSteps;
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

function splitIntoGraphemes(text) {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
      .map((item) => item.segment);
  }
  return Array.from(text);
}

function isSentencePunctuation(value) {
  return /[，。！？；：,.!?;:]$/.test(value);
}

async function typeText(tabId, params) {
  const x = Number(params.x);
  const y = Number(params.y);
  const text = String(params.text ?? "");
  const started = performance.now();
  const movementSteps = await click(tabId, x, y);
  await sleep(160);
  if (params.clear_first !== false) {
    await clearFocusedEditor(tabId);
    await sleep(100);
  }

  const graphemes = splitIntoGraphemes(text);
  for (const grapheme of graphemes) {
    await send(tabId, "Input.insertText", { text: grapheme });
    // A steady cadence keeps input events separated so the editor can process
    // IME/CJK and rich-text updates reliably. Punctuation gets a brief pause.
    await sleep(isSentencePunctuation(grapheme) ? 125 : 42);
  }

  return {
    performed: true,
    action: "type_text",
    cleared_first: params.clear_first !== false,
    typed_graphemes: graphemes.length,
    movement_steps: movementSteps,
    elapsed_ms: Math.round(performance.now() - started),
    input_mode: "cdp_background_paced"
  };
}

async function dispatchCdpInputUnlocked(tabId, params = {}) {
  const action = params.action;
  const started = performance.now();
  if (action === "click") {
    const movementSteps = await click(tabId, Number(params.x), Number(params.y));
    return {
      performed: true,
      action,
      movement_steps: movementSteps,
      elapsed_ms: Math.round(performance.now() - started),
      input_mode: "cdp_background_paced"
    };
  }

  if (action === "type_text") {
    return typeText(tabId, params);
  }

  if (action === "scroll") {
    let remaining = Math.max(-12000, Math.min(12000, Number(params.delta_y) || 0));
    const x = Number(params.x);
    const y = Number(params.y);
    let wheelEvents = 0;
    while (remaining !== 0) {
      const deltaY = Math.sign(remaining) * Math.min(Math.abs(remaining), 260);
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, deltaX: 0, deltaY
      });
      remaining -= deltaY;
      wheelEvents++;
      await sleep(130);
    }
    await sleep(180);
    return {
      performed: true,
      action,
      wheel_events: wheelEvents,
      elapsed_ms: Math.round(performance.now() - started),
      input_mode: "cdp_background_paced"
    };
  }

  throw new Error("不支持的 CDP 输入动作: " + String(action));
}

export function dispatchCdpInput(tabId, params = {}) {
  // Keep each click/type/scroll sequence atomic per tab. This prevents two
  // concurrent Rust requests from interleaving pointer and keyboard events.
  return enqueueTabOperation(tabId, () => dispatchCdpInputUnlocked(tabId, params));
}
