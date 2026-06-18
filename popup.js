const button = document.getElementById("openPanel");
const message = document.getElementById("message");

button.addEventListener("click", async () => {
  setMessage("正在打开统计面板...");
  button.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("https://kb.fzyun.net/")) {
      throw new Error("请先打开 kb.fzyun.net 的工单列表或工单详情页。");
    }

    await ensurePanelReady(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "KB_WORKLOAD_OPEN_PANEL" });
    setMessage("已打开，请回到页面右下角操作。");
  } catch (error) {
    setMessage(error.message || String(error), true);
  } finally {
    button.disabled = false;
  }
});

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

function setMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}
