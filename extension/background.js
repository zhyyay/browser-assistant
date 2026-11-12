import { dispatchCdpInput } from "./cdp.js";
const NATIVE_HOST = "com.zhyyay.browser_assistant";
let nativePort = null;
const pending = new Map();

function withCommandTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label}_TIMEOUT: 超过 ${timeoutMs}ms 未完成`)),
        timeoutMs
      );
    })
  ]).finally(() => clearTimeout(timer));
}

// Capture only the CreateTweet request that contains this exact reply target
// and text. A generic HTTP 200 is not sufficient: X must return the created
// tweet ID and no GraphQL errors.
async function startXReplyNetworkCapture(tabId, postId, content, timeoutMs) {
  let resolveResult;
  let settled = false;
  let timeout = null;
  const requests = new Map();
  const resultPromise = new Promise((resolve) => { resolveResult = resolve; });

  const cleanup = () => {
    if (timeout !== null) clearTimeout(timeout);
    chrome.debugger.onEvent.removeListener(onEvent);
    // Network domain is enabled only for this short confirmation window.
    chrome.debugger.sendCommand({ tabId }, "Network.disable").catch(() => {});
  };

  const finish = (result) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveResult(result);
  };

  const decodeBody = (body, base64Encoded) => {
    if (!base64Encoded) return String(body || "");
    const binary = atob(String(body || ""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  };

  const onEvent = (source, method, params = {}) => {
    if (source.tabId !== tabId || settled) return;

    if (method === "Network.requestWillBeSent") {
      const request = params.request || {};
      if (String(request.method || "").toUpperCase() !== "POST" ||
          !/(?:^|\/)CreateTweet(?:\?|$)/i.test(String(request.url || ""))) return;

      const postData = String(request.postData || "");
      let requestPayload = null;
      try { requestPayload = JSON.parse(postData); } catch {}
      const variables = requestPayload?.variables || requestPayload || {};
      const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const containsExactText = (value) => {
        if (typeof value === "string") return normalizeText(value) === normalizeText(content);
        if (Array.isArray(value)) return value.some(containsExactText);
        if (value && typeof value === "object") return Object.values(value).some(containsExactText);
        return false;
      };
      const replyTargetId =
        variables?.reply?.in_reply_to_tweet_id ||
        variables?.reply?.in_reply_to_tweet_id_str ||
        variables?.in_reply_to_tweet_id ||
        "";
      const targetMatches = String(replyTargetId) === postId ||
        (postData.includes(postId) && /in_reply_to_tweet_id/.test(postData));
      // Parse JSON first so escaped newlines/quotes do not break exact text matching.
      const textMatches = containsExactText(variables) || postData.includes(content);
      if (!targetMatches || !textMatches) return;

      requests.set(params.requestId, {
        url: String(request.url || ""),
        status: null,
        processing: false
      });
      return;
    }

    const tracked = requests.get(params.requestId);
    if (!tracked) return;

    if (method === "Network.responseReceived") {
      tracked.status = Number(params.response?.status || 0);
      tracked.responseUrl = String(params.response?.url || tracked.url);
      return;
    }

    if (method === "Network.loadingFailed") {
      finish({
        status: "unknown",
        reason: "request_failed",
        http_status: tracked.status,
        error: String(params.errorText || "Network.loadingFailed").slice(0, 300)
      });
      return;
    }

    if (method === "Network.loadingFinished" && !tracked.processing) {
      tracked.processing = true;
      (async () => {
        try {
          const response = await chrome.debugger.sendCommand(
            { tabId },
            "Network.getResponseBody",
            { requestId: params.requestId }
          );
          const bodyText = decodeBody(response?.body, response?.base64Encoded);
          let payload = null;
          try { payload = JSON.parse(bodyText); } catch {}

          const createResult = payload?.data?.create_tweet?.tweet_results?.result;
          const createdTweetId = String(
            createResult?.rest_id ||
            createResult?.legacy?.id_str ||
            createResult?.id_str ||
            ""
          );
          const errors = Array.isArray(payload?.errors) ? payload.errors : [];
          if (tracked.status >= 200 && tracked.status < 300 &&
              createdTweetId && errors.length === 0) {
            finish({
              status: "confirmed",
              http_status: tracked.status,
              created_tweet_id: createdTweetId,
              operation: "CreateTweet"
            });
            return;
          }

          finish({
            status: "unknown",
            reason: errors.length ? "graphql_errors" : "response_not_confirmed",
            http_status: tracked.status,
            graphql_errors: errors.slice(0, 3).map((item) =>
              String(item?.message || item?.code || "GraphQL error").slice(0, 300)
            ),
            response_has_created_id: Boolean(createdTweetId)
          });
        } catch (error) {
          finish({
            status: "unknown",
            reason: "response_body_unavailable",
            http_status: tracked.status,
            error: String(error?.message || error).slice(0, 300)
          });
        }
      })();
    }
  };

  chrome.debugger.onEvent.addListener(onEvent);
  try {
    // The submit click already attached CDP for input. Reuse that tab session.
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
      maxTotalBufferSize: 2 * 1024 * 1024,
      maxResourceBufferSize: 512 * 1024
    });
  } catch (error) {
    chrome.debugger.onEvent.removeListener(onEvent);
    return {
      wait: async () => ({
        status: "unavailable",
        reason: "network_domain_enable_failed",
        error: String(error?.message || error).slice(0, 300)
      }),
      cancel: () => {}
    };
  }

  timeout = setTimeout(() => finish({
    status: "unknown",
    reason: requests.size ? "response_timeout" : "matching_request_not_seen",
    matched_request_count: requests.size
  }), timeoutMs);

  return {
    wait: () => resultPromise,
    cancel: () => finish({ status: "cancelled", reason: "confirmation_cancelled" })
  };
}

const AUTOMATION_TAB_STORAGE_KEY = "xAutomationTabId";

async function getAutomationTab() {
  const stored = await chrome.storage.local.get(AUTOMATION_TAB_STORAGE_KEY);
  const rawTabId = stored?.[AUTOMATION_TAB_STORAGE_KEY];
  if (rawTabId === undefined || rawTabId === null) return null;
  const tabId = Number(rawTabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new Error("AUTOMATION_TAB_INVALID: 自动化窗口标签页标识无效，拒绝回退到个人浏览器");
  }
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new Error("AUTOMATION_TAB_CLOSED: 独立自动化窗口已关闭；为避免操作个人浏览器，已停止本次命令");
  }
}

async function waitForAutomationTabReady(tabId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && /^https?:\/\//i.test(String(tab.url || ""))) {
      return tab;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("AUTOMATION_PAGE_LOAD_TIMEOUT: 等待独立 X 窗口加载超过 30 秒");
}

async function openAutomationWindow() {
  let tab = null;
  try {
    tab = await getAutomationTab();
  } catch (error) {
    if (!String(error?.message || error).includes("AUTOMATION_TAB_CLOSED")) throw error;
    await chrome.storage.local.remove(AUTOMATION_TAB_STORAGE_KEY);
  }
  // 存储的 tabId 如果指向非 X 网站，说明记录已污染或过期。
  // 绝不把用户的 ChatGPT/其他网页标签页改导航为 X，也不复用它。
  if (tab && !/^https?:\/\/([a-z0-9-]+\.)*x\.com(?::[0-9]+)?(?:[\/?#]|$)/i.test(String(tab.url || ""))) {
    await chrome.storage.local.remove(AUTOMATION_TAB_STORAGE_KEY);
    tab = null;
  }
  const reused = Boolean(tab);
  if (tab) {
    const current = new URL(String(tab.url || "https://x.com/home"));
    const path = current.pathname.replace(/\/$/, "") || "/";
    if (path !== "/home") {
      await chrome.tabs.update(tab.id, { url: "https://x.com/home", active: false });
    }
  } else {
    const win = await chrome.windows.create({
      url: "https://x.com/home",
      focused: false,
      type: "normal"
    });
    tab = win?.tabs?.[0] || null;
    if (!tab?.id) throw new Error("AUTOMATION_WINDOW_CREATE_FAILED: Chrome 未返回自动化窗口标签页");
    await chrome.storage.local.set({ [AUTOMATION_TAB_STORAGE_KEY]: tab.id });
  }
  tab = await waitForAutomationTabReady(tab.id);
  if (!/^https?:\/\/([a-z0-9-]+\.)*x\.com(?::[0-9]+)?(?:[\/?#]|$)/i.test(String(tab.url || ""))) {
    throw new Error("AUTOMATION_TAB_WRONG_HOST: 自动化标签页不是 X；tab_id=" + tab.id + "，url=" + String(tab.url || "无"));
  }
  return {
    opened: true,
    reused,
    tab_id: tab.id,
    window_id: tab.windowId,
    focused: false,
    url: tab.url || "https://x.com/home"
  };
}

async function requireAutomationTab() {
  const tab = await getAutomationTab();
  if (!tab?.id) {
    throw new Error("AUTOMATION_WINDOW_NOT_OPEN: 尚未打开独立 X 自动化窗口");
  }
  const url = String(tab.url || "");
  if (!/^https?:\/\/([a-z0-9-]+\.)*x\.com(?::[0-9]+)?(?:[\/?#]|$)/i.test(url)) {
    throw new Error("AUTOMATION_TAB_WRONG_HOST: 拒绝操作非 X 标签页；tab_id=" + tab.id + "，window_id=" + tab.windowId + "，title=" + String(tab.title || "无") + "，url=" + (url || "无"));
  }
  return tab;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    const tabId = Number.isInteger(tab?.id) ? tab.id : "无";
    const title = String(tab?.title || "无").replace(/\s+/g, " ").slice(0, 120);
    const url = String(tab?.url || "无").slice(0, 300);
    const status = String(tab?.status || "未知");
    throw new Error(
      "当前活动标签页不是可访问的 HTTP/HTTPS 网页。" +
      "请切换到已打开的 X 网页后重试；程序不会自动切换或关闭标签页。" +
      " [tab_id=" + tabId + ", status=" + status + ", title=" + title + ", url=" + url + "]"
    );
  }
  return tab;
}

async function reloadActiveXHome() {
  // X 自动化刷新只能操作独立自动化标签页，禁止读取个人窗口的活动标签页。
  const tab = await requireAutomationTab();
  const url = new URL(tab.url);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  if (url.hostname !== "x.com" || path !== "/home") {
    throw new Error("PAGE_CHANGED: 仅允许在 X 首页时间线执行刷新");
  }
  await chrome.tabs.reload(tab.id);
  // ReloadPage 返回前等待独立自动化标签页重新完成加载，避免桌面端
  // 收到“刷新已触发”后立刻读取仍处于 loading 状态的旧页面。
  const reloadedTab = await waitForAutomationTabReady(tab.id, 30000);
  return {
    reloading: false,
    reloaded: true,
    tab_id: reloadedTab.id,
    url: reloadedTab.url,
    status: reloadedTab.status
  };
}

async function performCdpInput(params, tabId) {
  return dispatchCdpInput(tabId, params);
}

async function closeReplyComposerSafely(tabId, postId) {
  let result = await executeInPage("close_x_reply_dialog", { post_id: postId }, tabId);
  if (!result?.needs_escape) return result;

  // Use a trusted browser input event. Synthetic KeyboardEvent dispatched
  // from page JS is untrusted and X may ignore it.
  await performCdpInput({ action: "key_press", key: "Escape" }, tabId);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const state = await executeInPage("inspect_x_reply_dialog", { post_id: postId }, tabId);
  if (!state?.editor_found) {
    return {
      closed: true,
      already_closed: false,
      closed_count: 1,
      method: "cdp_escape",
      match_strategy: state?.match_strategy || result.match_strategy || "unknown"
    };
  }
  return {
    closed: false,
    reason: "CLOSE_NOT_CONFIRMED",
    method: "cdp_escape",
    match_strategy: state.match_strategy || result.match_strategy || "unknown",
    editor_found: true,
    visible_editor_count: state.visible_editor_count
  };
}

async function navigateTab(tabId, url) {
  if (!/^https:\/\//.test(url) && !/^http:\/\//.test(url)) {
    throw new Error("仅允许导航到 HTTP/HTTPS 页面");
  }
  await chrome.tabs.update(tabId, { url });
}

async function executeAutomationInPage(command, params = {}) {
  const tab = await requireAutomationTab();
  return executeInPage(command, params, tab.id);
}

// 页面状态检测也必须限定在独立自动化标签页，绝不读取用户当前活动标签页。
async function getAutomationPageInfo() {
  await openAutomationWindow();
  return executeAutomationInPage("get_page_info");
}

async function executeInPage(command, params = {}, fixedTabId = null) {
  const tab = fixedTabId === null ? await getActiveTab() : await chrome.tabs.get(fixedTabId);
  const [injection] = await withCommandTimeout(
    chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [{ command, params }],
    func: async ({ command, params }) => {
      const compact = (value, max = 500) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
      const rectOf = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + window.scrollX, y: rect.top + window.scrollY,
          viewport_x: rect.left, viewport_y: rect.top,
          width: rect.width, height: rect.height,
          viewport_width: window.innerWidth, viewport_height: window.innerHeight,
          device_pixel_ratio: window.devicePixelRatio || 1
        };
      };
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 &&
          style.visibility !== "hidden" && style.display !== "none";
      };
      // X changes composer test IDs and modal wrappers periodically. Keep the
      // selector broad enough for current contenteditable editors, but only
      // resolve an editor inside a visible modal/dialog.
      const replyEditorSelector =
        '[data-testid="tweetTextarea_0"], [data-testid^="tweetTextarea"][contenteditable="true"], [role="textbox"][contenteditable="true"], div[contenteditable="true"]';
      const replyDialogSelector =
        '[role="dialog"], [aria-modal="true"], [data-testid="sheetDialog"], [data-testid*="modal" i]';
      const findReplyEditor = (dialog) =>
        [...dialog.querySelectorAll(replyEditorSelector)].find(isVisible) || null;
      const getReplySubmitButton = (container) =>
        [...container.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')]
          .find(isVisible) || null;
      const getSubmitLabel = (button) => compact(
        button?.innerText || button?.textContent || button?.getAttribute("aria-label") || button?.getAttribute("title") || "",
        100
      );
      const isReplyDialog = (dialog, postId = "") => {
        const button = getReplySubmitButton(dialog);
        const label = getSubmitLabel(button);
        if (button && label) {
          // An explicit "Post/发帖" action is never a reply dialog.
          return /回复|^reply$/i.test(label);
        }
        // Some X variants omit visible button text. In that case only accept
        // a modal that contains the exact target status and a visible editor.
        const containsTarget = postId && [...dialog.querySelectorAll('a[href*="/status/"]')].some((link) => {
          try {
            return new URL(link.href, location.origin).pathname.match(/\/status\/(\d+)/)?.[1] === postId;
          } catch { return false; }
        });
        return Boolean(containsTarget && findReplyEditor(dialog));
      };
      const findReplyDialog = (postId) => {
        const dialogs = [...document.querySelectorAll(replyDialogSelector)].filter(isVisible);
        const editors = [...document.querySelectorAll(replyEditorSelector)].filter(isVisible);
        const replyDialogs = dialogs.filter((dialog) => isReplyDialog(dialog, postId));
        const matchesPost = (container) =>
          [...container.querySelectorAll('a[href*="/status/"]')].some((link) => {
            try {
              return new URL(link.href, location.origin).pathname.match(/\/status\/(\d+)/)?.[1] === postId;
            } catch { return false; }
          });
        const result = (dialog, editor, strategy) => ({
          dialog, editor, matched_post: true, match_strategy: strategy,
          visible_dialog_count: dialogs.length,
          reply_dialog_count: replyDialogs.length,
          visible_editor_count: editors.length
        });

        // Preferred path: a semantic dialog that contains the exact target post.
        const exact = replyDialogs.find(matchesPost);
        if (exact) {
          const editor = findReplyEditor(exact);
          if (editor) return result(exact, editor, "target_post_dialog");
        }

        // X sometimes renders the reply composer in a non-semantic wrapper
        // (no role=dialog / aria-modal). Walk upward from the sole visible
        // editor and accept only the nearest ancestor that contains the exact
        // target status AND its own reply submit control. This avoids treating
        // the global "What's happening?" composer as a reply editor.
        if (editors.length === 1) {
          const editor = editors[0];
          let ancestor = editor.parentElement;
          while (ancestor && ancestor !== document.body) {
            if (matchesPost(ancestor)) {
              const submit = getReplySubmitButton(ancestor);
              const label = getSubmitLabel(submit);
              const isReplySubmit = Boolean(submit) &&
                (/回复|^reply$/i.test(label) || submit.getAttribute("data-testid") === "tweetButtonInline");
              if (isReplySubmit) {
                return result(ancestor, editor, "target_post_ancestor");
              }
            }
            ancestor = ancestor.parentElement;
          }
        }

        const composerDialogs = replyDialogs
          .map((dialog) => ({ dialog, editor: findReplyEditor(dialog) }))
          .filter((item) => item.editor);
        if (composerDialogs.length === 1) {
          return { ...composerDialogs[0], matched_post: false, match_strategy: "single_reply_dialog_unmatched", visible_dialog_count: dialogs.length, reply_dialog_count: replyDialogs.length, visible_editor_count: editors.length };
        }
        return { dialog: null, editor: null, matched_post: false, match_strategy: "no_safe_match", visible_dialog_count: dialogs.length, reply_dialog_count: replyDialogs.length, visible_editor_count: editors.length };
      };
      switch (command) {

        case "inspect_x_reply_dialog": {
          if (location.hostname !== "x.com") throw new Error("PAGE_CHANGED: 当前不是 X 页面");
          const postId = String(params.post_id || "");
          const located = findReplyDialog(postId);
          const replyDialogs = [...document.querySelectorAll(replyDialogSelector)]
            .filter(isVisible)
            .filter((dialog) => isReplyDialog(dialog, postId));
          const detail = replyDialogs.map((dialog) => {
            const editor = findReplyEditor(dialog);
            const submit = getReplySubmitButton(dialog);
            return {
              has_editor: Boolean(editor),
              editor_testid: editor?.getAttribute("data-testid") || null,
              submit_label: getSubmitLabel(submit),
              has_close_button: Boolean(dialog.querySelector('[data-testid="app-bar-close"], [aria-label="Close"], [aria-label="关闭"]')),
              contains_target_post: [...dialog.querySelectorAll('a[href*="/status/"]')].some((link) => {
                try { return new URL(link.href, location.origin).pathname.match(/\/status\/(\d+)/)?.[1] === postId; }
                catch { return false; }
              })
            };
          });
          return {
            found: replyDialogs.length > 0 || Boolean(located.editor),
            editor_found: Boolean(located.editor),
            matched_post: Boolean(located.matched_post),
            match_strategy: located.match_strategy || "none",
            visible_dialog_count: located.visible_dialog_count,
            reply_dialog_count: replyDialogs.length,
            visible_editor_count: located.visible_editor_count,
            dialogs: detail
          };
        }

        case "close_x_reply_dialog": {
          if (location.hostname !== "x.com") throw new Error("PAGE_CHANGED: 当前不是 X 页面");
          const postId = String(params.post_id || "");
          const located = findReplyDialog(postId);
          // The composer may live in a non-semantic wrapper. Close it only when
          // the editor and reply submit control were tied to this exact post.
          if (located.dialog && located.editor && located.matched_post) {
            const target = located.dialog;
            const editor = located.editor;
            const closeButton = target.querySelector('[data-testid="app-bar-close"], [aria-label="Close"], [aria-label="关闭"]');
            if (closeButton && isVisible(closeButton)) {
              closeButton.click();
            } else {
              editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
              document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
            }
            const deadline = Date.now() + 1500;
            while (Date.now() < deadline) {
              if (!editor.isConnected || !isVisible(editor)) {
                return { closed: true, already_closed: false, closed_count: 1, method: closeButton ? "close_button" : "escape", match_strategy: located.match_strategy };
              }
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            return { closed: false, reason: "CLOSE_NOT_CONFIRMED", method: closeButton ? "close_button" : "escape", match_strategy: located.match_strategy };
          }

          const dialogs = [...document.querySelectorAll(replyDialogSelector)]
            .filter(isVisible)
            .filter((dialog) => isReplyDialog(dialog, postId));
          if (!dialogs.length) return { closed: true, already_closed: true, closed_count: 0 };
          // Close only a reply modal. Never close a compose/post dialog.
          const target = dialogs.find((dialog) => postId && [...dialog.querySelectorAll('a[href*="/status/"]')].some((link) => {
            try { return new URL(link.href, location.origin).pathname.match(/\/status\/(\d+)/)?.[1] === postId; }
            catch { return false; }
          })) || (dialogs.length === 1 ? dialogs[0] : null);
          if (!target) return { closed: false, reason: "MULTIPLE_REPLY_DIALOGS", count: dialogs.length };
          const closeButton = target.querySelector('[data-testid="app-bar-close"], [aria-label="Close"], [aria-label="关闭"]');
          if (closeButton && isVisible(closeButton)) {
            closeButton.click();
          } else {
            const keyTarget = target.querySelector('[data-testid="tweetTextarea_0"], [role="textbox"]') || target;
            keyTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
          }
          const deadline = Date.now() + 1500;
          while (Date.now() < deadline) {
            if (!target.isConnected || !isVisible(target)) {
              return { closed: true, already_closed: false, closed_count: 1, method: closeButton ? "close_button" : "escape" };
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return { closed: false, reason: "CLOSE_NOT_CONFIRMED", method: closeButton ? "close_button" : "escape" };
        }

        case "get_x_posts": {
          if (location.hostname !== "x.com" || (location.pathname !== "/home" && location.pathname !== "/home/")) {
            throw new Error("PAGE_CHANGED: 当前页面不是 X 首页时间线");
          }
          const bodyText = compact(document.body?.innerText || "", 16000);
          if (/rate limit exceeded|too many requests|try again later|请求过于频繁|操作过于频繁|暂时限制了部分功能/i.test(bodyText)) {
            throw new Error("RATE_LIMITED: 检测到 X 限流提示，已停止扫描");
          }
          if (/出错了\s*[。.]?\s*请尝试重新加载|请尝试重新加载|something went wrong.{0,40}reload|try reloading/i.test(bodyText)) {
            throw new Error("TIMELINE_RELOAD_REQUIRED: X 时间线出现“出错了，请尝试重新加载”，需要刷新恢复");
          }
          if (/(?:你已达到|已达到|达到).{0,12}(?:每日帖子上限|每日发帖上限|每日帖子限制)|you(?:'ve| have)? reached (?:your )?daily post limit|daily post limit reached|daily posting limit reached/i.test(bodyText)) {
            throw new Error("GLOBAL_STOP: DAILY_POST_LIMIT_REACHED: 检测到 X 每日帖子上限或 Premium 提示，已停止全部自动化");
          }
          if (/确认你的身份|验证你是人类|verify you are human|account access|账号访问受限|暂时锁定/i.test(bodyText)) {
            throw new Error("CHALLENGE_DETECTED: 页面出现安全验证或账号访问限制，已停止扫描");
          }
          const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 100);
          const articles = [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, limit);
          // Exclude promoted content and replies addressed to another account
          // from the candidate JSON consumed by the automatic-reply workflow.
          const classifyExcludedPost = (article) => {
            const articleText = compact(article.innerText || "", 5000);
            const tweetTextNode = article.querySelector('[data-testid="tweetText"]');
            const tweetText = compact(tweetTextNode?.innerText || "", 10000);
            const tweetStart = tweetTextNode && articleText
              ? articleText.indexOf(tweetText)
              : -1;
            // Only inspect the tweet header/context, not the body: a normal
            // post discussing ads must not be mistaken for an advertisement.
            const headerText = tweetStart >= 0 ? articleText.slice(0, tweetStart) : "";
            const socialContext = compact(
              [...article.querySelectorAll('[data-testid="socialContext"]')]
                .map((node) => node.innerText || "")
                .join(" "),
              1000
            );
            const metadataText = [
              ...[...article.querySelectorAll('[aria-label], [data-testid]')]
                .map((node) => node.getAttribute("aria-label") || node.getAttribute("data-testid") || "")
            ].join(" ");
            const disclosureText = socialContext + " " + headerText + " " + metadataText;
            const isAd = /\b(?:promoted|sponsored)\b|推广|广告|赞助内容/i.test(disclosureText);
            const replyContext = socialContext + " " + headerText;
            const isDirectedReply = /(?:replying\s+to|回复给|回复)\s*@([A-Za-z0-9_]{1,15})/i.test(replyContext);
            return isAd ? "advertisement" : isDirectedReply ? "directed_reply" : null;
          };
          const classifiedArticles = articles.map((article, index) => ({
            article,
            index,
            excludedReason: classifyExcludedPost(article)
          }));
          const eligibleArticles = classifiedArticles.filter((item) => !item.excludedReason);
          const excludedCounts = classifiedArticles.reduce((counts, item) => {
            if (item.excludedReason) {
              counts[item.excludedReason] = (counts[item.excludedReason] || 0) + 1;
            }
            return counts;
          }, {});
          const parseMetric = (value) => {
            const raw = compact(value, 80);
            if (!raw) return { raw: null, value: null };
            const match = raw.match(/[\d,.]+\s*[万亿千KMB]?/i);
            if (!match) return { raw, value: null };
            const token = match[0].replace(/,/g, "").replace(/\s/g, "");
            const number = Number.parseFloat(token);
            const suffix = token.slice(String(number).length).toLowerCase();
            const multiplier = ({ "万": 10000, "亿": 100000000, "千": 1000, "k": 1000, "m": 1000000, "b": 1000000000 })[suffix] || 1;
            return { raw, value: Number.isFinite(number) ? Math.round(number * multiplier) : null };
          };
          const posts = eligibleArticles.map(({ article, index }) => {
            const userName = article.querySelector('[data-testid="User-Name"]');
            const authorLinks = [...(userName?.querySelectorAll('a[href^="/"]') || [])]
              .filter((link) => /^\/[^/]+$/.test(link.getAttribute("href") || ""));
            const profileLink = authorLinks.find((link) => (link.innerText || "").includes("@")) || authorLinks[0] || null;
            const username = profileLink
              ? ((profileLink.innerText || "").match(/@([A-Za-z0-9_]+)/)?.[1] || profileLink.getAttribute("href")?.slice(1) || null)
              : null;
            const displayName = userName
              ? compact([...userName.querySelectorAll("span")].map((node) => node.innerText).find((value) => value && !value.startsWith("@")) || userName.innerText, 120)
              : null;
            const time = article.querySelector("time");
            const statusLink = time?.closest("a[href*='/status/']")
              || [...article.querySelectorAll('a[href*="/status/"]')].find((link) => /\/status\/\d+/.test(link.getAttribute("href") || ""));
            const href = statusLink?.getAttribute("href") || null;
            const postId = href?.match(/\/status\/(\d+)/)?.[1] || null;
            const metric = (testId) => {
              const element = article.querySelector('[data-testid="' + testId + '"]');
              return parseMetric(element?.getAttribute("aria-label") || element?.getAttribute("title") || element?.innerText);
            };
            const text = compact([...article.querySelectorAll('[data-testid="tweetText"]')].map((node) => node.innerText).join("\n"), 10000);
            const replyButton = article.querySelector('[data-testid="reply"]');
            const repostButton = article.querySelector('[data-testid="retweet"]');
            const likeButton = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
            return {
              index,
              id: postId,
              url: href ? new URL(href, location.origin).href : null,
              text,
              author: {
                display_name: displayName || null,
                username: username ? "@" + username.replace(/^@/, "") : null,
                profile_url: username ? new URL("/" + username.replace(/^@/, ""), location.origin).href : null
              },
              created_at: time?.getAttribute("datetime") || null,
              metrics: {
                replies: metric("reply"),
                reposts: metric("retweet"),
                likes: metric("like"),
                views: metric("views")
              },
              actions: {
                reply_available: Boolean(replyButton),
                repost_available: Boolean(repostButton),
                like_available: Boolean(likeButton)
              }
            };
          }).filter((post) => post.text || post.id || post.author.username);
          return {
            page: { url: location.href, title: document.title },
            count: posts.length,
            scanned_count: articles.length,
            excluded_counts: excludedCounts,
            requested_limit: limit,
            posts
          };
        }
        case "click_home_link": {
          if (location.hostname !== "x.com") throw new Error("PAGE_CHANGED: 当前不是 X 页面");
          const visible = (element) => {
            if (!(element instanceof HTMLElement)) return false;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          };
          const homeLink = [...document.querySelectorAll('a[data-testid="AppTabBar_Home_Link"], a[href="/home"], a[href="https://x.com/home"]')]
            .find(visible);
          if (!homeLink) throw new Error("HOME_LINK_NOT_FOUND: 未找到 X 主页入口");
          const rect = rectOf(homeLink);
          return { ...rect, url: location.href };
        }
        case "scroll_home_top": {
          if (location.hostname !== "x.com" || !/^\/home\/?$/.test(location.pathname)) {
            throw new Error("NOT_HOME_PAGE: 当前不是 x.com/home 页面");
          }
          return { scrolled_to_top: false, scroll_y: window.scrollY, x: Math.floor(window.innerWidth / 2), y: Math.floor(window.innerHeight / 2), device_pixel_ratio: window.devicePixelRatio || 1, url: location.href };
        }
        case "has_x_composer": {
          if (location.hostname !== "x.com") throw new Error("PAGE_CHANGED: 当前不是 X 页面");
          const editor = [...document.querySelectorAll('[data-testid="tweetTextarea_0"], [role="textbox"][data-testid="tweetTextarea_0"]')]
            .find((element) => {
              if (!(element instanceof HTMLElement)) return false;
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
            });
          return { ready: Boolean(editor), url: location.href };
        }
        case "get_x_composer_rect": {
          if (location.hostname !== "x.com") throw new Error("PAGE_CHANGED: 当前不是 X 页面");
          const editor = [...document.querySelectorAll('[data-testid="tweetTextarea_0"], [role="textbox"][data-testid="tweetTextarea_0"]')]
            .find((element) => {
              if (!(element instanceof HTMLElement)) return false;
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
            });
          if (!editor) throw new Error("COMPOSER_NOT_FOUND: 未找到 X 发帖编辑框");
          if (editor.getAttribute("aria-disabled") === "true" || editor.getAttribute("contenteditable") === "false") {
            throw new Error("COMPOSER_DISABLED: X 发帖编辑框当前不可用");
          }
          const existingText = compact(editor.innerText || editor.textContent || "", 10000);
          // The caller explicitly requested replacement semantics: the native
          // input path clicks the editor, selects all, clears it, then types.
          return { ...rectOf(editor), existing_text: existingText };
        }
        case "verify_x_composer_text": {
          const editor = document.querySelector('[data-testid="tweetTextarea_0"], [role="textbox"][data-testid="tweetTextarea_0"]');
          const actual = compact(editor?.innerText || editor?.textContent || "", 10000);
          const expected = compact(params.text || "", 10000);
          return { matches: Boolean(editor) && actual === expected, actual, expected };
        }
        case "get_x_submit_button_rect": {
          const visible = (element) => {
            if (!(element instanceof HTMLElement)) return false;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          };
          const button = [...document.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')]
            .find((element) => visible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true");
          if (!button) throw new Error("SUBMIT_BUTTON_NOT_FOUND: 未找到可用的发帖按钮");
          return rectOf(button);
        }

        case "get_x_reply_button_rect": {
          if (location.hostname !== "x.com") throw new Error("PAGE_CHANGED: 当前不是 X 页面");
          const postId = String(params.post_id || "");
          if (!/^\d{5,30}$/.test(postId)) throw new Error("INVALID_POST_ID: 推文 ID 无效");

          // 只认当前 article 自己的状态永久链接。引用推文/嵌套卡片中的
          // /status/... 链接不能代表外层帖子的 ID，否则会把回复点错。
          const ownPostId = (article) => {
            const time = article.querySelector("time");
            const timeLink = time?.closest('a[href*="/status/"]');
            // 时间戳所属链接是当前帖子自己的永久链接，优先且直接采用。
            if (timeLink && timeLink.closest('article[data-testid="tweet"]') === article) {
              try {
                return new URL(timeLink.href, location.origin).pathname.match(/\/status\/(\d+)/)?.[1] || null;
              } catch { return null; }
            }
            // 兼容没有时间戳链接的 DOM：只有当前 article 自身链接唯一时才接受。
            const ownLinks = [...article.querySelectorAll('a[href*="/status/"]')]
              .filter((link) => link.closest('article[data-testid="tweet"]') === article);
            const ids = [...new Set(ownLinks.map((link) => {
              try { return new URL(link.href, location.origin).pathname.match(/\/status\/(\d+)/)?.[1] || null; }
              catch { return null; }
            }).filter(Boolean))];
            return ids.length === 1 ? ids[0] : null;
          };
          const findTargetArticle = () => [...document.querySelectorAll('article[data-testid="tweet"]')]
            .find((item) => ownPostId(item) === postId) || null;

          let article = findTargetArticle();
          if (!article) {
            throw new Error("POST_NOT_FOUND_OR_AMBIGUOUS: 当前时间线中找不到自身状态 ID 完全匹配的推文；拒绝使用引用推文链接或列表序号猜测目标。post_id=" + postId);
          }
          // 先滚动整条目标帖子，再重新从 DOM 定位，避免虚拟列表更新后沿用旧节点/旧坐标。
          article.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
          await new Promise((resolve) => setTimeout(resolve, 350));
          article = findTargetArticle();
          if (!article || ownPostId(article) !== postId) {
            throw new Error("POST_ID_CHANGED_AFTER_SCROLL: 滚动后无法再次确认目标推文 ID，拒绝点击回复。expected=" + postId);
          }
          const button = article.querySelector('[data-testid="reply"]');
          if (!button || !isVisible(button) || button.getAttribute("aria-disabled") === "true") {
            throw new Error("REPLY_BUTTON_NOT_FOUND: 指定推文没有可用的回复按钮；post_id=" + postId);
          }
          const rect = rectOf(button);
          if (rect.viewport_x + rect.width <= 0 || rect.viewport_y + rect.height <= 0 ||
              rect.viewport_x >= window.innerWidth || rect.viewport_y >= window.innerHeight) {
            throw new Error("REPLY_BUTTON_OUTSIDE_VIEWPORT: 已定位目标推文，但回复按钮仍不在可点击视口内；post_id=" + postId);
          }
          const userName = article.querySelector('[data-testid="User-Name"]');
          const profileLink = [...(userName?.querySelectorAll('a[href^="/"]') || [])]
            .find((link) => /^\/[^/]+$/.test(link.getAttribute("href") || ""));
          const authorUsername = profileLink
            ? ((profileLink.innerText || "").match(/@([A-Za-z0-9_]+)/)?.[1] || profileLink.getAttribute("href")?.slice(1) || "")
            : "";
          const postText = compact(
            [...article.querySelectorAll('[data-testid="tweetText"]')]
              .filter((node) => node.closest('article[data-testid="tweet"]') === article)
              .map((node) => node.innerText || "")
              .join(" "),
            500
          );
          return { ...rect, post_id: postId, resolved_post_id: ownPostId(article), author_username: authorUsername, post_text: postText };
        }
        case "get_x_reply_editor_rect": {
          if (location.hostname !== "x.com") throw new Error("PAGE_CHANGED: 当前不是 X 页面");
          const postId = String(params.post_id || "");
          const located = findReplyDialog(postId);
          const dialog = located.dialog;
          const editor = located.editor;
          if (!editor) {
            const visibleEditors = [...document.querySelectorAll(replyEditorSelector)]
              .filter(isVisible)
              .map((element) => ({
                testid: element.getAttribute("data-testid"),
                role: element.getAttribute("role"),
                contenteditable: element.getAttribute("contenteditable"),
                ariaLabel: element.getAttribute("aria-label"),
                insideDialog: Boolean(element.closest(replyDialogSelector)),
                ancestorTestIds: [...(function* () { let node = element; while (node && node !== document.body) { if (node.getAttribute?.("data-testid")) yield node.getAttribute("data-testid"); node = node.parentElement; } })()].slice(0, 8)
              }));
            throw new Error(
              "REPLY_EDITOR_NOT_FOUND: 未找到唯一可用回复编辑框；visible_dialogs=" +
              located.visible_dialog_count +
              "；visible_editor_count=" + located.visible_editor_count +
              "；visible_editors=" + JSON.stringify(visibleEditors)
            );
          }
          if (editor.getAttribute("aria-disabled") === "true" || editor.getAttribute("contenteditable") === "false") {
            throw new Error("REPLY_EDITOR_DISABLED: 回复编辑框当前不可用");
          }
          return { ...rectOf(editor), post_id: postId, dialog_found: true, matched_post: Boolean(located.matched_post), match_strategy: located.match_strategy || "unknown" };
        }
        case "verify_x_reply_text": {
          const postId = String(params.post_id || "");
          const editor = findReplyDialog(postId).editor;
          const actual = compact(editor?.innerText || editor?.textContent || "", 10000);
          const expected = compact(params.text || "", 10000);
          return { matches: Boolean(editor) && actual === expected, actual, expected, post_id: postId };
        }
        case "get_x_reply_submit_button_rect": {
          const postId = String(params.post_id || "");
          const located = findReplyDialog(postId);
          const dialog = located.dialog;
          if (!dialog || !located.editor) {
            throw new Error(
              "REPLY_DIALOG_NOT_FOUND: 回复窗口已关闭或无法唯一匹配；visible_dialogs=" +
              located.visible_dialog_count + "；visible_editors=" + located.visible_editor_count
            );
          }
          const button = [...dialog.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')]
            .find((element) => isVisible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true");
          if (!button) throw new Error("REPLY_SUBMIT_BUTTON_NOT_FOUND: 未找到可用的回复提交按钮");
          return { ...rectOf(button), post_id: postId };
        }
        case "wait_x_reply_confirmation": {
          const timeoutMs = Math.min(Math.max(Number(params.confirm_timeout_ms) || 8000, 3000), 15000);
          const startedAt = Date.now();
          const visible = (element) => {
            if (!(element instanceof HTMLElement)) return false;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 &&
              style.visibility !== "hidden" && style.display !== "none";
          };
          const successPattern = /你的(?:回复|贴|帖子)已发送|回复已发送|已发送.{0,16}查看|reply sent|your reply (?:was|has been) sent|your post (?:was|has been) sent|post sent/i;
          const readSuccessToast = () => {
            const candidates = document.querySelectorAll(
              '[data-testid="toast"], [role="alert"], [data-testid*="toast" i], [aria-live="assertive"], [aria-live="polite"]'
            );
            for (const node of candidates) {
              if (!visible(node)) continue;
              const value = compact(node.innerText || node.textContent || "", 500);
              if (value && successPattern.test(value)) return value;
            }
            return null;
          };
          const immediate = readSuccessToast();
          if (immediate) {
            return {
              status: "sent", submitted: true, confirmed: true,
              confirmation: immediate, confirmation_method: "dom_snapshot",
              post_id: params.post_id
            };
          }
          return await new Promise((resolve) => {
            let finished = false;
            let observer = null;
            const timer = setTimeout(() => finish(null), timeoutMs);
            const finish = (toast) => {
              if (finished) return;
              finished = true;
              clearTimeout(timer);
              observer?.disconnect();
              if (toast) {
                resolve({
                  status: "sent", submitted: true, confirmed: true,
                  confirmation: toast, confirmation_method: "mutation_observer",
                  post_id: params.post_id
                });
              } else {
                resolve({
                  status: "confirmation_unknown", submitted: true, confirmed: false,
                  post_id: params.post_id,
                  message: "已点击回复提交按钮，但网络响应和页面成功提示均未能明确确认发送结果；请检查目标推文回复，勿直接重复提交"
                });
              }
            };
            observer = new MutationObserver(() => {
              const toast = readSuccessToast();
              if (toast) finish(toast);
            });
            observer.observe(document.documentElement, {
              childList: true, subtree: true, characterData: true
            });
            // Close the race between the first snapshot and observer attachment.
            const afterObserve = readSuccessToast();
            if (afterObserve) finish(afterObserve);
          });
        }
        case "wait_x_post_confirmation": {
          // 发帖成功提示最多等待 15 秒；Native Host 对发帖命令单独设置 120 秒上限。
          const visible = (element) => {
            if (!(element instanceof HTMLElement)) return false;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          };
          const timeoutMs = Math.min(Math.max(Number(params.confirm_timeout_ms) || 15000, 3000), 15000);
          const startedAt = Date.now();
          while (Date.now() - startedAt < timeoutMs) {
            const toast = [...document.querySelectorAll('[data-testid="toast"], [role="alert"]')]
              .filter(visible)
              .map((node) => compact(node.innerText || node.textContent || "", 500))
              .find((value) => /你的贴已发送|你的帖子已发送|post sent|your post was sent|your post has been sent/i.test(value));
            if (toast) return { status: "sent", submitted: true, confirmed: true, confirmation: toast };
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          return {
            status: "confirmation_unknown", submitted: true, confirmed: false,
            message: "已点击发帖按钮，但未检测到明确的发送成功提示；请检查个人主页，勿直接重复提交"
          };
        }
        case "get_following": {
          const currentUrl = new URL(location.href);
          const pageMatch = currentUrl.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/following\/?$/i);
          if (currentUrl.hostname !== "x.com" || !pageMatch) {
            throw new Error("PAGE_CHANGED: 当前页面不是 X 用户 Following 页面");
          }

          const bodyText = compact(document.body?.innerText || "", 16000);
          if (/rate limit exceeded|too many requests|try again later|请求过于频繁|操作过于频繁|暂时限制了部分功能/i.test(bodyText)) {
            throw new Error("RATE_LIMITED: 检测到 X 限流提示，已停止扫描");
          }
          if (/确认你的身份|验证你是人类|verify you are human|account access|账号访问受限|暂时锁定/i.test(bodyText)) {
            throw new Error("CHALLENGE_DETECTED: 页面出现安全验证或账号访问限制，已停止扫描");
          }

          const waitForCells = async () => {
            if (document.querySelector('[data-testid="UserCell"]')) return true;
            return await new Promise((resolve) => {
              let finished = false;
              const observer = new MutationObserver(() => {
                if (document.querySelector('[data-testid="UserCell"]')) finish(true);
              });
              const timer = setTimeout(() => finish(false), 10000);
              const finish = (value) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                observer.disconnect();
                resolve(value);
              };
              observer.observe(document.documentElement, { childList: true, subtree: true });
            });
          };
          if (!(await waitForCells())) throw new Error("PAGE_LOAD_TIMEOUT: 等待 Following 用户列表超时");

          const cells = [...document.querySelectorAll('[data-testid="UserCell"]')];
          const users = [];
          const errors = [];
          for (const [index, cell] of cells.entries()) {
            try {
              const text = compact(cell.innerText || "", 2000);
              const profileLink = [...cell.querySelectorAll('a[href^="/"]')]
                .find((link) => /^\/[A-Za-z0-9_]{1,15}\/?$/.test(link.getAttribute("href") || ""));
              const href = profileLink?.getAttribute("href") || null;
              const username = href ? href.replace(/^\//, "").replace(/\/$/, "") : null;
              users.push({
                username: username ? username.toLowerCase() : null,
                profile_url: username ? new URL("/" + username, location.origin).href : null,
                follow_status: username ? (/关注了你|Follows you/i.test(text) ? "mutual" : "not_mutual") : "unknown"
              });
            } catch (error) {
              errors.push({ stage: "parse_user", index, message: compact(error?.message || error, 300) });
            }
          }

          let scroller = document.scrollingElement || document.documentElement;
          const lastCell = cells[cells.length - 1];
          for (let element = lastCell?.parentElement; element && element !== document.body; element = element.parentElement) {
            const style = getComputedStyle(element);
            if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 80) {
              scroller = element;
              break;
            }
          }
          const beforeTop = scroller.scrollTop;
          const beforeHeight = scroller.scrollHeight;
          const clientHeight = scroller.clientHeight || window.innerHeight;
          const targetRect = (lastCell || scroller).getBoundingClientRect();
          return {
            success: true,
            page: { url: location.href, username: pageMatch[1], type: "following" },
            batch_count: users.length,
            users,
            errors,
            scroll: {
              before_top: beforeTop, top: beforeTop, height: beforeHeight,
              viewport_height: clientHeight, has_more: beforeTop + clientHeight < beforeHeight - 30,
              moved: false,
              x: Math.max(10, Math.min(window.innerWidth - 10, targetRect.left + targetRect.width / 2)),
              y: Math.max(10, Math.min(window.innerHeight - 10, targetRect.top + targetRect.height / 2)),
              delta_y: Math.max(180, Math.floor(clientHeight * 0.55)),
              device_pixel_ratio: window.devicePixelRatio || 1
            }
          };
        }
        case "get_following_scroll_state": {
          let scroller = document.scrollingElement || document.documentElement;
          const cells = [...document.querySelectorAll('[data-testid="UserCell"]')];
          const lastCell = cells[cells.length - 1];
          for (let element = lastCell?.parentElement; element && element !== document.body; element = element.parentElement) {
            const style = getComputedStyle(element);
            if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 80) {
              scroller = element;
              break;
            }
          }
          const top = scroller.scrollTop;
          const height = scroller.scrollHeight;
          const viewportHeight = scroller.clientHeight || window.innerHeight;
          return { top, height, viewport_height: viewportHeight, has_more: top + viewportHeight < height - 30 };
        }
        case "get_page_scroll":
          return { scroll_y: window.scrollY, x: Math.floor(window.innerWidth / 2), y: Math.floor(window.innerHeight / 2), device_pixel_ratio: window.devicePixelRatio || 1 };
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
            selector, ...rectOf(element)
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
          return rectOf(element);
        }
        case "type_text": {
          const element = document.querySelector(String(params.selector || ""));
          if (!element) throw new Error("element not found");
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) {
            throw new Error("target is not editable");
          }
          return { ...rectOf(element), tag_name: element.tagName.toLowerCase() };
        }
        case "verify_text": {
          const element = document.querySelector(String(params.selector || ""));
          const actual = compact(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element?.innerText || element?.textContent || "", 10000);
          const expected = compact(params.text ?? "", 10000);
          return { matches: Boolean(element) && actual === expected, actual, expected };
        }
        case "scroll":
          return { x: Math.floor(window.innerWidth / 2), y: Math.floor(window.innerHeight / 2), delta_y: Number(params.delta_y) || 0, scroll_y: window.scrollY, device_pixel_ratio: window.devicePixelRatio || 1 };
        default:
          throw new Error("unsupported page command: " + command);
      }
    }
    }),
    command === "scroll" ? 12000 : 20000,
    `PAGE_SCRIPT_${command}`
  );
  const result = injection?.result ?? null;
  if (!result) return result;

  if (command === "click" || command === "click_home_link" || command === "type_text") {
    let target = result;
    const topOverflow = Math.max(0, -target.viewport_y);
    const bottomOverflow = Math.max(0, target.viewport_y + target.height - target.viewport_height);
    if (command !== "click_home_link" && (topOverflow > 0 || bottomOverflow > 0)) {
      const deltaY = topOverflow > 0 ? -(topOverflow + 100) : bottomOverflow + 100;
      await performCdpInput({
        action: "scroll",
        x: Math.floor(target.viewport_width / 2),
        y: Math.floor(target.viewport_height / 2),
        delta_y: deltaY,
        scale: target.device_pixel_ratio || 1
      }, tab.id);
      await new Promise((resolve) => setTimeout(resolve, 220));
      target = await executeInPage("get_element_rect", { selector: params.selector }, tab.id);
    }
    if (command !== "type_text") {
      const x = target.viewport_x + target.width / 2;
      const y = target.viewport_y + target.height / 2;
      await performCdpInput({ action: "click", x, y, scale: target.device_pixel_ratio || 1 }, tab.id);
      return { clicked: true, url: result.url || tab.url };
    }
    await performCdpInput({
      action: "type_text",
      x: target.viewport_x + target.width / 2,
      y: target.viewport_y + target.height / 2,
      text: String(params.text ?? ""),
      clear_first: true,
      scale: target.device_pixel_ratio || 1
    }, tab.id);
    const verified = await executeInPage("verify_text", { selector: params.selector, text: String(params.text ?? "") }, tab.id);
    if (!verified?.matches) throw new Error("CONTENT_VERIFY_FAILED: 输入后回读校验不一致");
    return { typed: true, cleared_first: true, verified: true };
  }
  if (command === "scroll") {
    await performCdpInput({ action: "scroll", x: result.x, y: result.y, delta_y: result.delta_y, scale: result.device_pixel_ratio || 1 }, tab.id);
    return { scrolled: true, delta_y: result.delta_y };
  }
  if (command === "scroll_home_top") {
    let scrollY = result.scroll_y || 0;
    for (let attempt = 0; attempt < 10 && scrollY > 3; attempt++) {
      await performCdpInput({
        action: "scroll", x: result.x, y: result.y, delta_y: -4000,
        scale: result.device_pixel_ratio || 1
      }, tab.id);
      await new Promise((resolve) => setTimeout(resolve, 140));
      const state = await executeInPage("get_page_scroll", {}, tab.id);
      scrollY = state.scroll_y || 0;
    }
    return { scrolled_to_top: scrollY <= 3, scroll_y: scrollY, url: result.url };
  }
  if (command === "get_following") {
    await performCdpInput({
      action: "scroll", x: result.scroll.x, y: result.scroll.y,
      delta_y: result.scroll.delta_y, scale: result.scroll.device_pixel_ratio || 1
    }, tab.id);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const state = await executeInPage("get_following_scroll_state", {}, tab.id);
    result.scroll = {
      ...result.scroll,
      top: state.top,
      height: state.height,
      viewport_height: state.viewport_height,
      has_more: state.has_more,
      moved: state.top > result.scroll.before_top + 2 || state.height > result.scroll.height + 2
    };
    return result;
  }
  return result;
}


const POST_ENTRY_STRATEGIES = ["home_click", "compose_url", "home_top"];

function shuffled(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

async function waitForXComposer(tabId, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const state = await executeInPage("has_x_composer", {}, tabId);
      if (state?.ready) return state;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(lastError?.message || "COMPOSER_WAIT_TIMEOUT: 等待 X 发帖编辑框超时");
}

async function waitForXPath(tabId, expectedPath, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    try {
      const url = new URL(tab.url || "");
      if (url.hostname === "x.com" && url.pathname.replace(/\/$/, "") === expectedPath) return url.href;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("NAVIGATION_TIMEOUT: 等待 X 页面路径 " + expectedPath + " 超时");
}

async function enterXComposer(tabId, strategy) {
  const tab = await chrome.tabs.get(tabId);
  const url = new URL(tab.url || "");
  if (url.hostname !== "x.com") {
    throw new Error("PAGE_CHANGED: 自动发帖只允许在 x.com 标签页执行");
  }

  if (strategy === "home_click") {
    await executeInPage("click_home_link", {}, tabId);
    await waitForXPath(tabId, "/home", 10000);
    await waitForXComposer(tabId, 10000);
    return;
  }

  if (strategy === "compose_url") {
    await navigateTab(tabId, "https://x.com/compose/post");
    await waitForXPath(tabId, "/compose/post", 12000);
    await waitForXComposer(tabId, 12000);
    return;
  }

  if (strategy === "home_top") {
    if (!/^\/home\/?$/.test(url.pathname)) {
      await navigateTab(tabId, "https://x.com/home");
      await waitForXPath(tabId, "/home", 12000);
    }
    await executeInPage("scroll_home_top", {}, tabId);
    await waitForXComposer(tabId, 10000);
    return;
  }

  throw new Error("UNKNOWN_ENTRY_STRATEGY: " + strategy);
}

async function executePostXTweet(params = {}, fixedTabId = null) {
  const tab = fixedTabId === null ? await requireAutomationTab() : await chrome.tabs.get(fixedTabId);
  const initialUrl = new URL(tab.url || "");
  if (initialUrl.hostname !== "x.com") {
    throw new Error("PAGE_CHANGED: 请先在 X 页面登录并打开任意 X 页面");
  }

  const strategies = shuffled(POST_ENTRY_STRATEGIES);
  const attempts = [];
  let selectedStrategy = null;
  for (const strategy of strategies) {
    try {
      await enterXComposer(tab.id, strategy);
      selectedStrategy = strategy;
      break;
    } catch (error) {
      attempts.push({ strategy, error: String(error?.message || error) });
    }
  }

  if (!selectedStrategy) {
    const detail = attempts.map((item) => item.strategy + ": " + item.error).join(" | ");
    throw new Error("COMPOSER_ENTRY_FAILED: 三种发帖入口均未能找到编辑框。 " + detail);
  }

  const content = String(params.text ?? "").trim();
  if (!content) throw new Error("INVALID_CONTENT: 发帖内容不能为空");
  const pageState = await executeInPage("get_dom_text", { max_chars: 16000 }, tab.id);
  if (/rate limit exceeded|too many requests|try again later|请求过于频繁|操作过于频繁|暂时限制了部分功能/i.test(pageState?.text || "")) {
    throw new Error("RATE_LIMITED: 检测到 X 限流提示，未提交发帖");
  }
  if (/确认你的身份|验证你是人类|verify you are human|account access|账号访问受限|暂时锁定/i.test(pageState?.text || "")) {
    throw new Error("CHALLENGE_DETECTED: 页面出现安全验证或账号访问限制，未提交发帖");
  }

  const editor = await executeInPage("get_x_composer_rect", {}, tab.id);
  await performCdpInput({
    action: "type_text",
    x: editor.viewport_x + editor.width / 2,
    y: editor.viewport_y + editor.height / 2,
    text: content,
    clear_first: true,
    scale: editor.device_pixel_ratio || 1
  }, tab.id);
  const verified = await executeInPage("verify_x_composer_text", { text: content }, tab.id);
  if (!verified?.matches) throw new Error("CONTENT_VERIFY_FAILED: 发帖内容输入后校验不一致，未点击提交");

  const submit = await executeInPage("get_x_submit_button_rect", {}, tab.id);
  // Submit exactly once. Never retry or switch entry after this OS-level click.
  await performCdpInput({
    action: "click",
    x: submit.viewport_x + submit.width / 2,
    y: submit.viewport_y + submit.height / 2,
    scale: submit.device_pixel_ratio || 1
  }, tab.id);
  const result = await executeInPage("wait_x_post_confirmation", params, tab.id);
  return {
    ...result,
    entry_strategy: selectedStrategy,
    attempted_strategies: [...attempts.map((item) => item.strategy), selectedStrategy],
    input_mode: "chrome_devtools_protocol"
  };
}


async function executeReplyToXPost(params = {}, fixedTabId = null) {
  const tab = fixedTabId === null ? await requireAutomationTab() : await chrome.tabs.get(fixedTabId);
  const initialUrl = new URL(tab.url || "");
  if (initialUrl.hostname !== "x.com") {
    throw new Error("PAGE_CHANGED: 请先打开 X 时间线页面");
  }
  const postId = String(params.post_id || "").trim();
  if (!/^\d{5,30}$/.test(postId)) throw new Error("INVALID_POST_ID: 必须传入解析推文时返回的数字 ID");
  const content = String(params.text ?? "").trim();
  if (!content) throw new Error("INVALID_CONTENT: 回复内容不能为空");

  const interactionTrace = [];
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const runPacedInput = async (stage, input) => {
    const started = performance.now();
    const result = await performCdpInput(input, tab.id);
    interactionTrace.push({
      stage,
      elapsed_ms: Math.round(performance.now() - started),
      ...result
    });
    return result;
  };

  const pageState = await executeInPage("get_dom_text", { max_chars: 16000 }, tab.id);
  if (/rate limit exceeded|too many requests|try again later|请求过于频繁|操作过于频繁|暂时限制了部分功能/i.test(pageState?.text || "")) {
    throw new Error("RATE_LIMITED: 检测到 X 限流提示，未提交回复");
  }
  if (/(?:你已达到|已达到|达到).{0,12}(?:每日帖子上限|每日发帖上限|每日帖子限制)|you(?:'ve| have)? reached (?:your )?daily post limit|daily post limit reached|daily posting limit reached/i.test(pageState?.text || "")) {
    throw new Error("GLOBAL_STOP: DAILY_POST_LIMIT_REACHED: 检测到 X 每日帖子上限或 Premium 提示，已停止全部自动化");
  }
  if (/确认你的身份|验证你是人类|verify you are human|account access|账号访问受限|暂时锁定/i.test(pageState?.text || "")) {
    throw new Error("CHALLENGE_DETECTED: 页面出现安全验证或账号访问限制，未提交回复");
  }

  // Resolve the exact post by its own status ID; never fall back to list index or guessed coordinates.
  const replyButton = await executeInPage("get_x_reply_button_rect", { post_id: postId }, tab.id);
  const resolvedPostId = String(replyButton?.resolved_post_id || replyButton?.post_id || "");
  if (resolvedPostId !== postId) {
    throw new Error(
      "POST_ID_VERIFY_FAILED: 回复按钮定位结果与待回复帖子 ID 不一致；expected=" +
      postId + "，resolved=" + (resolvedPostId || "missing") + "；拒绝点击"
    );
  }
  interactionTrace.push({
    stage: "resolve_target_post",
    elapsed_ms: 0,
    post_id: postId,
    resolved_post_id: resolvedPostId,
    author_username: String(replyButton?.author_username || ""),
    post_text: String(replyButton?.post_text || "").slice(0, 180)
  });
  await runPacedInput("open_reply_composer", {
    action: "click",
    x: replyButton.viewport_x + replyButton.width / 2,
    y: replyButton.viewport_y + replyButton.height / 2,
    clear_first: false
  });
  await pause(350);

  let editor = null;
  let lastError = null;
  let lastDialogState = null;
  const editorDeadline = Date.now() + 15000;
  while (Date.now() < editorDeadline) {
    try {
      lastDialogState = await executeInPage("inspect_x_reply_dialog", { post_id: postId }, tab.id);
      if (lastDialogState?.editor_found) {
        editor = await executeInPage("get_x_reply_editor_rect", { post_id: postId }, tab.id);
        break;
      }
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      if (!message.includes("REPLY_DIALOG_NOT_FOUND") &&
          !message.includes("REPLY_EDITOR_NOT_FOUND")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!editor) {
    let closeResult = null;
    try {
      closeResult = await closeReplyComposerSafely(tab.id, postId);
    } catch (closeError) {
      closeResult = { closed: false, error: String(closeError?.message || closeError) };
    }
    const diagnostic = String(lastError?.message || lastError || "none");
    throw new Error(
      "REPLY_EDITOR_TIMEOUT: 等待目标推文回复编辑框超时；" +
      "dialog_state=" + JSON.stringify(lastDialogState) +
      "；diagnostic=" + diagnostic +
      "；close_result=" + JSON.stringify(closeResult)
    );
  }

  await pause(250);
  await runPacedInput("type_reply_text", {
    action: "type_text",
    x: editor.viewport_x + editor.width / 2,
    y: editor.viewport_y + editor.height / 2,
    text: content,
    clear_first: true
  });
  const verified = await executeInPage("verify_x_reply_text", { post_id: postId, text: content }, tab.id);
  if (!verified?.matches) {
    // This branch is strictly before the submit button is resolved or clicked.
    // Close only the reply composer belonging to this exact post, then confirm
    // it is gone before allowing the desktop runner to continue to another post.
    let closeResult;
    try {
      closeResult = await closeReplyComposerSafely(tab.id, postId);
    } catch (error) {
      closeResult = { closed: false, error: String(error?.message || error) };
    }
    if (!closeResult?.closed) {
      throw new Error(
        "REPLY_COMPOSER_CLOSE_FAILED: 回复文本校验失败且无法确认关闭当前回复框；" +
        "未点击发送，必须停止自动化。close_result=" + JSON.stringify(closeResult)
      );
    }
    throw new Error(
      "REPLY_CONTENT_VERIFY_FAILED: 回复内容输入后校验不一致，未提交；" +
      "COMPOSER_CLOSED=" + JSON.stringify(closeResult)
    );
  }

  const submit = await executeInPage("get_x_reply_submit_button_rect", { post_id: postId }, tab.id);
  const confirmTimeoutMs = Math.min(Math.max(Number(params.confirm_timeout_ms) || 8000, 3000), 15000);

  // Arm network observation before the single submit click. Failure to observe
  // CDP network traffic never causes a second click; Toast remains a fallback.
  const networkCapture = await startXReplyNetworkCapture(
    tab.id, postId, content, confirmTimeoutMs
  );

  // Let the verified draft settle before the single submit action.
  await pause(500);
  // Submit once only. An uncertain confirmation must never trigger an automatic retry.
  await runPacedInput("submit_reply", {
    action: "click",
    x: submit.viewport_x + submit.width / 2,
    y: submit.viewport_y + submit.height / 2
  });

  const networkPromise = networkCapture.wait();
  const pagePromise = executeInPage("wait_x_reply_confirmation", {
    post_id: postId,
    confirm_timeout_ms: confirmTimeoutMs
  }, tab.id);
  const firstConfirmation = await Promise.race([
    networkPromise.then(
      (result) => ({ source: "network", result }),
      (error) => ({ source: "network_error", error })
    ),
    pagePromise.then(
      (result) => ({ source: "page", result }),
      (error) => ({ source: "page_error", error })
    )
  ]);

  if (firstConfirmation.source === "network" &&
      firstConfirmation.result?.status === "confirmed") {
    return {
      status: "sent",
      submitted: true,
      confirmed: true,
      confirmation_source: "cdp_create_tweet_response",
      network_confirmation: firstConfirmation.result,
      post_id: postId,
      created_tweet_id: firstConfirmation.result.created_tweet_id,
      message: "已通过 X CreateTweet 网络响应确认回复已发送",
      interaction_trace: interactionTrace,
      input_mode: "chrome_devtools_protocol_paced"
    };
  }

  if (firstConfirmation.source === "page" &&
      firstConfirmation.result?.status === "sent") {
    networkCapture.cancel();
    return {
      ...firstConfirmation.result,
      confirmation_source: "x_success_toast",
      network_confirmation: { status: "not_needed_to_confirm" },
      interaction_trace: interactionTrace,
      input_mode: "chrome_devtools_protocol_paced"
    };
  }

  const [networkSettled, pageSettled] = await Promise.allSettled([
    networkPromise,
    pagePromise
  ]);
  const networkResult = networkSettled.status === "fulfilled"
    ? networkSettled.value
    : {
        status: "unavailable",
        reason: "network_capture_failed",
        error: String(networkSettled.reason?.message || networkSettled.reason).slice(0, 300)
      };
  const pageResult = pageSettled.status === "fulfilled"
    ? pageSettled.value
    : {
        status: "confirmation_unknown",
        message: "页面提示检测失败：" + String(pageSettled.reason?.message || pageSettled.reason).slice(0, 300)
      };

  if (networkResult.status === "confirmed") {
    return {
      status: "sent",
      submitted: true,
      confirmed: true,
      confirmation_source: "cdp_create_tweet_response",
      network_confirmation: networkResult,
      post_id: postId,
      created_tweet_id: networkResult.created_tweet_id,
      message: "已通过 X CreateTweet 网络响应确认回复已发送",
      interaction_trace: interactionTrace,
      input_mode: "chrome_devtools_protocol_paced"
    };
  }

  if (pageResult?.status === "sent") {
    return {
      ...pageResult,
      confirmation_source: "x_success_toast",
      network_confirmation: networkResult,
      interaction_trace: interactionTrace,
      input_mode: "chrome_devtools_protocol_paced"
    };
  }

  return {
    ...pageResult,
    status: "confirmation_unknown",
    submitted: true,
    confirmed: false,
    confirmation_source: null,
    network_confirmation: networkResult,
    post_id: postId,
    message: "已点击回复提交按钮，但网络响应和页面提示均未能明确确认发送结果；请检查目标推文回复，勿直接重复提交",
    interaction_trace: interactionTrace,
    input_mode: "chrome_devtools_protocol_paced"
  };
}

async function scanNotFollowingBack() {
  const tab = await getActiveTab();
  const initialUrl = new URL(tab.url);
  const followingMatch = initialUrl.hostname === "x.com"
    ? initialUrl.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/following\/?$/i)
    : null;
  if (!followingMatch) {
    throw new Error("PAGE_CHANGED: 请先打开 https://x.com/{用户名}/following 页面");
  }

  const authorization = await nativeRequest("authorize_command", { action: "get_following" });
  if (!authorization?.ok || !authorization.result?.authorized) {
    throw new Error(authorization?.error || "Rust Host rejected the Following scan");
  }

  const users = new Map();
  const errors = [];
  let page = { url: tab.url, username: followingMatch[1], type: "following" };
  let rounds = 0;
  let consecutiveEmpty = 0;
  let stagnantRounds = 0;
  let scanComplete = false;
  let stopReason = "max_rounds_reached";
  let retryCount = 0;

  const classifyError = (message) => {
    const value = String(message || "");
    if (value.includes("RATE_LIMITED")) return "rate_limited";
    if (value.includes("CHALLENGE_DETECTED")) return "challenge_detected";
    if (value.includes("PAGE_CHANGED") || value.includes("not X")) return "page_changed";
    if (value.includes("PAGE_LOAD_TIMEOUT")) return "page_load_timeout";
    if (/No tab|tab.*not found|Cannot access contents|Frame.*removed/i.test(value)) return "tab_closed";
    return "page_error";
  };
  const snapshot = (success, reason) => {
    const all = [...users.values()];
    const notFollowingBack = all.filter((user) => user.follow_status === "not_mutual");
    const mutualCount = all.filter((user) => user.follow_status === "mutual").length;
    return {
      success,
      page,
      scan_complete: scanComplete,
      stop_reason: reason,
      total: all.length,
      scanned: all.length,
      mutual_count: mutualCount,
      not_following_back_count: notFollowingBack.length,
      unknown_count: all.length - mutualCount - notFollowingBack.length,
      rounds,
      retry_count: retryCount,
      users: notFollowingBack,
      errors
    };
  };

  while (rounds < 100) {
    let batch = null;
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const currentTab = await chrome.tabs.get(tab.id);
        const current = new URL(currentTab.url || "");
        if (current.origin !== initialUrl.origin || current.pathname !== initialUrl.pathname) {
          throw new Error("PAGE_CHANGED: 扫描期间目标页面发生变化");
        }
        batch = await executeInPage("get_following", {}, tab.id);
        break;
      } catch (error) {
        lastError = error;
        const reason = classifyError(error?.message || error);
        if (reason === "rate_limited" || reason === "challenge_detected" ||
            reason === "page_changed" || reason === "tab_closed") {
          stopReason = reason;
          errors.push({ stage: "scan_batch", round: rounds + 1, message: String(error?.message || error) });
          return snapshot(false, stopReason);
        }
        retryCount++;
        errors.push({ stage: "load_users", round: rounds + 1, attempt: attempt + 1, message: String(error?.message || error) });
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
      }
    }
    if (!batch) {
      stopReason = classifyError(lastError?.message || lastError);
      return snapshot(false, stopReason);
    }
    if (!batch.success) {
      stopReason = "unknown_error";
      errors.push({ stage: "parse_batch", round: rounds + 1, message: "页面返回无效批次" });
      return snapshot(false, stopReason);
    }

    page = batch.page || page;
    if (Array.isArray(batch.errors)) errors.push(...batch.errors.map((item) => ({ ...item, round: rounds + 1 })));
    const before = users.size;
    for (const [index, user] of (batch.users || []).entries()) {
      const username = user.username ? String(user.username).toLowerCase() : null;
      if (!username) {
        errors.push({ stage: "deduplicate_user", round: rounds + 1, index, message: "用户卡片缺少可识别用户名，已保留 unknown 记录" });
      }
      const key = username ? "@" + username : user.profile_url || (user.display_name ? "name:" + user.display_name : "unknown:" + rounds + ":" + index);
      if (!users.has(key)) users.set(key, user);
      else if (users.get(key).follow_status === "unknown" && user.follow_status !== "unknown") users.set(key, user);
    }

    const added = users.size - before;
    consecutiveEmpty = added === 0 ? consecutiveEmpty + 1 : 0;
    rounds++;
    const scroll = batch.scroll || {};
    stagnantRounds = scroll.moved ? 0 : stagnantRounds + 1;

    if (!scroll.has_more) {
      scanComplete = true;
      stopReason = "reached_bottom";
      break;
    }
    if (consecutiveEmpty >= 5 && stagnantRounds >= 3) {
      stopReason = "no_new_users";
      break;
    }
    if (stagnantRounds >= 5) {
      stopReason = "scroll_stalled";
      break;
    }
    if (rounds >= 100) break;

    await new Promise((resolve) => setTimeout(resolve, 1800 + Math.floor(Math.random() * 1201)));
    if (rounds % 8 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 12000 + Math.floor(Math.random() * 9001)));
    }
  }

  return snapshot(scanComplete, stopReason);
}

function handleNativeMessage(message) {
  if (message.type === "desktop_command" && message.id) {
    (async () => {
      try {
        const allowed = new Set([
          "open_automation_window", "get_page_info", "reload_page", "get_dom_text", "find_elements", "get_x_posts", "post_x_tweet", "reply_to_x_post", "get_following",
          "get_element_rect", "click", "type_text", "scroll", "scroll_automation"
        ]);
        if (!allowed.has(message.command)) throw new Error("unsupported desktop command: " + message.command);
        const result = message.command === "open_automation_window"
          ? await openAutomationWindow()
          : message.command === "get_page_info"
            ? await getAutomationPageInfo()
          : message.command === "reload_page"
            ? await reloadActiveXHome()
          : message.command === "post_x_tweet"
            ? await executePostXTweet(message.params || {})
            : message.command === "reply_to_x_post"
              ? await executeReplyToXPost(message.params || {})
              : message.command === "get_x_posts"
                ? await executeAutomationInPage("get_x_posts", message.params || {})
                : message.command === "scroll_automation"
                  ? await executeAutomationInPage("scroll", message.params || {})
                  : await executeAutomationInPage(message.command, message.params || {});
        nativePort?.postMessage({ id: message.id, ok: true, result });
      } catch (error) {
        nativePort?.postMessage({ id: message.id, ok: false, error: error.message || String(error) });
      }
    })();
    return;
  }
  const waiter = pending.get(message.id);
  if (waiter) {
    pending.delete(message.id);
    waiter.resolve(message);
  }
}

function connectNative() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort.onMessage.addListener(handleNativeMessage);
  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || "Native Host disconnected";
    for (const waiter of pending.values()) waiter.reject(new Error(error));
    pending.clear();
    nativePort = null;
  });
  return nativePort;
}

function nativeRequest(command, params = {}, timeoutMs = 5000) {
  const port = connectNative();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Native Host request timed out"));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); }
    });
    port.postMessage({ id, command, params });
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "native_ping") {
        sendResponse(await nativeRequest("ping"));
        return;
      }
      if (message.type === "scan_not_following_back") {
        const result = await scanNotFollowingBack();
        sendResponse({ ok: true, result, authorized_by: "rust-native-host" });
        return;
      }
      if (message.type === "page_command") {
        const authorization = await nativeRequest("authorize_command", { action: message.command });
        if (!authorization?.ok || !authorization.result?.authorized) {
          throw new Error(authorization?.error || "Rust Host rejected the command");
        }
        const result = message.command === "open_automation_window"
          ? await openAutomationWindow()
          : message.command === "get_page_info"
            ? await getAutomationPageInfo()
          : message.command === "reload_page"
            ? await reloadActiveXHome()
          : message.command === "post_x_tweet"
            ? await executePostXTweet(message.params || {})
            : message.command === "reply_to_x_post"
              ? await executeReplyToXPost(message.params || {})
              : message.command === "get_x_posts"
                ? await executeAutomationInPage("get_x_posts", message.params || {})
                : message.command === "scroll_automation"
                  ? await executeAutomationInPage("scroll", message.params || {})
                  : await executeAutomationInPage(message.command, message.params || {});
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


// Keep the Native Messaging bridge available for the desktop app.
// Chrome starts the service worker for these lifecycle events; connectNative()
// launches the registered Native Host without requiring a popup click.
function ensureNativeHostConnected(reason) {
  try {
    connectNative();
    console.info("[Browser Assistant] Native Host connection requested:", reason);
  } catch (error) {
    console.warn("[Browser Assistant] Native Host connection failed:", reason, error);
  }
}

chrome.runtime.onStartup.addListener(() => ensureNativeHostConnected("chrome_startup"));
chrome.runtime.onInstalled.addListener(() => ensureNativeHostConnected("extension_installed"));
