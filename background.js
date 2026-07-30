const ACTIVITY_ORIGIN = "https://kb.fzyun.net";
const STORAGE_USER_ID_KEY = "kbWorkloadUserId";

function isMyActivityUrl(url) {
  if (!url || !url.startsWith(ACTIVITY_ORIGIN)) {
    return false;
  }
  try {
    return new URL(url).pathname.includes("/activity");
  } catch (_) {
    return false;
  }
}

function buildMyActivityUrl(userId) {
  return `${ACTIVITY_ORIGIN}/activity?user_id=${encodeURIComponent(userId)}`;
}

async function resolveMyUserId(fromTabId) {
  if (fromTabId) {
    try {
      const tab = await chrome.tabs.get(fromTabId);
      if (tab.url?.startsWith(ACTIVITY_ORIGIN)) {
        try {
          await ensurePanelReady(fromTabId);
          const ping = await chrome.tabs.sendMessage(fromTabId, { type: "KB_WORKLOAD_PING" });
          if (ping?.userId) {
            await chrome.storage.local.set({ [STORAGE_USER_ID_KEY]: ping.userId });
            return String(ping.userId);
          }
        } catch (_) {
          /* fall through */
        }

        try {
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: fromTabId },
            func: () => {
              const selectors = [
                "#loggedas a.user",
                ".loggedas a.user",
                "#top-menu a.user",
                "#account a.user",
                "a.user.active"
              ];
              for (const selector of selectors) {
                for (const node of document.querySelectorAll(selector)) {
                  const href = node.getAttribute("href") || "";
                  const match = href.match(/\/users\/(\d+)(?:\/|$|\?)/);
                  if (match?.[1]) {
                    return match[1];
                  }
                }
              }
              const loggedAs = document.querySelector("#loggedas, .loggedas, #account");
              const href = loggedAs?.querySelector('a[href*="/users/"]')?.getAttribute("href") || "";
              const match = href.match(/\/users\/(\d+)(?:\/|$|\?)/);
              return match?.[1] || "";
            }
          });
          if (result) {
            await chrome.storage.local.set({ [STORAGE_USER_ID_KEY]: result });
            return String(result);
          }
        } catch (_) {
          /* ignore */
        }
      }
    } catch (_) {
      /* ignore */
    }
  }

  try {
    const stored = await chrome.storage.local.get(STORAGE_USER_ID_KEY);
    if (stored?.[STORAGE_USER_ID_KEY]) {
      return String(stored[STORAGE_USER_ID_KEY]);
    }
  } catch (_) {
    /* ignore */
  }

  return "";
}

async function syncActionPopup(tabId, url) {
  try {
    if (isMyActivityUrl(url)) {
      await chrome.action.setPopup({ tabId, popup: "" });
    } else {
      await chrome.action.setPopup({ tabId, popup: "popup.html" });
    }
  } catch (_) {
    /* tab may have been closed */
  }
}

async function ensurePanelReady(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "KB_WORKLOAD_PING" });
  } catch (error) {
    const rawMessage = error?.message || String(error);
    if (!/receiving end|could not establish connection|context invalidated/i.test(rawMessage)) {
      throw error;
    }

    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  }
}

async function openWorkloadPanel(tabId) {
  await ensurePanelReady(tabId);
  await chrome.tabs.sendMessage(tabId, { type: "KB_WORKLOAD_OPEN_PANEL" });
}

async function openWorkloadPanelWithRetry(tabId, attempts = 10) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await openWorkloadPanel(tabId);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError || new Error("打开统计面板失败");
}

function waitForActivityTab(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("打开「我的活动」页面超时，请手动进入后再试。"));
    }, 30000);

    function finish() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    function onUpdated(id, changeInfo, tab) {
      if (id !== tabId) {
        return;
      }
      if (changeInfo.status === "complete" && isMyActivityUrl(tab.url || "")) {
        finish();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete" && isMyActivityUrl(tab.url || "")) {
          finish();
        }
      })
      .catch(reject);
  });
}

async function navigateToMyActivityAndOpenPanel(tabId) {
  const userId = await resolveMyUserId(tabId);
  if (!userId) {
    throw new Error("未能识别当前用户，请先手动打开知识库「我的活动」页面后再试。");
  }
  const activityUrl = buildMyActivityUrl(userId);
  let targetTabId = tabId;
  if (targetTabId) {
    await chrome.tabs.update(targetTabId, { url: activityUrl, active: true });
  } else {
    const created = await chrome.tabs.create({ url: activityUrl, active: true });
    targetTabId = created.id;
  }
  await waitForActivityTab(targetTabId);
  await openWorkloadPanelWithRetry(targetTabId);
  return targetTabId;
}

chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: `${ACTIVITY_ORIGIN}/*` });
  await Promise.all(tabs.map((tab) => syncActionPopup(tab.id, tab.url || "")));
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await syncActionPopup(tabId, tab.url || "");
  } catch (_) {
    /* ignore */
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    syncActionPopup(tabId, tab.url || "");
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !isMyActivityUrl(tab.url)) {
    return;
  }
  try {
    await openWorkloadPanel(tab.id);
  } catch (error) {
    console.warn("[KB Workload] open panel from action failed", error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "KB_WORKLOAD_OPEN_ON_ACTIVITY") {
    return false;
  }

  (async () => {
    const tabId = message.tabId || null;
    if (tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (isMyActivityUrl(tab.url || "")) {
          await openWorkloadPanelWithRetry(tabId);
          return { ok: true, navigated: false };
        }
      } catch (_) {
        /* fall through to navigate */
      }
    }
    await navigateToMyActivityAndOpenPanel(tabId);
    return { ok: true, navigated: true };
  })()
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));

  return true;
});
