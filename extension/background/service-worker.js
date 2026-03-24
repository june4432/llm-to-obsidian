const NATIVE_HOST_NAME = "com.llm_to_obsidian.host";
const DEFAULT_VAULT_PATH = ""; // Set via popup Settings

// ── Logging ──
const logs = [];
function log(level, msg, data) {
  const entry = {
    time: new Date().toLocaleTimeString("ko-KR"),
    level,
    msg,
    data: data ?? null,
  };
  logs.push(entry);
  if (logs.length > 50) logs.shift();
  console[level === "error" ? "error" : "log"](`[LLM2OBS] ${msg}`, data ?? "");
  chrome.storage.local.set({ logs });
}

// ── Notifications ──
function notify(title, message, isError) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message: String(message || ""),
      priority: isError ? 2 : 0,
    }, () => void chrome.runtime.lastError);
  } catch (_) {}
}

// ── Badge ──
function setBadgeStatus(status) {
  const config = {
    processing: { text: "...", color: "#f9e2af" },
    done: { text: "OK", color: "#a6e3a1" },
    error: { text: "!", color: "#f38ba8" },
  };
  const c = config[status];
  if (!c) { chrome.action.setBadgeText({ text: "" }); return; }
  chrome.action.setBadgeText({ text: c.text });
  chrome.action.setBadgeBackgroundColor({ color: c.color });
  if (status === "done" || status === "error") {
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 5000);
  }
}

// ── State ──
let currentState = { status: "idle", lastNote: null, error: null };
function updateState(patch) {
  Object.assign(currentState, patch);
  chrome.storage.local.set({ state: currentState });
  log("info", `State → ${patch.status}`, patch.error || patch.lastNote || null);
  setBadgeStatus(patch.status);
}

// ── Context Menu ──
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "save-to-obsidian",
    title: "Save to Obsidian",
    contexts: ["page", "link"],
    documentUrlPatterns: ["https://gemini.google.com/*"],
  });
  log("info", "Extension installed, context menu created");
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "save-to-obsidian") {
    log("info", "Context menu clicked");
    setBadgeStatus("processing");
    requestContentFromTab(tab.id);
  }
});

// ── Request content from tab (with auto-inject) ──
function requestContentFromTab(tabId) {
  chrome.tabs.sendMessage(tabId, { action: "getMarkdownContent" }, (response) => {
    if (chrome.runtime.lastError) {
      log("info", "Injecting content script...");
      chrome.scripting.executeScript(
        { target: { tabId }, files: ["content/gemini.js"] },
        () => {
          if (chrome.runtime.lastError) {
            log("error", "Injection failed");
            notify("Save Failed", "Cannot inject script on this page.", true);
            setBadgeStatus("error");
            return;
          }
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { action: "getMarkdownContent" }, (r) => {
              if (r?.content) {
                handleConvertAndSave(r.content);
              } else {
                notify("Save Failed", "No markdown found.", true);
                setBadgeStatus("error");
              }
            });
          }, 500);
        }
      );
      return;
    }
    if (response?.content) {
      handleConvertAndSave(response.content);
    } else {
      notify("Save Failed", "No markdown content found.", true);
      setBadgeStatus("error");
    }
  });
}

// ── Native Messaging via connectNative (more robust than sendNativeMessage for MV3) ──
function callNativeHost(payload, callback) {
  log("info", "Connecting to native host...");
  let responded = false;

  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    port.onMessage.addListener((response) => {
      if (responded) return;
      responded = true;
      log("info", "Native host response received");
      port.disconnect();
      callback(null, response);
    });

    port.onDisconnect.addListener(() => {
      if (responded) return;
      responded = true;
      const err = chrome.runtime.lastError?.message || "Native host disconnected";
      log("error", "Native host disconnected", err);
      callback(err, null);
    });

    port.postMessage(payload);
    log("info", "Message sent to native host", { action: payload.action });
  } catch (e) {
    if (!responded) {
      responded = true;
      const err = e.message || "Failed to connect to native host";
      log("error", "Native host connection error", err);
      callback(err, null);
    }
  }
}

// ── Message Handling ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "convertAndSave") {
    log("info", "convertAndSave received", { contentLength: message.content?.length ?? 0 });
    handleConvertAndSave(message.content);
    sendResponse({ status: "processing" });
  }
  if (message.action === "getState") {
    sendResponse(currentState);
  }
  if (message.action === "getLogs") {
    sendResponse(logs);
  }
  if (message.action === "testConnection") {
    log("info", "Test connection requested");
    chrome.storage.local.get(["vaultPath"], (settings) => {
      const vaultPath = settings.vaultPath || DEFAULT_VAULT_PATH;
      callNativeHost(
        { action: "test", vault_path: vaultPath },
        (err, response) => {
          if (err) {
            sendResponse({ success: false, error: err });
          } else {
            sendResponse({ success: true, response });
          }
        }
      );
    });
    return true; // async sendResponse
  }

  // Badge from content script
  if (message.action === "mdLinksCount") {
    const count = message.count;
    if (count > 0 && sender.tab) {
      chrome.action.setBadgeText({ text: String(count), tabId: sender.tab.id });
      chrome.action.setBadgeBackgroundColor({ color: "#7C3AED", tabId: sender.tab.id });
    }
  }

  return false;
});

// ── Convert & Save ──
function handleConvertAndSave(markdownContent) {
  if (!markdownContent) {
    updateState({ status: "error", error: "No markdown content from page" });
    notify("Save Failed", "No markdown content found.", true);
    return;
  }

  updateState({ status: "processing", error: null });
  log("info", "Getting vault path...");

  chrome.storage.local.get(["vaultPath"], (settings) => {
    const vaultPath = settings.vaultPath || DEFAULT_VAULT_PATH;
    if (!vaultPath) {
      updateState({ status: "error", error: "Vault path not set. Open Settings in the popup." });
      notify("Save Failed", "Set vault path in Settings first.", true);
      return;
    }
    log("info", "Calling native host", { contentLength: markdownContent.length, vaultPath });

    callNativeHost(
      {
        action: "convert_and_save",
        content: markdownContent,
        vault_path: vaultPath,
      },
      (err, response) => {
        if (err) {
          log("error", "Native host error", err);
          updateState({ status: "error", error: `Native host: ${err}` });
          notify("Save Failed", err, true);
          return;
        }

        log("info", "Native host response", response);

        if (response?.success) {
          const title = response.title || response.file_name;
          updateState({
            status: "done",
            lastNote: {
              title,
              fileName: response.file_name,
              savedAt: new Date().toISOString(),
            },
            error: null,
          });
          const gitMsg = response.git?.git_success
            ? " | Git synced"
            : response.git?.git_message
              ? ` | Git: ${response.git.git_message}`
              : "";
          notify("Note Saved!", `${response.file_name}${gitMsg}`);
        } else {
          const err = response?.error || "Unknown error";
          updateState({ status: "error", error: err });
          notify("Save Failed", err, true);
        }
      }
    );
  });
}
