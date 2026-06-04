const DEBUGGER_VERSION = "1.3";
const STORAGE_KEY = "flowPromptAutoState";
const FLOW_URL_PATTERN = /^https:\/\/labs\.google\/fx\/(id\/)?tools\/flow\//;
const DEFAULT_STATE = {
  prompts: [],
  currentIndex: 0,
  isRunning: false,
  status: "idle",
  lastError: "",
  completedCount: 0,
  timeoutSeconds: 30,
  settleSeconds: 5,
  flowTabId: null,
  flowWindowId: null,
  returnTabId: null,
  targetStatus: "Belum terkunci ke tab Flow."
};

const attachedTabs = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse(result || { ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message, sender) {
  if (!message || !message.type) return { ok: false, error: "Unknown background command" };
  if (message.type === "CDP_INPUT") return handleCdpInput(message, sender);
  if (message.type === "FLOW_COMMAND") return handleFlowCommand(message.command);
  if (message.type === "FLOW_UI_PHASE") return handleFlowUiPhase(message.action, sender);
  if (message.type === "FLOW_DOWNLOAD_URL") return handleDownloadUrl(message, sender);
  return { ok: false, error: "Unknown background command" };
}

async function handleDownloadUrl(message, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId) await rememberFlowTab(tabId);

  const url = typeof message.url === "string" ? message.url : "";
  if (!url) throw new Error("URL download kosong.");
  const filename = sanitizeDownloadPath(message.filename || "flow-output.jpg");

  const downloadId = await chrome.downloads.download({
    url,
    filename,
    conflictAction: "uniquify",
    saveAs: false
  });
  return { ok: true, downloadId };
}

function sanitizeDownloadPath(filename) {
  const cleaned = String(filename)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return cleaned || "flow-output.jpg";
}

async function handleFlowCommand(command) {
  if (!command) throw new Error("Command Flow kosong.");

  let targetTab;
  if (command === "START") {
    const activeTab = await getActiveTab();
    if (!isFlowTab(activeTab)) {
      await pauseWithError("Buka halaman Google Flow terlebih dahulu, lalu klik Start.");
      return { ok: false, error: "Buka halaman Google Flow terlebih dahulu, lalu klik Start." };
    }
    targetTab = activeTab;
    await saveState({
      flowTabId: targetTab.id,
      flowWindowId: targetTab.windowId,
      returnTabId: null,
      targetStatus: targetLabel(targetTab)
    });
  } else {
    targetTab = await resolveFlowTab();
    if (!targetTab) {
      await pauseWithError("Tab Google Flow tidak ditemukan. Buka halaman Flow lalu Resume.");
      return { ok: false, error: "Tab Google Flow tidak ditemukan. Buka halaman Flow lalu Resume." };
    }
  }

  await rememberFlowTab(targetTab.id);
  await ensureContentScript(targetTab.id);
  const response = await chrome.tabs.sendMessage(targetTab.id, { type: command });
  await saveState({
    flowTabId: targetTab.id,
    flowWindowId: targetTab.windowId,
    targetStatus: targetLabel(targetTab)
  });
  return response || { ok: true };
}

async function handleFlowUiPhase(action, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (!tabId) throw new Error("Tab id tidak ditemukan untuk fase UI.");
  if (action === "prepare") {
    await rememberFlowTab(tabId);
    return { ok: true };
  }
  if (action === "restore") return { ok: true };
  throw new Error("Aksi fase UI tidak dikenal.");
}

async function handleCdpInput(message, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (!tabId) throw new Error("Tab id tidak ditemukan untuk CDP input.");
  await rememberFlowTab(tabId);
  await attach(tabId);
  if (message.action === "click") return dispatchClick(tabId, message.x, message.y);
  if (message.action === "key") return dispatchKey(tabId, message.key, message.modifiers || 0);
  throw new Error("CDP action tidak dikenal.");
}

async function rememberFlowTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isFlowTab(tab)) throw new Error("Tab Google Flow tidak ditemukan. Buka halaman Flow lalu Resume.");
  await saveState({ flowTabId: tab.id, flowWindowId: tab.windowId, targetStatus: targetLabel(tab) });
}

async function resolveFlowTab() {
  const state = await getState();
  if (state.flowTabId) {
    try {
      const tab = await chrome.tabs.get(state.flowTabId);
      if (isFlowTab(tab)) return tab;
    } catch (_) {}
  }
  const tabs = await chrome.tabs.query({ url: ["https://labs.google/fx/id/tools/flow/*", "https://labs.google/fx/tools/flow/*"] });
  const tab = tabs.find(isFlowTab) || null;
  if (tab) {
    await saveState({ flowTabId: tab.id, flowWindowId: tab.windowId, targetStatus: targetLabel(tab) });
  }
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch (_) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["scripts/content.js"]
    });
  }
}

async function attach(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  attachedTabs.add(tabId);
}

async function dispatchClick(tabId, x, y) {
  const target = { tabId };
  const base = { x, y, button: "left", clickCount: 1, pointerType: "mouse" };
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...base, type: "mouseMoved" });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  return { ok: true };
}

async function dispatchKey(tabId, key, modifiers) {
  const target = { tabId };
  const params = keyParams(key, modifiers);
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { ...params, type: "keyDown" });
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { ...params, type: "keyUp" });
  return { ok: true };
}

function keyParams(key, modifiers) {
  const specialKeys = {
    Enter: { code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
    ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
    ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
    ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 }
  };
  if (specialKeys[key]) return { key, ...specialKeys[key], modifiers };
  return { text: key, key, code: key, modifiers };
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function isFlowTab(tab) {
  return Boolean(tab && tab.id && FLOW_URL_PATTERN.test(tab.url || ""));
}

function targetLabel(tab) {
  return tab && tab.id ? `Terkunci: tab ${tab.id} (tanpa auto-pindah)` : "Belum terkunci ke tab Flow.";
}

async function getState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_STATE, ...(result[STORAGE_KEY] || {}) };
}

async function saveState(patch) {
  const state = await getState();
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...state, ...patch } });
}

async function pauseWithError(message) {
  await saveState({ isRunning: false, status: "error", lastError: message, targetStatus: message });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  attachedTabs.delete(tabId);
  const state = await getState();
  if (state.flowTabId === tabId) {
    await saveState({
      flowTabId: null,
      flowWindowId: null,
      isRunning: false,
      status: "error",
      lastError: "Tab Google Flow tidak ditemukan. Buka halaman Flow lalu Resume.",
      targetStatus: "Tab Flow tertutup."
    });
  }
  if (state.returnTabId === tabId) await saveState({ returnTabId: null });
});
