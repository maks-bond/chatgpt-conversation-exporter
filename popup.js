const $ = (selector) => document.querySelector(selector);
const controls = [$("#download"), $("#copy"), $("#console")];
let activeTabId;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active browser tab was found.");
  activeTabId = tab.id;
  return tab;
}

async function send(message) {
  if (!activeTabId) await getActiveTab();
  try {
    return await chrome.tabs.sendMessage(activeTabId, message);
  } catch (error) {
    throw new Error("Reload the ChatGPT tab after installing the extension, then try again.");
  }
}

function setBusy(busy) {
  controls.forEach((control) => { control.disabled = busy; });
  $("#format").disabled = busy;
  $("#loadAll").disabled = busy;
  $("#progress").hidden = !busy;
  $("#cancel").hidden = !busy;
}

function setStatus(message, error = false) {
  $("#status").textContent = message;
  $("#status").style.color = error ? "#c33" : "";
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "chat-export-progress") return;
  $("#progress").max = Math.max(message.total, 1);
  $("#progress").value = message.completed;
  setStatus(`${message.phase}: ${message.completed}/${message.total} turns captured`);
});

async function run(action) {
  setBusy(true);
  $("#progress").value = 0;
  setStatus("Starting export...");
  try {
    const response = await send({
      type: "chat-export-run",
      action,
      format: $("#format").value,
      loadAll: $("#loadAll").checked
    });
    if (!response?.ok) throw new Error(response?.error || "Export failed.");

    if (action === "download") {
      const url = URL.createObjectURL(new Blob([response.content], { type: response.mime }));
      try {
        await chrome.downloads.download({ url, filename: response.filename, saveAs: true });
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } else if (action === "copy") {
      await navigator.clipboard.writeText(response.content);
    }

    const warning = response.missing
      ? ` Warning: ${response.missing} turn(s) could not be hydrated.`
      : "";
    setStatus(`${response.count} messages, ${response.characters.toLocaleString()} characters.${warning}`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

$("#download").addEventListener("click", () => run("download"));
$("#copy").addEventListener("click", () => run("copy"));
$("#console").addEventListener("click", () => run("console"));
$("#cancel").addEventListener("click", async () => {
  await send({ type: "chat-export-cancel" });
  setStatus("Cancellation requested...");
});

(async () => {
  try {
    const tab = await getActiveTab();
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "")) {
      throw new Error("The active tab is not ChatGPT.");
    }
    const info = await send({ type: "chat-export-inspect" });
    $("#summary").textContent = info.turns
      ? `${info.turns} turn shells found; ${info.loaded} currently loaded.`
      : "No conversation turns found on this page.";
  } catch (error) {
    $("#summary").textContent = error.message;
    controls.forEach((control) => { control.disabled = true; });
  }
})();
