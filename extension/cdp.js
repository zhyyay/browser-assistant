const attachedTabs = new Set();
const attachPromises = new Map();
const operationQueues = new Map();
const pointerPositions = new Map();
// A timed-out debugger.sendCommand cannot be cancelled. Keep its promise tracked
// so a later action never overlaps an earlier command whose result is unknown.
const commandInFlight = new Map();

chrome.debugger.onDetach.addListener((source) => {
  if (Number.isInteger(source.tabId)) {
    attachedTabs.delete(source.tabId);
    pointerPositions.delete(source.tabId);
    commandInFlight.delete(source.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  attachPromises.delete(tabId);
  operationQueues.delete(tabId);
  pointerPositions.delete(tabId);
  commandInFlight.delete(tabId);
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

  const attachPromise = withTimeout(
    attachOrRecover(tabId),
    4000,
    `CDP_ATTACH_TIMEOUT: tab_id=${tabId}`
  );
  attachPromises.set(tabId, attachPromise);
  try {
    await attachPromise;
  } finally {
    if (attachPromises.get(tabId) === attachPromise) {
      attachPromises.delete(tabId);
    }
  }
}

async function send(tabId, method, params = {}, timeoutMs = 15000) {
  const previousCommand = commandInFlight.get(tabId);
  if (previousCommand) {
    throw new Error(
      `CDP_COMMAND_STILL_PENDING: tab_id=${tabId}; 上一条 CDP 命令尚未返回，拒绝并发发送 ${method}`
    );
  }

  await ensureAttached(tabId);
  let commandPromise;
  try {
    commandPromise = Promise.resolve(
      chrome.debugger.sendCommand({ tabId }, method, params)
    );
    commandInFlight.set(tabId, commandPromise);
    const clearInFlight = () => {
      if (commandInFlight.get(tabId) === commandPromise) {
        commandInFlight.delete(tabId);
      }
    };
    // Keep observing the original promise after the caller's timeout. A timeout
    // does not cancel Chrome's command, so its eventual settlement must release
    // the per-tab guard before another CDP command can be dispatched.
    commandPromise.then(clearInFlight, clearInFlight);

    return await withTimeout(
      commandPromise,
      timeoutMs,
      `CDP_COMMAND_TIMEOUT: tab_id=${tabId}, method=${method}`
    );
  } catch (error) {
    const message = String(error?.message || error);
    if (/not attached|debugger.*detached|target.*closed/i.test(message)) {
      attachedTabs.delete(tabId);
      throw new Error("CDP 会话已断开，请重新发起本次浏览器操作: " + message);
    }
    throw error;
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${message} after ${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
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
    await sleep(32);
  }

  pointerPositions.set(tabId, { x: targetX, y: targetY });
  return steps;
}

async function click(tabId, x, y) {
  const movementSteps = await movePointer(tabId, x, y);
  // Short hover and press durations make page state changes less abrupt;
  // this is reliability pacing, not an attempt to conceal automation.
  await sleep(320);
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1
  });
  await sleep(120);
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1
  });
  return movementSteps;
}

async function clearFocusedEditor(tabId, timeoutForNextCommand) {
  const key = async (type, keyName, code, vk, modifiers = 0) => send(tabId, "Input.dispatchKeyEvent", {
    type, key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers
  }, timeoutForNextCommand());
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
  if (!Number.isFinite(x) || !Number.isFinite(y) || !text) {
    throw new Error("CDP_TYPE_TEXT_INVALID: 编辑器坐标或输入文本无效");
  }

  const started = performance.now();
  const deadline = started + 25000;
  const step = async (name, operation) => {
    const stepStarted = performance.now();
    console.info("[Browser Assistant][CDP Type]", {
      stage: name, phase: "start", at: new Date().toISOString()
    });
    try {
      const result = await operation();
      console.info("[Browser Assistant][CDP Type]", {
        stage: name, phase: "done",
        elapsed_ms: Math.round(performance.now() - stepStarted)
      });
      return result;
    } catch (error) {
      console.warn("[Browser Assistant][CDP Type]", {
        stage: name, phase: "failed",
        elapsed_ms: Math.round(performance.now() - stepStarted),
        error: String(error?.message || error).slice(0, 400)
      });
      throw error;
    }
  };
  const nextCommandTimeout = () => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) {
      throw new Error("CDP_TYPE_TEXT_DEADLINE: 输入步骤总耗时超过 25 秒，未继续操作");
    }
    return Math.min(5000, remaining);
  };

  // Use one direct pointer move instead of the previous 4–18-step animated
  // movement. The old movement generated many serial CDP round trips and was
  // responsible for very long input-stage delays on some machines.
  await step("focus_editor", async () => {
    const timeout = nextCommandTimeout();
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y
    }, timeout);
    await sleep(60);
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1
    }, nextCommandTimeout());
    await sleep(45);
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1
    }, nextCommandTimeout());
  });

  if (params.clear_first !== false) {
    await step("clear_editor", async () => {
      await clearFocusedEditor(tabId, nextCommandTimeout);
      await sleep(60);
    });
  }

  // Insert the complete Unicode string in one CDP command. Every command in
  // this input sequence has a short remaining-budget timeout; a timeout fails
  // closed and prevents the caller from reaching text verification or submit.
  await step("insert_text", async () => {
    await send(tabId, "Input.insertText", { text }, nextCommandTimeout());
  });

  return {
    performed: true,
    action: "type_text",
    cleared_first: params.clear_first !== false,
    typed_graphemes: splitIntoGraphemes(text).length,
    movement_steps: 1,
    elapsed_ms: Math.round(performance.now() - started),
    input_mode: "cdp_direct_click_single_insert_text"
  };
}

async function typeTextBySelector(tabId, params) {
  const selector = String(params.selector || "");
  const text = String(params.text ?? "");
  if (!selector || !text) {
    throw new Error("CDP_TYPE_SELECTOR_INVALID: 缺少唯一编辑框选择器或输入文本");
  }

  const started = performance.now();
  const deadline = started + 25000;
  const nextCommandTimeout = () => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) {
      throw new Error("CDP_TYPE_SELECTOR_DEADLINE: 定位输入步骤总耗时超过 25 秒");
    }
    return Math.min(5000, remaining);
  };

  // Resolve the marked editor in the active page document. Refuse zero or
  // multiple matches rather than falling back to a page-wide composer.
  await send(tabId, "DOM.enable", {}, nextCommandTimeout());
  const documentResult = await send(
    tabId,
    "DOM.getDocument",
    { depth: -1, pierce: true },
    nextCommandTimeout()
  );
  const rootNodeId = Number(documentResult?.root?.nodeId || 0);
  if (!rootNodeId) throw new Error("CDP_DOM_ROOT_NOT_FOUND: 无法读取页面 DOM 根节点");

  const query = await send(
    tabId,
    "DOM.querySelectorAll",
    { nodeId: rootNodeId, selector },
    nextCommandTimeout()
  );
  const nodeIds = Array.isArray(query?.nodeIds) ? query.nodeIds : [];
  if (nodeIds.length !== 1) {
    throw new Error(
      "CDP_EDITOR_SELECTOR_NOT_UNIQUE: 目标回复编辑框定位数量为 " +
      nodeIds.length + "，拒绝输入"
    );
  }

  // DOM.focus is not consistently sufficient for X's React contenteditable.
  // First focus the exact node, then verify that the active element is either
  // the editor itself or a descendant (some editor variants focus an inner node).
  await send(tabId, "DOM.focus", { nodeId: nodeIds[0] }, nextCommandTimeout());
  await sleep(120);

  const inspectFocus = async () => {
    const checked = await send(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const editor = document.querySelector(${JSON.stringify(selector)});
        const active = document.activeElement;
        const focused = Boolean(editor && active &&
          (active === editor || editor.contains(active) || active.closest?.(${JSON.stringify(selector)}) === editor));
        return {
          focused,
          editor_found: Boolean(editor),
          editor_connected: Boolean(editor?.isConnected),
          editor_contenteditable: editor?.getAttribute("contenteditable") || null,
          active_tag: active?.tagName || null,
          active_testid: active?.getAttribute?.("data-testid") || null,
          active_is_body: active === document.body,
          document_has_focus: document.hasFocus()
        };
      })()`,
      returnByValue: true,
      awaitPromise: false
    }, nextCommandTimeout());
    return checked?.result?.value || null;
  };

  let focusState = await inspectFocus();

  // If programmatic focus did not stick, click the center of the exact
  // uniquely-marked editor through CDP's trusted input path. The selector
  // still scopes the target; never fall back to a global composer.
  if (!focusState?.focused) {
    const box = await send(tabId, "DOM.getBoxModel", {
      nodeId: nodeIds[0]
    }, nextCommandTimeout());
    const quad = box?.model?.content;
    if (Array.isArray(quad) && quad.length >= 8) {
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const x = (Math.min(...xs) + Math.max(...xs)) / 2;
      const y = (Math.min(...ys) + Math.max(...ys)) / 2;
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x, y
      }, nextCommandTimeout());
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button: "left", clickCount: 1
      }, nextCommandTimeout());
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button: "left", clickCount: 1
      }, nextCommandTimeout());
      await sleep(160);
      focusState = await inspectFocus();
    }
  }

  if (!focusState?.focused) {
    throw new Error(
      "CDP_EDITOR_FOCUS_FAILED: 无法确认目标回复编辑框获得焦点；diagnostic=" +
      JSON.stringify(focusState || { evaluation_result_missing: true })
    );
  }

  if (params.clear_first !== false) {
    await clearFocusedEditor(tabId, nextCommandTimeout);
    await sleep(60);
  }
  // Allow the verified editor to settle before inserting, then give the page\n  // time to reconcile its contenteditable/React state before the caller reads it back.\n  await sleep(250);\n  await send(\n    tabId,\n    "Input.insertText",\n    { text },\n    nextCommandTimeout()\n  );\n  await sleep(450);\n\n  return {\n    performed: true,\n    action: "type_text_selector",
    selector_match_count: 1,
    focused_verified: true,
    cleared_first: params.clear_first !== false,
    typed_graphemes: splitIntoGraphemes(text).length,
    elapsed_ms: Math.round(performance.now() - started),
    input_mode: "cdp_dom_scoped_focus_and_trusted_insert_text"
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

  if (action === "type_text_selector") {
    return typeTextBySelector(tabId, params);
  }

  if (action === "key_press") {
    const key = String(params.key || "");
    const definitions = {
      Escape: { code: "Escape", keyCode: 27, key: "Escape" }
    };
    const definition = definitions[key];
    if (!definition) throw new Error("不支持的 CDP 按键: " + key);
    const event = {
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      nativeVirtualKeyCode: definition.keyCode
    };
    try {
      await send(tabId, "Input.dispatchKeyEvent", { ...event, type: "keyDown" });
      await sleep(80);
    } finally {
      // Always attempt keyUp after keyDown, including when the page is slow.
      await send(tabId, "Input.dispatchKeyEvent", { ...event, type: "keyUp" });
    }
    return { performed: true, action, key };
  }

  if (action === "scroll") {
    let remaining = Math.max(-12000, Math.min(12000, Number(params.delta_y) || 0));
    const x = Number(params.x);
    const y = Number(params.y);
    let wheelEvents = 0;
    while (remaining !== 0) {
      const deltaY = Math.sign(remaining) * Math.min(Math.abs(remaining), 120);
      await send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, deltaX: 0, deltaY
      });
      remaining -= deltaY;
      wheelEvents++;
      await sleep(420);
    }
    await sleep(350);\n    return {\n      performed: true,\n      action,\n      wheel_events: wheelEvents,
      elapsed_ms: Math.round(performance.now() - started),
      input_mode: "cdp_background_paced"
    };
  }

  throw new Error("不支持的 CDP 输入动作: " + String(action));
}

export function dispatchCdpInput(tabId, params = {}) {
  // Keep each click/type/scroll sequence atomic per tab. This prevents two
  // concurrent Rust requests from interleaving pointer and keyboard events.
  // Each underlying CDP command has its own timeout. Do not race the whole
  // scroll operation against a shorter outer timeout: that would release the
  // queue while its mouse-wheel command could still be running in Chrome.
  return enqueueTabOperation(tabId, () => dispatchCdpInputUnlocked(tabId, params));
}
