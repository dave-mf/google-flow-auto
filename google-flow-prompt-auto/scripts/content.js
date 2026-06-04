(() => {
  if (window.__flowPromptAutoLoaded) return;
  window.__flowPromptAutoLoaded = true;

  const STORAGE_KEY = "flowPromptAutoState";
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

  let runnerActive = false;
  let shouldStop = false;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then((result) => sendResponse(result || { ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  injectFloatingControls();
  injectPageDebugBridge();
  refreshFloatingControls();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) refreshFloatingControls(changes[STORAGE_KEY].newValue);
  });

  window.__flowPromptAutoDebug = {
    findPromptEditor,
    findGenerateButton,
    getResultNodes,
    getResultSignature,
    fillPrompt,
    typeIntoSlateEditor,
    autoDownloadResults,
    downloadResultDirect,
    findDownloadControls,
    findBestDownloadControl,
    findDownloadSizeOptions,
    getNewestResultContainer,
    findMoreMenuButton,
    clickGenerate,
    submitPromptWithKeyboard,
    clickCenter
  };

  async function handleMessage(message) {
    if (!message || !message.type) return { ok: false, error: "Command kosong." };
    if (message.type === "PING") return { ok: true };
    if (message.type === "START") return start();
    if (message.type === "PAUSE") return pause();
    if (message.type === "RESUME") return resume();
    if (message.type === "NEXT") return runNextManually();
    if (message.type === "STOP") return stop();
    return { ok: false, error: `Command tidak dikenal: ${message.type}` };
  }

  async function start() {
    const state = await getState();
    if (!state.prompts.length) return fail("Belum ada prompt. Upload file .txt dari popup.");
    shouldStop = false;
    await saveState({ isRunning: true, status: "running", lastError: "" });
    runQueue();
    return { ok: true };
  }

  async function pause() {
    shouldStop = true;
    await saveState({ isRunning: false, status: "paused", lastError: "" });
    return { ok: true };
  }

  async function resume() {
    const state = await getState();
    if (!state.prompts.length) return fail("Belum ada prompt.");
    if (state.currentIndex >= state.prompts.length) {
      await saveState({ isRunning: false, status: "completed" });
      return { ok: true };
    }
    shouldStop = false;
    await saveState({ isRunning: true, status: "running", lastError: "" });
    runQueue();
    return { ok: true };
  }

  async function runNextManually() {
    shouldStop = true;
    await saveState({ isRunning: false, status: "paused", lastError: "" });
    const result = await processCurrentPrompt({ continueAfter: false });
    return result;
  }

  async function stop() {
    shouldStop = true;
    await saveState({ isRunning: false, status: "stopped", lastError: "" });
    return { ok: true };
  }

  async function runQueue() {
    if (runnerActive) return;
    runnerActive = true;
    try {
      while (!shouldStop) {
        const state = await getState();
        if (!state.isRunning) break;
        if (state.currentIndex >= state.prompts.length) {
          await saveState({ isRunning: false, status: "completed", lastError: "" });
          break;
        }
        const result = await processCurrentPrompt({ continueAfter: true });
        if (!result.ok) break;
      }
    } finally {
      runnerActive = false;
    }
  }

  async function processCurrentPrompt({ continueAfter }) {
    const state = await getState();
    const prompt = state.prompts[state.currentIndex];
    if (!prompt) {
      await saveState({ isRunning: false, status: "completed", lastError: "" });
      return { ok: true };
    }

    try {
      const baseline = getResultSignature();
      const baselineContainers = getResultContainers();
      await prepareFlowTabForUi();
      await fillPrompt(prompt);
      await submitPromptWithKeyboard();
      await restorePreviousTab();

      const resultContainer = await waitForNewResult(baseline, state.timeoutSeconds * 1000, baselineContainers);
      await sleep(1200);
      await prepareFlowTabForUi();
      await autoDownloadResults(resultContainer, prompt);
      await restorePreviousTab();
      await sleep(Math.max(1, state.settleSeconds) * 1000);

      const nextIndex = state.currentIndex + 1;
      const isDone = nextIndex >= state.prompts.length;
      await saveState({
        currentIndex: nextIndex,
        completedCount: Math.max(state.completedCount || 0, nextIndex),
        isRunning: continueAfter && !isDone,
        status: isDone ? "completed" : continueAfter ? "running" : "paused",
        lastError: ""
      });
      return { ok: true };
    } catch (error) {
      await restorePreviousTab().catch(() => {});
      await saveState({
        isRunning: false,
        status: "error",
        lastError: error.message || "Automasi berhenti karena error."
      });
      return { ok: false, error: error.message };
    }
  }

  async function fillPrompt(prompt) {
    const editor = await waitForElement(findPromptEditor, 15000, "Editor prompt tidak ditemukan.");
    await typeIntoSlateEditor(editor, prompt);
    await waitForPromptText(editor, prompt, 5000);
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(400);
  }

  async function clickGenerate() {
    const button = await waitForGenerateButtonReady(12000);
    button.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(120);
    await cdpClickElement(button);
    await sleep(900);
  }

  async function submitPromptWithKeyboard() {
    const editor = await waitForElement(findPromptEditor, 5000, "Editor prompt tidak ditemukan saat submit.");
    focusEditor(editor);
    moveCaretToEnd(editor);
    await sleep(120);

    const beforeSignature = getResultSignature();
    const combos = [
      { key: "Enter", code: "Enter", ctrlKey: true },
      { key: "Enter", code: "Enter", metaKey: true },
      { key: "Enter", code: "Enter" }
    ];

    for (const combo of combos) {
      await cdpKey(combo.key, combo.ctrlKey ? 2 : combo.metaKey ? 4 : 0);
      dispatchKeyboardCombo(editor, "keydown", combo);
      dispatchKeyboardCombo(editor, "keypress", combo);
      dispatchKeyboardCombo(editor, "keyup", combo);
      await sleep(900);
      if (getResultSignature() !== beforeSignature || isGenerationLikelyStarted()) return;
    }

    await clickGenerate();
  }

  function dispatchKeyboardCombo(element, eventName, combo) {
    element.dispatchEvent(new KeyboardEvent(eventName, {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: combo.key,
      code: combo.code,
      ctrlKey: Boolean(combo.ctrlKey),
      metaKey: Boolean(combo.metaKey),
      shiftKey: Boolean(combo.shiftKey),
      altKey: Boolean(combo.altKey)
    }));
  }

  function moveCaretToEnd(editor) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function isGenerationLikelyStarted() {
    const editor = findPromptEditor();
    const button = findGenerateButton();
    const statusText = normalizedText(document.body);
    return !editor ||
      (button && !isButtonEnabled(button)) ||
      /membuat|generating|creating|sedang membuat|memproses|processing/.test(statusText);
  }

  async function waitForGenerateButtonReady(timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const button = findGenerateButton();
      if (button && isButtonEnabled(button)) return button;
      await sleep(250);
    }
    throw new Error("Tombol generate belum aktif setelah prompt diketik.");
  }

  function isButtonEnabled(button) {
    if (!button || button.disabled) return false;
    if (button.getAttribute("aria-disabled") === "true") return false;
    if (button.getAttribute("data-disabled") === "true") return false;
    const style = getComputedStyle(button);
    if (style.pointerEvents === "none") return false;
    return true;
  }

  function findPromptEditor() {
    const candidates = uniqueElements([
      ...document.querySelectorAll('[data-slate-editor="true"][data-slate-node="value"][contenteditable="true"]'),
      ...document.querySelectorAll('[data-slate-editor="true"][contenteditable="true"][role="textbox"]'),
      ...document.querySelectorAll('[data-slate-editor="true"][contenteditable="true"]'),
      ...document.querySelectorAll('[role="textbox"][aria-multiline="true"][contenteditable="true"]'),
      ...document.querySelectorAll('[contenteditable="true"][role="textbox"]'),
      ...document.querySelectorAll('[contenteditable="true"]')
    ]);

    return candidates
      .map((element) => ({ element, score: scorePromptEditor(element) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function scorePromptEditor(element) {
    if (!isVisible(element)) return 0;
    if (element.closest('#flow-prompt-auto-panel')) return 0;

    const rect = element.getBoundingClientRect();
    if (rect.width < 180 || rect.height < 12) return 0;

    let score = 1;
    if (element.matches('[data-slate-editor="true"]')) score += 10;
    if (element.matches('[data-slate-node="value"]')) score += 5;
    if (element.matches('[role="textbox"]')) score += 4;
    if (element.getAttribute('aria-multiline') === 'true') score += 3;
    if (element.querySelector('[data-slate-placeholder]')) score += 3;
    if (normalizedText(element).includes('apa yang ingin anda buat')) score += 2;
    if (rect.bottom > window.innerHeight * 0.45) score += 1;
    return score;
  }

  function findGenerateButton() {
    const arrowIcons = [...document.querySelectorAll("i.google-symbols, i")]
      .filter((icon) => normalizedText(icon) === "arrow_forward");
    for (const icon of arrowIcons) {
      const button = icon.closest("button");
      if (button && isVisible(button)) return button;
    }

    const buttons = [...document.querySelectorAll("button")].filter(isVisible);
    const arrowButton = buttons.find((button) => {
      const text = normalizedText(button);
      const icon = button.querySelector("i.google-symbols, i");
      const iconText = normalizedText(icon || button);
      return iconText.includes("arrow_forward") && /buat|create|generate/i.test(text);
    });
    if (arrowButton) return arrowButton;

    return buttons.reverse().find((button) => {
      const text = normalizedText(button);
      return /(^|\s)(buat|create|generate)(\s|$)/i.test(text) && !text.includes("add_2");
    }) || null;
  }

  function getResultSignature() {
    const mediaNodes = getResultNodes();
    const nodeText = mediaNodes.map((node) => normalizedText(node).slice(0, 80)).join("|");
    return `${mediaNodes.length}:${document.querySelectorAll("img, video, canvas").length}:${nodeText}`;
  }

  function getResultNodes() {
    const promptEditor = findPromptEditor();
    const scroller = document.querySelector('[data-testid="virtuoso-scroller"]');
    const root = scroller || document;
    return [...root.querySelectorAll("img, video, canvas, [role='gridcell'], [data-testid*='asset'], [data-testid*='media']")]
      .filter((node) => node !== promptEditor && !promptEditor?.contains(node))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        const alt = (node.getAttribute?.("alt") || "").toLowerCase();
        if (alt.includes("bunga 8-bit")) return false;
        return isVisible(node) && rect.width > 80 && rect.height > 80;
      });
  }

  async function autoDownloadResults(targetContainer = null, prompt = "") {
    const newestContainer = targetContainer || getNewestResultContainer();
    if (!newestContainer) return 0;

    const directDownloaded = await downloadResultDirect(newestContainer, prompt);
    if (directDownloaded) return 1;

    revealResultControls(newestContainer);
    await sleep(500);

    const moreButton = findMoreMenuButton(newestContainer);
    if (!moreButton) return 0;
    await cdpClickElement(moreButton);
    await sleep(700);

    const downloadItem = await waitForOptionalElement(() => findBestDownloadControl(document), 5000);
    if (downloadItem) {
      await cdpClickElement(downloadItem);
      await sleep(700);
    } else {
      await openDownloadMenuByKeyboard();
    }

    const sizeClicked = await clickDownloadSizeOption();
    if (!sizeClicked) await cdpKey("Enter");
    return 1;
  }

  async function downloadResultDirect(container, prompt = "") {
    const media = findDownloadableMedia(container || getNewestResultContainer());
    if (!media) return false;

    const source = await getMediaDownloadSource(media);
    if (!source?.url) return false;

    const response = await chrome.runtime.sendMessage({
      type: "FLOW_DOWNLOAD_URL",
      url: source.url,
      filename: buildDownloadFilename(prompt, source.extension)
    });
    return Boolean(response && response.ok);
  }

  function findDownloadableMedia(container) {
    if (!container) return null;
    const media = [...container.querySelectorAll("img, video, canvas")]
      .filter(isVisible)
      .map((element) => ({ element, rect: element.getBoundingClientRect(), score: scoreDownloadableMedia(element) }))
      .filter((item) => item.score > 0 && item.rect.width > 80 && item.rect.height > 80)
      .sort((a, b) => b.score - a.score || (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
    return media[0]?.element || null;
  }

  function scoreDownloadableMedia(element) {
    const tag = element.tagName.toLowerCase();
    const src = element.currentSrc || element.src || "";
    const alt = (element.getAttribute?.("alt") || "").toLowerCase();
    let score = tag === "canvas" ? 8 : tag === "img" ? 10 : 6;
    if (alt.includes("bunga 8-bit")) score -= 20;
    if (/^https?:|^data:/.test(src)) score += 5;
    if (/^blob:/.test(src)) score += 2;
    const rect = element.getBoundingClientRect();
    if (rect.width >= 256 && rect.height >= 256) score += 4;
    return score;
  }

  async function getMediaDownloadSource(media) {
    const tag = media.tagName.toLowerCase();
    if (tag === "canvas") {
      try {
        return { url: media.toDataURL("image/png"), extension: "png" };
      } catch (_) {
        return null;
      }
    }

    const src = media.currentSrc || media.src || "";
    if (!src) return null;
    if (src.startsWith("data:")) return { url: src, extension: extensionFromDataUrl(src) || "jpg" };
    if (src.startsWith("http://") || src.startsWith("https://")) return { url: src, extension: extensionFromUrl(src) || "jpg" };
    if (src.startsWith("blob:")) return blobSourceToDataUrl(src);
    return null;
  }

  async function blobSourceToDataUrl(src) {
    try {
      const response = await fetch(src);
      const blob = await response.blob();
      return {
        url: await blobToDataUrl(blob),
        extension: extensionFromMime(blob.type) || "jpg"
      };
    } catch (_) {
      return null;
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Blob hasil tidak bisa dibaca."));
      reader.readAsDataURL(blob);
    });
  }

  function buildDownloadFilename(prompt, extension = "jpg") {
    const base = (prompt || "flow-output")
      .replace(/[^a-z0-9\s_-]+/gi, "")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 80)
      .replace(/^_+|_+$/g, "") || "flow-output";
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const ext = String(extension || "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
    return base + "_" + stamp + "." + ext;
  }

  function extensionFromUrl(url) {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
      if (match && /^(jpe?g|png|webp|gif|avif|mp4|webm)$/.test(match[1])) return match[1] === "jpeg" ? "jpg" : match[1];
    } catch (_) {}
    return "jpg";
  }

  function extensionFromDataUrl(url) {
    const match = String(url).match(/^data:([^;,]+)/i);
    return match ? extensionFromMime(match[1]) : "jpg";
  }

  function extensionFromMime(mime) {
    const map = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/avif": "avif",
      "video/mp4": "mp4",
      "video/webm": "webm"
    };
    return map[String(mime || "").toLowerCase()] || "jpg";
  }

  function getResultContainers() {
    return uniqueElements(getResultNodes().map((node) => getResultContainer(node)).filter(Boolean));
  }

  function getFreshResultContainer(baselineContainers = []) {
    const baselineSet = new Set(baselineContainers);
    return getResultContainers()
      .filter((element) => !baselineSet.has(element))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.width > 100 && item.rect.height > 100)
      .sort(readingOrderForNewest)[0]?.element || null;
  }

  function getNewestResultContainer() {
    return getResultContainers()
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.width > 100 && item.rect.height > 100)
      .sort(readingOrderForNewest)[0]?.element || null;
  }

  function readingOrderForNewest(a, b) {
    return (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left);
  }

  async function clickDownloadSizeOption() {
    const option = await waitForOptionalElement(() => findDownloadSizeOptions().find(isVisible), 3000);
    if (!option) return false;
    await cdpClickElement(option);
    await sleep(600);
    return true;
  }

  async function openDownloadMenuByKeyboard() {
    for (let index = 0; index < 3; index += 1) {
      await cdpKey("ArrowDown");
      await sleep(120);
    }
    await cdpKey("Enter");
    await sleep(700);
  }

  function findDownloadSizeOptions() {
    return [...document.querySelectorAll('button, [role="menuitem"], [role="option"], [role="button"], div, span')]
      .filter(isVisible)
      .filter((element) => {
        const text = [
          normalizedText(element),
          ownNormalizedText(element),
          normalizedTextFromAttribute(element, "aria-label"),
          normalizedTextFromAttribute(element, "title")
        ].join(" ");
        return /ukuran asli|original|\b1k\b|\b2k\b|\b4k\b/.test(text);
      })
      .map((element) => toClickableElement(element, true));
  }

  function findMoreMenuButton(root) {
    const controls = [...root.querySelectorAll('button, [role="button"]')].filter(isVisible);
    return controls
      .map((control) => ({ control, rect: control.getBoundingClientRect(), score: scoreMoreMenuButton(control) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.rect.top - a.rect.top || b.rect.left - a.rect.left)[0]?.control || null;
  }

  function scoreMoreMenuButton(control) {
    const text = normalizedText(control);
    const aria = normalizedTextFromAttribute(control, "aria-label");
    const title = normalizedTextFromAttribute(control, "title");
    const iconText = normalizedText(control.querySelector("i.google-symbols, i") || null);
    const haystack = [text, aria, title, iconText].join(" ");
    if (/more_vert|lainnya|opsi lainnya|more options/.test(haystack)) return 10;
    if (haystack.trim() === "") {
      const rect = control.getBoundingClientRect();
      if (rect.width <= 80 && rect.height <= 80) return 1;
    }
    return 0;
  }

  function getResultContainer(node) {
    return node.closest('[role="gridcell"], article, [data-testid*="asset"], [data-testid*="media"]') ||
      node.closest('div') ||
      node.parentElement;
  }

  function revealResultControls(element) {
    const rect = element.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    element.scrollIntoView({ block: "center", inline: "nearest" });
    element.dispatchEvent(new PointerEvent("pointerover", eventInit));
    element.dispatchEvent(new MouseEvent("mouseover", eventInit));
    element.dispatchEvent(new PointerEvent("pointermove", eventInit));
    element.dispatchEvent(new MouseEvent("mousemove", eventInit));
  }

  function findBestDownloadControl(root) {
    return findDownloadControls(root)
      .map((control) => {
        const rect = control.getBoundingClientRect();
        return {
          control,
          score: scoreDownloadControl(control),
          rect,
          area: rect.width * rect.height
        };
      })
      .filter((item) => item.score > 0 && item.rect.width > 0 && item.rect.height > 0)
      .sort((a, b) => b.score - a.score || a.area - b.area || b.rect.top - a.rect.top)[0]?.control || null;
  }

  function findDownloadControls(root) {
    const candidates = [...root.querySelectorAll('button, a[href], [role="button"], [role="menuitem"], [cmdk-item], div, span')]
      .filter(isVisible)
      .filter((element) => scoreDownloadControl(element) > 0);
    return uniqueElements(candidates.map((element) => toClickableElement(element, true)));
  }

  function scoreDownloadControl(element) {
    const text = normalizedText(element);
    const directText = ownNormalizedText(element);
    const aria = normalizedTextFromAttribute(element, "aria-label");
    const title = normalizedTextFromAttribute(element, "title");
    const iconText = normalizedText(element.querySelector?.("i.google-symbols, i") || null);
    const href = element.getAttribute?.("href") || "";
    const haystack = [text, aria, title, iconText, href.toLowerCase()].join(" ");
    let score = 0;
    if (/^(download|unduh)$/.test(directText) || /^(download|unduh)$/.test(aria) || /^(download|unduh)$/.test(title)) score += 30;
    if (/\bdownload\b|unduh/.test(haystack)) score += 10;
    if (/file_download|download_for_offline|save_alt/.test(haystack)) score += 9;
    if (/menuitem|button/.test(element.getAttribute?.("role") || "") || /^(button|a)$/i.test(element.tagName)) score += 3;
    if (element.closest?.('[role="menu"], [data-radix-menu-content], [cmdk-list]')) score += 2;
    if (text.length > 80 && !/^(download|unduh)$/.test(directText)) score -= 8;
    return Math.max(score, 0);
  }

  function ownNormalizedText(element) {
    if (!element?.childNodes) return "";
    return [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function toClickableElement(element, preferMenuItem = false) {
    if (preferMenuItem) {
      const menuItem = element.closest?.('[role="menuitem"], [cmdk-item]');
      if (menuItem) return menuItem;
    }
    return element.closest?.('button, a[href], [role="button"], [role="menuitem"], [cmdk-item]') || element;
  }

  function debugDownloadCandidates() {
    return findDownloadControls(document).map((element) => ({
      tag: element.tagName,
      role: element.getAttribute?.("role") || "",
      text: normalizedText(element).slice(0, 120),
      ownText: ownNormalizedText(element).slice(0, 80),
      aria: normalizedTextFromAttribute(element, "aria-label"),
      title: normalizedTextFromAttribute(element, "title"),
      score: scoreDownloadControl(element),
      rect: (() => {
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
      })()
    }));
  }

  function normalizedTextFromAttribute(element, attribute) {
    return (element.getAttribute?.(attribute) || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  async function waitForNewResult(baseline, timeoutMs, baselineContainers = []) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        observer.disconnect();
        clearInterval(interval);
        clearTimeout(timeout);
      };
      const check = () => {
        if (settled) return;
        const current = getResultSignature();
        const freshContainer = getFreshResultContainer(baselineContainers);
        if (current !== baseline && getResultNodes().length > 0 && Date.now() - startedAt > 2500) {
          cleanup();
          resolve(freshContainer || getNewestResultContainer());
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      const interval = setInterval(check, 1000);
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Hasil tidak terdeteksi dalam ${Math.round(timeoutMs / 1000)} detik. Automasi dipause.`));
      }, timeoutMs);
      check();
    });
  }

  function injectPageDebugBridge() {
    if (document.getElementById("flow-prompt-auto-debug-bridge")) return;
    document.addEventListener("flowPromptAutoDebugCommand", async (event) => {
      const { id, command, args = [] } = event.detail || {};
      try {
        const api = {
          fillPrompt,
          submitPromptWithKeyboard,
          clickGenerate,
          autoDownloadResults,
          downloadResultDirect,
          debugDownloadCandidates
        };
        if (!api[command]) throw new Error("Unknown debug command: " + command);
        const value = await api[command](...args);
        window.dispatchEvent(new CustomEvent("flowPromptAutoDebugResult", { detail: { id, ok: true, value } }));
      } catch (error) {
        window.dispatchEvent(new CustomEvent("flowPromptAutoDebugResult", { detail: { id, ok: false, error: error.message } }));
      }
    });

    const script = document.createElement("script");
    script.id = "flow-prompt-auto-debug-bridge";
    script.textContent = `
      window.__flowPromptAutoDebug = {
        run(command, ...args) {
          const id = Math.random().toString(36).slice(2);
          return new Promise((resolve, reject) => {
            const onResult = (event) => {
              if (!event.detail || event.detail.id !== id) return;
              window.removeEventListener("flowPromptAutoDebugResult", onResult);
              event.detail.ok ? resolve(event.detail.value) : reject(new Error(event.detail.error));
            };
            window.addEventListener("flowPromptAutoDebugResult", onResult);
            document.dispatchEvent(new CustomEvent("flowPromptAutoDebugCommand", { detail: { id, command, args } }));
          });
        },
        fillPrompt(prompt) { return this.run("fillPrompt", prompt); },
        submitPromptWithKeyboard() { return this.run("submitPromptWithKeyboard"); },
        clickGenerate() { return this.run("clickGenerate"); },
        autoDownloadResults() { return this.run("autoDownloadResults"); },
        downloadResultDirect() { return this.run("downloadResultDirect"); },
        debugDownloadCandidates() { return this.run("debugDownloadCandidates"); }
      };
    `;
    document.documentElement.appendChild(script);
    script.remove();
  }

  function injectFloatingControls() {
    if (document.getElementById("flow-prompt-auto-panel")) return;

    const style = document.createElement("style");
    style.id = "flow-prompt-auto-style";
    style.textContent = `
      #flow-prompt-auto-panel {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: 300px;
        padding: 12px;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 10px;
        background: rgba(18, 24, 20, .94);
        color: #f4fff7;
        font: 12px/1.4 Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 12px 36px rgba(0,0,0,.35);
      }
      #flow-prompt-auto-panel strong { display: block; font-size: 13px; margin-bottom: 4px; }
      #flow-prompt-auto-panel .fpa-muted { color: #aebdaf; }
      #flow-prompt-auto-panel .fpa-current {
        max-height: 54px;
        overflow: hidden;
        margin: 8px 0;
        color: #e9fff0;
      }
      #flow-prompt-auto-panel .fpa-error { color: #fecaca; margin-top: 6px; }
      #flow-prompt-auto-panel .fpa-actions {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 6px;
        margin-top: 8px;
      }
      #flow-prompt-auto-panel button {
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 6px;
        padding: 6px 5px;
        background: rgba(255,255,255,.08);
        color: #fff;
        cursor: pointer;
        font: inherit;
      }
      #flow-prompt-auto-panel button:hover { background: rgba(255,255,255,.16); }
    `;

    const panel = document.createElement("aside");
    panel.id = "flow-prompt-auto-panel";
    panel.innerHTML = `
      <strong>Flow Prompt Auto</strong>
      <div class="fpa-muted" data-fpa-status>idle</div>
      <div class="fpa-current" data-fpa-current>Belum ada prompt.</div>
      <div class="fpa-muted" data-fpa-count>0 / 0</div>
      <div class="fpa-muted" data-fpa-target>Belum terkunci ke tab Flow.</div>
      <div class="fpa-error" data-fpa-error></div>
      <div class="fpa-actions">
        <button type="button" data-fpa-command="PAUSE">Pause</button>
        <button type="button" data-fpa-command="RESUME">Resume</button>
        <button type="button" data-fpa-command="NEXT">Next</button>
        <button type="button" data-fpa-command="STOP">Stop</button>
      </div>
    `;

    panel.addEventListener("click", (event) => {
      const button = event.target.closest("[data-fpa-command]");
      if (!button) return;
      handleMessage({ type: button.dataset.fpaCommand });
    });

    document.documentElement.append(style, panel);
  }

  async function refreshFloatingControls(state) {
    const current = state ? { ...DEFAULT_STATE, ...state } : await getState();
    const panel = document.getElementById("flow-prompt-auto-panel");
    if (!panel) return;
    const total = current.prompts.length;
    const prompt = current.prompts[current.currentIndex] || "Belum ada prompt.";
    panel.querySelector("[data-fpa-status]").textContent = `Status: ${current.status}`;
    panel.querySelector("[data-fpa-current]").textContent = prompt;
    panel.querySelector("[data-fpa-count]").textContent = `${Math.min(current.currentIndex + 1, total || 0)} / ${total} | selesai ${current.completedCount || 0}`;
    panel.querySelector("[data-fpa-target]").textContent = current.targetStatus || (current.flowTabId ? `Terkunci: tab ${current.flowTabId}` : "Belum terkunci ke tab Flow.");
    panel.querySelector("[data-fpa-error]").textContent = current.lastError || "";
  }

  async function prepareFlowTabForUi() {
    const response = await chrome.runtime.sendMessage({ type: "FLOW_UI_PHASE", action: "prepare" });
    if (!response || response.ok === false) throw new Error(response?.error || "Gagal memvalidasi tab Flow.");
  }

  async function restorePreviousTab() {
    await chrome.runtime.sendMessage({ type: "FLOW_UI_PHASE", action: "restore" });
  }

  async function waitForOptionalElement(getter, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const element = getter();
      if (element) return element;
      await sleep(200);
    }
    return null;
  }

  async function waitForElement(getter, timeoutMs, errorMessage) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const element = getter();
      if (element) return element;
      await sleep(300);
    }
    throw new Error(errorMessage);
  }

  async function getState() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return { ...DEFAULT_STATE, ...(result[STORAGE_KEY] || {}) };
  }

  async function saveState(patch) {
    const state = await getState();
    await chrome.storage.local.set({ [STORAGE_KEY]: { ...state, ...patch } });
  }

  async function fail(message) {
    await saveState({ isRunning: false, status: "error", lastError: message });
    return { ok: false, error: message };
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function normalizedText(element) {
    if (!element) return "";
    return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function uniqueElements(elements) {
    return [...new Set(elements)];
  }

  async function typeIntoSlateEditor(editor, text) {
    editor.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(100);
    focusEditor(editor);
    selectEditorContents(editor);
    dispatchKeyboard(editor, "keydown", "Backspace");
    document.execCommand("delete");
    dispatchInput(editor, "deleteContentBackward", null);
    await sleep(100);

    const chunks = chunkText(text, 8);
    for (const chunk of chunks) {
      focusEditor(editor);
      dispatchKeyboard(editor, "keydown", chunk);
      dispatchInput(editor, "insertText", chunk, "beforeinput");
      const inserted = document.execCommand("insertText", false, chunk);
      if (!inserted) insertTextAtSelection(chunk);
      dispatchInput(editor, "insertText", chunk, "input");
      dispatchKeyboard(editor, "keyup", chunk);
      await sleep(18);
    }
  }

  async function waitForPromptText(editor, expectedText, timeoutMs) {
    const startedAt = Date.now();
    const expected = compactText(expectedText);
    while (Date.now() - startedAt < timeoutMs) {
      const current = compactText(editor.innerText || editor.textContent || "");
      if (current.includes(expected.slice(0, Math.min(expected.length, 80)))) return;
      await sleep(100);
    }
    throw new Error("Prompt sudah diketik, tetapi Flow belum membaca isi editor. Coba reload halaman Flow lalu jalankan lagi.");
  }

  function focusEditor(editor) {
    editor.focus();
    editor.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    editor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  }

  function selectEditorContents(editor) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function insertTextAtSelection(text) {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function dispatchInput(element, inputType, data, eventName = "input") {
    element.dispatchEvent(new InputEvent(eventName, {
      bubbles: true,
      cancelable: eventName === "beforeinput",
      composed: true,
      inputType,
      data
    }));
  }

  function dispatchKeyboard(element, eventName, key) {
    const printable = key.length === 1;
    element.dispatchEvent(new KeyboardEvent(eventName, {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: printable ? key : key,
      code: printable ? undefined : key,
      inputType: printable ? "insertText" : undefined
    }));
  }

  function chunkText(text, size) {
    const chunks = [];
    for (let index = 0; index < text.length; index += size) {
      chunks.push(text.slice(index, index + size));
    }
    return chunks;
  }

  function compactText(text) {
    return text.replace(/\uFEFF/g, "").replace(/\s+/g, " ").trim();
  }

  async function cdpClickElement(element) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const response = await chrome.runtime.sendMessage({ type: "CDP_INPUT", action: "click", x, y });
    if (!response || response.ok === false) throw new Error(response?.error || "CDP click gagal.");
  }

  async function cdpKey(key, modifiers = 0) {
    const response = await chrome.runtime.sendMessage({ type: "CDP_INPUT", action: "key", key, modifiers });
    if (!response || response.ok === false) throw new Error(response?.error || "CDP key gagal.");
  }

  function clickLikeUser(element) {
    const rect = element.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0
    };
    element.dispatchEvent(new PointerEvent("pointerdown", eventInit));
    element.dispatchEvent(new MouseEvent("mousedown", eventInit));
    element.dispatchEvent(new PointerEvent("pointerup", eventInit));
    element.dispatchEvent(new MouseEvent("mouseup", eventInit));
    element.dispatchEvent(new MouseEvent("click", eventInit));
    element.click?.();
  }

  function clickCenter(element) {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) || element;
    const clickable = target.closest?.("button, [role='button'], a") || element;
    clickLikeUser(clickable);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
