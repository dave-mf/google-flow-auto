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
  targetStatus: "Belum terkunci ke tab Flow.",
  fileName: "",
  uiVersion: 3
};


const els = {
  file: document.getElementById("promptFile"),
  fileInfo: document.getElementById("fileInfo"),
  uploadPanel: document.getElementById("uploadPanel"),
  timeout: document.getElementById("timeoutSeconds"),
  settle: document.getElementById("settleSeconds"),
  statusPill: document.getElementById("statusPill"),
  progressText: document.getElementById("progressText"),
  completedText: document.getElementById("completedText"),
  progressBar: document.getElementById("progressBar"),
  statusMessage: document.getElementById("statusMessage"),
  promptCount: document.getElementById("promptCount"),
  promptList: document.getElementById("promptList"),
  start: document.getElementById("startBtn"),
  pause: document.getElementById("pauseBtn"),
  resume: document.getElementById("resumeBtn"),
  next: document.getElementById("nextBtn"),
  stop: document.getElementById("stopBtn"),
  reset: document.getElementById("resetBtn")
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const state = await migrateState(await getState());
  render(state);

  els.file.addEventListener("change", handleFile);
  els.timeout.addEventListener("change", persistSettings);
  els.settle.addEventListener("change", persistSettings);
  els.start.addEventListener("click", () => sendCommand("START"));
  els.pause.addEventListener("click", () => sendCommand("PAUSE"));
  els.resume.addEventListener("click", () => sendCommand("RESUME"));
  els.next.addEventListener("click", () => sendCommand("NEXT"));
  els.stop.addEventListener("click", () => sendCommand("STOP"));
  els.reset.addEventListener("click", resetState);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.flowPromptAutoState) return;
    render({ ...DEFAULT_STATE, ...changes.flowPromptAutoState.newValue });
  });
}

function parsePrompts(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\s*(?:\d+[\.)]|[-*])\s+/, "").trim())
    .filter(Boolean);
}

async function handleFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const text = await file.text();
  const prompts = parsePrompts(text);
  if (!prompts.length) {
    els.uploadPanel.classList.remove("has-file");
    await saveState({
      prompts: [],
      currentIndex: 0,
      isRunning: false,
      status: "error",
      lastError: "File kosong atau tidak ada prompt yang valid.",
      completedCount: 0,
      fileName: ""
    });
    return;
  }

  await saveState({
    prompts,
    currentIndex: 0,
    isRunning: false,
    status: "ready",
    lastError: "",
    completedCount: 0,
    fileName: file.name,
    timeoutSeconds: numberFromInput(els.timeout, DEFAULT_STATE.timeoutSeconds),
    settleSeconds: numberFromInput(els.settle, DEFAULT_STATE.settleSeconds)
  });

  els.uploadPanel.classList.add("has-file");
  els.fileInfo.textContent = file.name + " dimuat: " + prompts.length + " prompt.";
}

async function persistSettings() {
  await saveState({
    timeoutSeconds: numberFromInput(els.timeout, DEFAULT_STATE.timeoutSeconds),
    settleSeconds: numberFromInput(els.settle, DEFAULT_STATE.settleSeconds)
  });
}

async function sendCommand(type) {
  await persistSettings();

  try {
    const response = await chrome.runtime.sendMessage({ type: "FLOW_COMMAND", command: type });
    if (response && response.ok === false) {
      await saveState({ status: "error", isRunning: false, lastError: response.error || "Command gagal." });
    }
  } catch (error) {
    await saveState({
      status: "error",
      isRunning: false,
      lastError: `Tidak bisa mengirim command ke background: ${error.message}`
    });
  }
}

async function resetState() {
  els.file.value = "";
  els.uploadPanel.classList.remove("has-file");
  els.fileInfo.textContent = "Belum ada file dipilih.";
  await chrome.storage.local.set({ flowPromptAutoState: { ...DEFAULT_STATE } });
}


async function getState() {
  const result = await chrome.storage.local.get("flowPromptAutoState");
  return { ...DEFAULT_STATE, ...(result.flowPromptAutoState || {}) };
}

async function migrateState(state) {
  if (state.uiVersion >= DEFAULT_STATE.uiVersion) return state;
  const migrated = {
    ...state,
    timeoutSeconds: state.timeoutSeconds === 180 ? DEFAULT_STATE.timeoutSeconds : state.timeoutSeconds,
    fileName: state.fileName || "",
    uiVersion: DEFAULT_STATE.uiVersion
  };
  await chrome.storage.local.set({ flowPromptAutoState: migrated });
  return migrated;
}

async function saveState(patch) {
  const current = await getState();
  await chrome.storage.local.set({ flowPromptAutoState: { ...current, ...patch } });
}

function render(state) {
  els.timeout.value = String(state.timeoutSeconds || DEFAULT_STATE.timeoutSeconds);
  els.settle.value = String(state.settleSeconds || DEFAULT_STATE.settleSeconds);

  const total = state.prompts.length;
  const visibleIndex = total ? Math.min(state.currentIndex + 1, total) : 0;
  els.uploadPanel.classList.toggle("has-file", total > 0);
  els.fileInfo.textContent = total ? `${state.fileName || "File prompt"} dimuat: ${total} prompt.` : "Belum ada file dipilih.";
  els.statusPill.textContent = state.status || "idle";
  els.statusPill.className = `pill ${state.status || "idle"}`;
  els.progressText.textContent = `${visibleIndex} / ${total}`;
  els.completedText.textContent = `Selesai: ${state.completedCount || 0}`;
  els.promptCount.textContent = `${total} prompt`;
  els.progressBar.style.width = total ? `${Math.min(100, ((state.completedCount || 0) / total) * 100)}%` : "0%";

  if (state.lastError) {
    els.statusMessage.textContent = withTargetStatus(state.lastError, state);
  } else if (!total) {
    els.statusMessage.textContent = withTargetStatus("Siapkan file prompt, buka halaman Google Flow, lalu klik Start.", state);
  } else if (state.status === "running") {
    els.statusMessage.textContent = withTargetStatus("Automasi sedang berjalan di tab Flow yang terkunci.", state);
  } else if (state.status === "completed") {
    els.statusMessage.textContent = withTargetStatus("Semua prompt selesai diproses.", state);
  } else {
    els.statusMessage.textContent = withTargetStatus("Prompt siap. Buka halaman Flow lalu klik Start.", state);
  }

  els.promptList.innerHTML = "";
  state.prompts.slice(0, 50).forEach((prompt, index) => {
    const li = document.createElement("li");
    li.textContent = prompt;
    if (index === state.currentIndex) li.className = "current";
    els.promptList.appendChild(li);
  });

  els.start.disabled = !total || state.status === "running";
  els.pause.disabled = state.status !== "running";
  els.resume.disabled = !total || state.status === "running" || state.status === "completed";
  els.next.disabled = !total || state.status === "completed";
  els.stop.disabled = !total || state.status === "idle";
  els.reset.disabled = state.status === "running";
}

function withTargetStatus(message, state) {
  const target = state.targetStatus || (state.flowTabId ? `Terkunci: tab ${state.flowTabId}` : "Belum terkunci ke tab Flow.");
  return `${message} ${target}`;
}

function numberFromInput(input, fallback) {
  const value = Number(input.value);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
