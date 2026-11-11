const NATIVE_HOST = "com.zhyyay.browser_assistant";
let nativePort = null;
const pending = new Map();

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
    throw new Error("当前活动标签页不是可访问的 HTTP/HTTPS 网页");
  }
  return tab;
}

async function executeInPage(command, params = {}, fixedTabId = null) {
  const tab = fixedTabId === null ? await getActiveTab() : await chrome.tabs.get(fixedTabId);
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [{ command, params }],
    func: async ({ command, params }) => {
      const compact = (value, max = 500) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
      const rectOf = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + window.scrollX, y: rect.top + window.scrollY,
          viewport_x: rect.left, viewport_y: rect.top,
          width: rect.width, height: rect.height
        };
      };
      switch (command) {

        case "get_x_posts": {
          const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 100);
          const articles = [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, limit);
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
          const posts = articles.map((article, index) => {
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
            requested_limit: limit,
            posts
          };
        }
        case "get_following": {
          const currentUrl = new URL(location.href);
          const pageMatch = currentUrl.pathname.match(/^\\/([A-Za-z0-9_]{1,15})\\/following\\/?$/i);
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
                .find((link) => /^\\/[A-Za-z0-9_]{1,15}\\/?$/.test(link.getAttribute("href") || ""));
              const href = profileLink?.getAttribute("href") || null;
              const username = href ? href.replace(/^\\//, "").replace(/\\/$/, "") : null;
              const displayName = compact(
                [...(profileLink?.querySelectorAll("span") || [])]
                  .map((node) => node.innerText)
                  .find((value) => value && !value.trim().startsWith("@")) || profileLink?.innerText || "",
                120
              ).replace(/@?[A-Za-z0-9_]{1,15}/g, (value) => value.startsWith("@") ? "" : value).trim() || null;
              users.push({
                username: username ? username.toLowerCase() : null,
                display_name: displayName,
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
          if (lastCell) {
            lastCell.scrollIntoView({ block: "end", behavior: "auto" });
            if (scroller === document.scrollingElement || scroller === document.documentElement) {
              window.scrollBy({ top: Math.max(120, Math.floor(clientHeight * 0.55)), behavior: "auto" });
            }
          } else {
            scroller.scrollBy({ top: Math.max(250, Math.floor(clientHeight * 0.65)), behavior: "auto" });
          }

          // Always wait after scrolling: X may only increase scrollHeight after its
          // lazy-loaded/virtualized list reacts to reaching the current boundary.
          await new Promise((resolve) => {
            let finished = false;
            let quietTimer;
            const observer = new MutationObserver(() => {
              clearTimeout(quietTimer);
              quietTimer = setTimeout(finish, 900);
            });
            const timeout = setTimeout(finish, 3500);
            const finish = () => {
              if (finished) return;
              finished = true;
              clearTimeout(timeout);
              clearTimeout(quietTimer);
              observer.disconnect();
              resolve();
            };
            observer.observe(document.querySelector('[data-testid="primaryColumn"]') || document.body, {
              childList: true, subtree: true, characterData: true
            });
            quietTimer = setTimeout(finish, 1800);
          });
          const scrollTop = scroller.scrollTop;
          const scrollHeight = scroller.scrollHeight;
          const hasMore = scrollTop + clientHeight < scrollHeight - 30;
          const moved = scrollTop > beforeTop + 2 || scrollHeight > beforeHeight + 2;
          return {
            success: true,
            page: { url: location.href, username: pageMatch[1], type: "following" },
            batch_count: users.length,
            users,
            errors,
            scroll: { before_top: beforeTop, top: scrollTop, height: scrollHeight, viewport_height: clientHeight, has_more: hasMore, moved }
          };
        }
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
          window.scrollBy({ top: Number(params.delta_y) || 0, behavior: "auto" });
          return { scroll_y: window.scrollY };
        default:
          throw new Error("unsupported page command: " + command);
      }
    }
  });
  return injection?.result ?? null;
}

async function scanNotFollowingBack() {
  const tab = await getActiveTab();
  const initialUrl = new URL(tab.url);
  const followingMatch = initialUrl.hostname === "x.com"
    ? initialUrl.pathname.match(/^\\/([A-Za-z0-9_]{1,15})\\/following\\/?$/i)
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
          "get_page_info", "get_dom_text", "find_elements", "get_x_posts", "get_following",
          "get_element_rect", "click", "type_text", "scroll"
        ]);
        if (!allowed.has(message.command)) throw new Error("unsupported desktop command: " + message.command);
        const result = await executeInPage(message.command, message.params || {});
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
