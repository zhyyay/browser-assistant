/**
 * Owns dedicated, non-focused Chrome windows for browser-assistant automation.
 * Each named session has its own tab/window so posting and Following scans do
 * not navigate or scroll each other's pages. User tabs are never reused.
 */
const STORAGE_KEY = "browserAssistantCdpSessions";
const creationInFlight = new Map();

async function readSessions() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || {};
}

async function saveSessions(sessions) {
  await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
}

async function validTab(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch (_) {
    return null;
  }
}

export async function ensureAutomationTab(url = "https://x.com/home", sessionName = "default") {
  if (creationInFlight.has(sessionName)) return creationInFlight.get(sessionName);
  const task = (async () => {
    const sessions = await readSessions();
    const saved = sessions[sessionName] || null;
    let tab = await validTab(saved?.tabId);
    let windowId = saved?.windowId;

    if (tab && tab.windowId === windowId) {
      if (url && tab.url !== url) {
        tab = await chrome.tabs.update(tab.id, { url, active: false });
      }
      return { tab, windowId, groupId: saved?.groupId ?? null, reused: true, sessionName };
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
      tab = windowInfo.tabs?.[0] || (await chrome.tabs.query({ windowId }).then((tabs) => tabs[0]));
    }

    if (!tab) {
      tab = await chrome.tabs.create({ windowId, url, active: false });
    }

    let groupId = null;
    try {
      groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, {
        title: "浏览器助手-" + sessionName,
        color: "blue",
        collapsed: true
      });
    } catch (_) {
      // Tab groups are organizational only; automation remains usable if
      // Chrome policy or version prevents grouping.
    }

    sessions[sessionName] = {
      windowId,
      tabId: tab.id,
      groupId,
      sessionName,
      createdAt: Date.now()
    };
    await saveSessions(sessions);
    return { tab, windowId, groupId, reused: false, sessionName };
  })();

  creationInFlight.set(sessionName, task);
  try {
    return await task;
  } finally {
    creationInFlight.delete(sessionName);
  }
}

export async function getAutomationSession(sessionName = "default") {
  const sessions = await readSessions();
  const saved = sessions[sessionName];
  if (!saved) return null;
  const tab = await validTab(saved.tabId);
  if (!tab || tab.windowId !== saved.windowId) return null;
  return { ...saved, tab };
}

export async function closeAutomationSession(sessionName = "default") {
  const sessions = await readSessions();
  const saved = sessions[sessionName];
  if (!saved) return { closed: false };
  if (Number.isInteger(saved.windowId)) {
    try {
      await chrome.windows.remove(saved.windowId);
    } catch (_) {}
  }
  delete sessions[sessionName];
  await saveSessions(sessions);
  return { closed: true };
}
