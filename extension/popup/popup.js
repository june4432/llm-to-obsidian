const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const errorMsgEl = document.getElementById("errorMsg");
const mdListEl = document.getElementById("mdList");
const emptyStateEl = document.getElementById("emptyState");
const saveBtn = document.getElementById("saveBtn");
const rescanBtn = document.getElementById("rescanBtn");
const testBtn = document.getElementById("testBtn");
const logContainer = document.getElementById("logContainer");
const refreshLogsBtn = document.getElementById("refreshLogs");

let mdItems = []; // scanned items from content script

// ── Status ──
function setStatus(status, text) {
  statusDot.className = `status-dot ${status}`;
  statusText.textContent = text;
}

// ── Error ──
function showError(msg) {
  errorMsgEl.style.display = msg ? "block" : "none";
  errorMsgEl.textContent = msg || "";
}

// ── Log Rendering ──
function renderLogs(entries) {
  if (!entries || entries.length === 0) {
    logContainer.innerHTML = '<div class="log-entry log-info">No logs</div>';
    return;
  }
  logContainer.innerHTML = entries.slice(-30).map((e) => {
    const cls = e.level === "error" ? "log-error" : "log-info";
    const d = e.data ? ` <span class="log-data">${JSON.stringify(e.data)}</span>` : "";
    return `<div class="log-entry"><span class="log-time">${e.time}</span> <span class="${cls}">${e.msg}</span>${d}</div>`;
  }).join("");
  logContainer.scrollTop = logContainer.scrollHeight;
}

function loadLogs() {
  chrome.storage.local.get(["logs"], (r) => renderLogs(r.logs || []));
}

// ── Render MD Items ──
function renderMdItems() {
  if (mdItems.length === 0) {
    emptyStateEl.textContent = "No markdown files found on this page.";
    emptyStateEl.style.display = "block";
    saveBtn.disabled = true;
    return;
  }

  emptyStateEl.style.display = "none";
  mdListEl.innerHTML = mdItems.map((item, i) => {
    const icon = item.type === "chip" ? "📎" : "📝";
    const label = item.type === "chip" ? "file" : "code block";
    const meta = item.hasContent ? `${label} · ${item.length} chars` : "No content";
    return `
    <label class="md-item" data-index="${i}" id="md-item-${i}">
      <input type="checkbox" ${item.hasContent ? "checked" : "disabled"} data-index="${i}">
      <div class="md-item-info">
        <div class="md-item-name" title="${item.fileName}">${icon} ${item.fileName}</div>
        <div class="md-item-meta">${meta}</div>
      </div>
    </label>`;
  }).join("");

  updateSaveBtn();
}

function getCheckedIndices() {
  return [...mdListEl.querySelectorAll('input[type="checkbox"]:checked')]
    .map((cb) => parseInt(cb.dataset.index));
}

function updateSaveBtn() {
  const checked = getCheckedIndices();
  const hasContent = checked.some((i) => mdItems[i]?.hasContent);
  saveBtn.disabled = checked.length === 0 || !hasContent;
  saveBtn.textContent = checked.length > 0 ? `Save Selected (${checked.length})` : "Save Selected";
}

// ── Scan Page ──
function scanPage() {
  setStatus("scanning", "Scanning page...");
  showError(null);
  mdItems = [];

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) {
      setStatus("error", "No active tab");
      emptyStateEl.textContent = "No active tab found.";
      return;
    }

    const tabId = tabs[0].id;

    function doScan() {
      chrome.tabs.sendMessage(tabId, { action: "scanMdItems" }, (items) => {
        if (chrome.runtime.lastError) {
          // Inject and retry
          chrome.scripting.executeScript(
            { target: { tabId }, files: ["content/gemini.js"] },
            () => {
              if (chrome.runtime.lastError) {
                setStatus("error", "Not a Gemini page");
                emptyStateEl.textContent = "Open a Gemini conversation first.";
                return;
              }
              setTimeout(() => {
                chrome.tabs.sendMessage(tabId, { action: "scanMdItems" }, handleScanResult);
              }, 500);
            }
          );
          return;
        }
        handleScanResult(items);
      });
    }

    function handleScanResult(items) {
      mdItems = items || [];
      renderMdItems();
      if (mdItems.length > 0) {
        setStatus("idle", `Found ${mdItems.length} markdown file(s)`);
      } else {
        setStatus("idle", "No markdown files found");
      }
    }

    doScan();
  });
}

// ── Save Selected ──
saveBtn.addEventListener("click", () => {
  const checked = getCheckedIndices().filter((i) => mdItems[i]?.hasContent);
  if (checked.length === 0) return;

  saveBtn.disabled = true;
  let completed = 0;
  let failed = 0;

  setStatus("processing", `Saving ${checked.length} note(s)...`);

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    const tabId = tabs[0].id;

    function saveNext(idx) {
      if (idx >= checked.length) {
        // All done
        const msg = failed > 0
          ? `Done: ${completed} saved, ${failed} failed`
          : `Done: ${completed} note(s) saved!`;
        setStatus(failed > 0 ? "error" : "done", msg);
        saveBtn.disabled = false;
        saveBtn.textContent = "Save Selected";
        loadLogs();
        return;
      }

      const itemIndex = checked[idx];
      const itemEl = document.getElementById(`md-item-${itemIndex}`);
      if (itemEl) itemEl.classList.add("saving");

      setStatus("processing", `Saving ${idx + 1}/${checked.length}...`);

      // Get content by index from content script
      chrome.tabs.sendMessage(tabId, { action: "getMarkdownByIndex", index: itemIndex }, (response) => {
        if (chrome.runtime.lastError || !response?.content) {
          failed++;
          if (itemEl) { itemEl.classList.remove("saving"); itemEl.classList.add("failed"); }
          saveNext(idx + 1);
          return;
        }

        // Send to service worker for conversion
        chrome.runtime.sendMessage({ action: "convertAndSave", content: response.content }, () => {
          // Wait for completion via storage
          waitForCompletion(() => {
            completed++;
            if (itemEl) { itemEl.classList.remove("saving"); itemEl.classList.add("saved"); }
            saveNext(idx + 1);
          }, () => {
            failed++;
            if (itemEl) { itemEl.classList.remove("saving"); itemEl.classList.add("failed"); }
            saveNext(idx + 1);
          });
        });
      });
    }

    saveNext(0);
  });
});

function waitForCompletion(onSuccess, onFail) {
  let checks = 0;
  const interval = setInterval(() => {
    checks++;
    chrome.runtime.sendMessage({ action: "getState" }, (state) => {
      if (state?.status === "done") {
        clearInterval(interval);
        onSuccess();
      } else if (state?.status === "error") {
        clearInterval(interval);
        showError(state.error);
        onFail();
      } else if (checks > 60) { // 60 seconds timeout
        clearInterval(interval);
        showError("Timeout waiting for response");
        onFail();
      }
    });
  }, 1000);
}

// ── Checkbox change ──
mdListEl.addEventListener("change", updateSaveBtn);

// ── Rescan ──
rescanBtn.addEventListener("click", scanPage);

// ── Test Connection ──
testBtn.addEventListener("click", () => {
  testBtn.disabled = true;
  testBtn.textContent = "Testing...";
  chrome.runtime.sendMessage({ action: "testConnection" }, (response) => {
    testBtn.disabled = false;
    if (response?.success) {
      testBtn.textContent = "Connected!";
      testBtn.style.background = "#a6e3a1";
      testBtn.style.color = "#1e1e2e";
    } else {
      testBtn.textContent = "Failed!";
      testBtn.style.background = "#f38ba8";
      showError(response?.error);
    }
    setTimeout(() => {
      testBtn.textContent = "Test Connection";
      testBtn.style.background = "";
      testBtn.style.color = "";
    }, 3000);
  });
});

// ── Settings ──
const settingsToggle = document.getElementById("settingsToggle");
const settingsPanel = document.getElementById("settingsPanel");
const vaultPathInput = document.getElementById("vaultPath");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");

settingsToggle.addEventListener("click", () => {
  const open = settingsPanel.style.display !== "none";
  settingsPanel.style.display = open ? "none" : "block";
  settingsToggle.textContent = open ? "Settings" : "Close";
  if (!open) {
    chrome.storage.local.get(["vaultPath"], (r) => {
      vaultPathInput.value = r.vaultPath || "";
      vaultPathInput.placeholder = "e.g. C:\\Users\\you\\Documents\\metanotes";
    });
  }
});

saveSettingsBtn.addEventListener("click", () => {
  const path = vaultPathInput.value.trim();
  if (!path) return;
  chrome.storage.local.set({ vaultPath: path }, () => {
    saveSettingsBtn.textContent = "Saved!";
    setTimeout(() => { saveSettingsBtn.textContent = "Save"; }, 1500);
  });
});

// ── Refresh Logs ──
refreshLogsBtn.addEventListener("click", loadLogs);

// ── Live state updates ──
chrome.storage.onChanged.addListener((changes) => {
  if (changes.logs) renderLogs(changes.logs.newValue);
});

// ── Init ──
loadLogs();
scanPage();
