/**
 * Owns a dedicated, non-focused Chrome window for browser-assistant automation.
 * The user's normal tabs are never moved into or reused by this session.
 */
const STORAGE_KEY = "browserAssistantCdpSession";
let creationInFlight = null;

async function readSavedSession() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || null;
}

async function saveSession(session) {
  await chrome.storage.local.set({ [STORAGE_KEY]: session });
}

async function validTab(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch (_) {
    return null;
  }
}

export async function ensureAutomationTab(url = "https://x.com/home") {
  if (creationInFlight) return creationInFlight;
  creationInFlight = (async () => {
    const saved = await readSavedSession();
    let windowId = saved?.windowId;
    let tab = await validTab(saved?.tabId);

    if (tab && tab.windowId === windowId) {
      if (url && tab.url !== url && (tab.url === "about:blank" || tab.status === "complete")) {
        tab = await chrome.tabs.update(tab.id, { url, active: false });
      }
      return { tab, windowId, groupId: saved?.groupId ?? null, reused: true };
    }

    let windowInfo = null;
    if (Number.isInteger(windowId)) {
      try {
        windowInfo = await chrome.windows.get(windowId);
      } catch (_) {
        windowInfo = null;
      }
    }

    if (!windowInfo) {
      windowInfo = await chrome.windows.create({
        url,
        focused: false,
        type: "normal"
      });
      windowId = windowInfo.id;
      tab = windowInfo.tabs?.[0] || await chrome.tabs.query({ windowId }).then((tabs) => tabs[0]);
    }

    if (!tab) {
      tab = await chrome.tabs.create({
        windowId,
        url,
        active: false
      });
    }

    let groupId = null;
    try {
      groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, {
        title: "浏览器助手自动化",
        color: "blue",
        collapsed: true
      });
    } catch (_) {
      // Tab groups are organizational only; automation remains usable if
      // Chrome policy or version prevents grouping.
    }

    const session = { windowId, tabId: tab.id, groupId, createdAt: Date.now() };
    await saveSession(session);
    return { tab, windowId, groupId, reused: false };
  })();

  try {
    return await creationInFlight;
  } finally {
    creationInFlight = null;
  }
}

export async function getAutomationSession() {
  const saved = await readSavedSession();
  if (!saved) return null;
  const tab = await validTab(saved.tabId);
  if (!tab || tab.windowId !== saved.windowId) return null;
  return { ...saved, tab };
}

export async function closeAutomationSession() {
  const saved = await readSavedSession();
  if (!saved) return { closed: false };
  if (Number.isInteger(saved.windowId)) {
    try {
      await chrome.windows.remove(saved.windowId);
    } catch (_) {}
  }
  await chrome.storage.local.remove(STORAGE_KEY);
  return { closed: true };
}
