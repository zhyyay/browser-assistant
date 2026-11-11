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
    func: ({ command, params }) => {
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
          const limit = Math.min(Math.max(Number(params.limit) || 30, 1), 50);
          const currentUrl = new URL(location.href);
          const pageMatch = currentUrl.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/following\/?$/i);
          if (currentUrl.hostname !== "x.com" || !pageMatch) {
            throw new Error("当前页面不是 X 用户 Following 页面；请打开 https://x.com/{用户名}/following 后重试");
          }

          const pageText = compact(document.body?.innerText || "", 12000);
          if (/rate limit exceeded|too many requests|try again later|请求过于频繁|操作过于频繁|暂时限制了部分功能/i.test(pageText)) {
            throw new Error("检测到 X 限流提示，已停止 Following 扫描；请稍后手动恢复");
          }

          const cells = [...document.querySelectorAll('[data-testid="UserCell"]')].slice(0, limit);
          const users = cells.map((cell) => {
            const text = compact(cell.innerText || "", 2000);
            const profileLink = [...cell.querySelectorAll('a[href^="/"]')]
              .find((link) => /^\/[A-Za-z0-9_]{1,15}\/?$/.test(link.getAttribute("href") || ""));
            const href = profileLink?.getAttribute("href") || null;
            const username = href ? href.replace(/^\//, "").replace(/\/$/, "") : null;
            const displayName = compact(
              [...(profileLink?.querySelectorAll("span") || [])]
                .map((node) => node.innerText)
                .find((value) => value && !value.trim().startsWith("@")) || profileLink?.innerText || "",
              120
            ).replace(/@?[A-Za-z0-9_]{1,15}/g, (value) => value.startsWith("@") ? "" : value).trim() || null;
            const followsYou = /关注了你|Follows you/i.test(text);
            return {
              username: username ? username.toLowerCase() : null,
              display_name: displayName,
              profile_url: username ? new URL("/" + username, location.origin).href : null,
              follow_status: username ? (followsYou ? "mutual" : "not_mutual") : "unknown"
            };
          });

          let scroller = document.scrollingElement || document.documentElement;
          const firstCell = cells[0];
          for (let element = firstCell?.parentElement; element && element !== document.body; element = element.parentElement) {
            const style = getComputedStyle(element);
            if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 80) {
              scroller = element;
              break;
            }
          }
          const beforeTop = scroller.scrollTop;
          const clientHeight = scroller.clientHeight || window.innerHeight;
          const scrollHeight = scroller.scrollHeight || document.documentElement.scrollHeight;
          scroller.scrollBy({ top: Math.max(300, Math.floor(clientHeight * 0.85)), behavior: "auto" });
          const scrollTop = scroller.scrollTop;
          const hasMore = scrollTop + clientHeight < scrollHeight - 20;
          return {
            success: true,
            page: { url: location.href, username: pageMatch[1], type: "following" },
            batch_count: users.length,
            users,
            scroll: { before_top: beforeTop, top: scrollTop, height: scrollHeight, viewport_height: clientHeight, has_more: hasMore }
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
  const authorization = await nativeRequest("authorize_command", { action: "get_following" });
  if (!authorization?.ok || !authorization.result?.authorized) {
    throw new Error(authorization?.error || "Rust Host rejected the Following scan");
  }

  const users = new Map();
  let page = null;
  let rounds = 0;
  let consecutiveEmpty = 0;
  let scanComplete = false;
  let stopReason = "unknown";

  while (rounds < 100) {
    const batch = await executeInPage("get_following", { limit: 30 }, tab.id);
    if (!batch?.success) throw new Error("Following 页面扫描返回了无效结果");

    page = batch.page || page;
    const before = users.size;
    for (const [index, user] of (batch.users || []).entries()) {
      const key = user.username
        ? "@" + user.username.toLowerCase()
        : user.profile_url || (user.display_name ? "name:" + user.display_name : "unknown:" + rounds + ":" + index);
      if (!users.has(key)) users.set(key, user);
    }

    const added = users.size - before;
    consecutiveEmpty = added === 0 ? consecutiveEmpty + 1 : 0;
    rounds += 1;

    if (!batch.scroll?.has_more) {
      scanComplete = true;
      stopReason = "reached_bottom";
      break;
    }
    if (consecutiveEmpty >= 5) {
      stopReason = "no_new_users_after_5_rounds";
      break;
    }
    if (rounds >= 100) {
      stopReason = "maximum_rounds_reached";
      break;
    }

    // Conservative pacing: one DOM batch every 3–5 seconds, plus a longer rest every 8 batches.
    await new Promise((resolve) => setTimeout(resolve, 3000 + Math.floor(Math.random() * 2001)));
    if (rounds % 8 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20000 + Math.floor(Math.random() * 10001)));
    }
  }

  const allUsers = [...users.values()];
  const notFollowingBack = allUsers.filter((user) => user.follow_status === "not_mutual");
  const mutualCount = allUsers.filter((user) => user.follow_status === "mutual").length;
  const unknownCount = allUsers.length - mutualCount - notFollowingBack.length;

  return {
    success: true,
    page,
    scan_complete: scanComplete,
    stop_reason: stopReason,
    total: allUsers.length,
    scanned: allUsers.length,
    mutual_count: mutualCount,
    not_following_back_count: notFollowingBack.length,
    unknown_count: unknownCount,
    users: notFollowingBack
  };
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
