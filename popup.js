const ACTIVITY_ORIGIN = "https://kb.fzyun.net";
const button = document.getElementById("openPanel");
const message = document.getElementById("message");

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

async function openPanelOnTab(tabId) {
  await ensurePanelReady(tabId);
  await chrome.tabs.sendMessage(tabId, { type: "KB_WORKLOAD_OPEN_PANEL" });
}

function requestOpenOnActivity(tabId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "KB_WORKLOAD_OPEN_ON_ACTIVITY", tabId }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "打开统计面板失败"));
        return;
      }
      resolve(response);
    });
  });
}

button.addEventListener("click", async () => {
  button.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab?.id && isMyActivityUrl(tab.url)) {
      setMessage("正在打开统计面板...");
      await openPanelOnTab(tab.id);
      setMessage("已打开，请回到页面右下角操作。");
      window.close();
      return;
    }

    setMessage("正在跳转到「我的活动」并打开面板...");
    await requestOpenOnActivity(tab?.id || null);
    window.close();
  } catch (error) {
    setMessage(error.message || String(error), true);
  } finally {
    button.disabled = false;
  }
});

// 兜底：若因时序仍弹出了小窗，且当前已在「我的活动」，则直接开面板并关闭弹窗
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isMyActivityUrl(tab.url)) {
      return;
    }
    document.documentElement.style.visibility = "hidden";
    await openPanelOnTab(tab.id);
    window.close();
  } catch (error) {
    document.documentElement.style.visibility = "";
    setMessage(error.message || String(error), true);
  }
})();

function setMessage(text, isError = false) {
  if (!text) {
    message.textContent = "";
    message.hidden = true;
    message.classList.remove("error");
    return;
  }
  message.hidden = false;
  message.textContent = text;
  message.classList.toggle("error", isError);
}
