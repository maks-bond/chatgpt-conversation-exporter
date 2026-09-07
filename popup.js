const $ = (selector) => document.querySelector(selector);
const controls = [$("#download"), $("#copy"), $("#console")];
let activeTabId;

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions);
}

function localizeDocument() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
}

localizeDocument();

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error(t("errorNoActiveTab"));
  activeTabId = tab.id;
  return tab;
}

async function send(message) {
  if (!activeTabId) await getActiveTab();
  try {
    return await chrome.tabs.sendMessage(activeTabId, message);
  } catch (error) {
    throw new Error(t("errorReloadTab"));
  }
}

function setBusy(busy) {
  controls.forEach((control) => { control.disabled = busy; });
  $("#format").disabled = busy;
  $("#loadAll").disabled = busy;
  $("#timestamps").disabled = busy;
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
  setStatus(t("progressStatus", [message.phase, String(message.completed), String(message.total)]));
});

async function run(action) {
  setBusy(true);
  $("#progress").value = 0;
  setStatus(t("startingExport"));
  try {
    const response = await send({
      type: "chat-export-run",
      action,
      format: $("#format").value,
      loadAll: $("#loadAll").checked,
      includeTimestamps: $("#timestamps").checked
    });
    if (!response?.ok) throw new Error(response?.error || t("errorExportFailed"));

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
      ? ` ${t("warningMissingTurns", String(response.missing))}`
      : "";
    const timestamps = response.timestampsRequested
      ? ` ${t("timestampsFound", [String(response.timestamps), String(response.count)])}`
      : "";
    const source = response.source === "metadata"
      ? t("collectionMethodMetadata")
      : t("collectionMethodDom");
    setStatus(`${t("exportSummary", [String(response.count), response.characters.toLocaleString()])} ${source}${timestamps}${warning}`);
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
  setStatus(t("cancellationRequested"));
});

(async () => {
  try {
    const tab = await getActiveTab();
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "")) {
      throw new Error(t("errorNotChatGPT"));
    }
    const info = await send({ type: "chat-export-inspect" });
    $("#summary").textContent = info.turns
      ? t("turnsFound", [String(info.turns), String(info.loaded)])
      : t("noTurnsFound");
  } catch (error) {
    $("#summary").textContent = error.message;
    controls.forEach((control) => { control.disabled = true; });
  }
})();
