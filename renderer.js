// renderer.js

let activeModel = null;

// load states keyed by model
// { [model]: { initialized: boolean, loading: boolean, error: boolean } }
const modelStates = Object.create(null);

// Behavior settings (defaults match main.js)
let confirmBeforeStop = false;
let hardReloadOnRefresh = false;
let layoutMode = "tabs";

// Models catalog cache (id -> { id, name, url, builtIn })
let modelsById = Object.create(null);
let compareModelIds = [];
let compareHistoryOpen = false;
let compareAttachments = [];
let lastCompareResults = [];

// last tab order we rendered (array of model ids)
let lastTabOrder = [];

// -----------------------------
// APP SETTINGS (Behavior flags)
// -----------------------------

function applyAppSettingsToRenderer(settings) {
  if (!settings || typeof settings !== "object") return;

  if (settings.layoutMode === "compare" || settings.layoutMode === "tabs") {
    layoutMode = settings.layoutMode;
    applyLayoutModeToDOM(layoutMode);
  }

  if (typeof settings.confirmBeforeStop === "boolean") {
    confirmBeforeStop = settings.confirmBeforeStop;
  }
  if (typeof settings.hardReloadOnRefresh === "boolean") {
    hardReloadOnRefresh = settings.hardReloadOnRefresh;
  }

  applySetupVisibility(!!settings.needsFirstRunSetup);
}

function applyLayoutModeToDOM(mode) {
  const compareMode = mode === "compare" ? "compare" : "tabs";
  document.body.setAttribute("data-layout-mode", compareMode);

  const compareButton = document.getElementById("compare-mode-button");
  if (compareButton) {
    const active = compareMode === "compare";
    const label = active ? "Single view" : "Compare view";
    const labelEl = document.getElementById("compare-mode-button-label");
    compareButton.classList.toggle("active", active);
    compareButton.setAttribute("aria-pressed", active ? "true" : "false");
    compareButton.title = label;
    compareButton.setAttribute("aria-label", label);
    if (labelEl) labelEl.textContent = active ? "Single" : "Compare";
  }

  const composer = document.getElementById("compare-composer");
  if (composer) {
    composer.setAttribute("aria-hidden", compareMode === "compare" ? "false" : "true");
  }

  const compareHeaders = document.getElementById("compare-pane-headers");
  if (compareHeaders) {
    compareHeaders.setAttribute("aria-hidden", compareMode === "compare" ? "false" : "true");
  }

  if (compareMode === "compare") {
    requestAnimationFrame(() => {
      renderCompareHeaders(compareModelIds);
    });
  }
}

function initAppSettings() {
  // initial load
  window.electronAPI.getAppSettings()
    .then(applyAppSettingsToRenderer)
    .catch((err) => { console.warn("Multi-AI-Wrapper(renderer): getAppSettings failed", err); });

  // live updates (e.g., toggled inside Settings window)
  window.electronAPI.onAppSettingsChanged((settings) => {
    applyAppSettingsToRenderer(settings);
  });
}

function applySetupVisibility(show) {
  const overlay = document.getElementById("setup-overlay");
  if (!overlay) return;
  overlay.hidden = true;
  overlay.setAttribute("aria-hidden", "true");
}

function initSetupOverlay() {
  const startButton = document.getElementById("setup-start-button");
  const settingsButton = document.getElementById("setup-settings-button");

  if (startButton) {
    startButton.addEventListener("click", async () => {
      try {
        await window.electronAPI.setAppSettings({ setupComplete: true });
      } catch (err) {
        console.warn("Multi-AI-Wrapper(renderer): setup completion failed", err);
      }
    });
  }

  if (settingsButton) {
    settingsButton.addEventListener("click", async () => {
      try {
        await window.electronAPI.openSettings();
      } catch (err) {
        console.warn("Multi-AI-Wrapper(renderer): setup settings failed", err);
      }
    });
  }
}

// -----------------------------
// THEME
// -----------------------------

function applyThemeToDOM(payload) {
  // main sends: { source: "system"|"light"|"dark", shouldUseDarkColors: boolean }
  const effective = payload && payload.shouldUseDarkColors ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", effective);
}

function initThemeSync() {
  window.electronAPI.getTheme()
    .then(applyThemeToDOM)
    .catch((err) => { console.warn("Multi-AI-Wrapper(renderer): getTheme failed, defaulting to dark", err); document.documentElement.setAttribute("data-theme", "dark"); });

  window.electronAPI.onThemeChanged((payload) => {
    applyThemeToDOM(payload);
  });
}

// -----------------------------
// SETTINGS BUTTON
// -----------------------------

function initSettingsButton() {
  const btn = document.getElementById("settings-button");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    try {
      await window.electronAPI.openSettings();
    } catch (err) { console.warn("Multi-AI-Wrapper(renderer): openSettings failed", err); }
  });
}

function setCompareStatus(message) {
  const statusEl = document.getElementById("compare-status");
  if (!statusEl) return;
  statusEl.textContent = message || "";
}

function applyCompareHistoryVisibility(open) {
  compareHistoryOpen = !!open;
  const historyButton = document.getElementById("compare-history-button");
  if (!historyButton) return;
  historyButton.classList.toggle("active", compareHistoryOpen);
  historyButton.setAttribute("aria-expanded", compareHistoryOpen ? "true" : "false");
}

function initCompareModeButton() {
  const btn = document.getElementById("compare-mode-button");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    try {
      const nextMode = layoutMode === "compare" ? "tabs" : "compare";
      await window.electronAPI.setAppSettings({ layoutMode: nextMode });
    } catch (err) {
      console.warn("Multi-AI-Wrapper(renderer): compare mode toggle failed", err);
    }
  });
}

function initCompareComposerSizing() {
  const composer = document.getElementById("compare-composer");
  if (!composer || !window.electronAPI.setCompareComposerHeight) return;

  let lastHeight = 0;
  const report = () => {
    const rect = composer.getBoundingClientRect();
    const height = Math.ceil(rect.height || 0);
    if (!height || height === lastHeight) return;
    lastHeight = height;
    window.electronAPI.setCompareComposerHeight(height);
  };

  report();
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(report);
    observer.observe(composer);
  }
  window.addEventListener("resize", report);
}

function buildCompareResultMessage(result) {
  if (!result) return "Shared send failed.";
  if (result.error === "empty-prompt") return "Enter a prompt or attach an image first.";

  const total = Number.isFinite(result.totalCount) ? result.totalCount : 0;
  const success = Number.isFinite(result.successCount) ? result.successCount : 0;
  const manual = Number.isFinite(result.manualCount) ? result.manualCount : 0;
  const failed = Number.isFinite(result.failureCount) ? result.failureCount : Math.max(0, total - success - manual);
  const attachmentCount = Number.isFinite(result.attachmentCount) ? result.attachmentCount : 0;
  const fileAttachmentCount = Number.isFinite(result.fileAttachmentCount) ? result.fileAttachmentCount : 0;
  const hasPrompt = !!result.hasPrompt;
  const stagedOnly = attachmentCount > 0;
  const sentLabel = stagedOnly
    ? fileAttachmentCount
      ? hasPrompt ? "Prompt/files staged" : "Files staged"
      : hasPrompt ? "Prompt/images staged" : "Images staged"
    : "Prompt sent";

  if (!total) return "No visible compare panes.";

  const parts = [];
  if (success) parts.push(`${success} ${stagedOnly ? "staged" : "sent"}`);
  if (manual) parts.push(`${manual} manual`);
  if (failed) parts.push(`${failed} failed`);

  const suffix = manual
    ? "Manual panes stay visible for copy/paste."
    : stagedOnly
      ? "Submit staged image prompts manually in each pane."
      : "";

  return `${sentLabel}: ${parts.join(", ")}.${suffix ? ` ${suffix}` : ""}`;
}

function getCompareResultLabel(result) {
  if (!result) return "Unknown";
  if (result.manualOnly) return "Manual";
  if (result.ok && result.method && result.method.startsWith("staged")) return "Staged";
  if (result.ok) return "Sent";

  const error = result.error || "";
  if (error === "model-not-ready") return "Loading";
  if (error === "composer-not-found" || error === "prepare-failed") return "No composer";
  if (error === "file-input-not-found") return "No file input";
  if (error === "file-stage-failed") return "File failed";
  if (error === "new-chat-not-found") return "No new chat";
  return "Failed";
}

function renderCompareResults(results) {
  const resultsEl = document.getElementById("compare-results");
  if (!resultsEl) return;

  lastCompareResults = Array.isArray(results) ? results.slice() : [];
  resultsEl.innerHTML = "";
  resultsEl.classList.toggle("has-items", lastCompareResults.length > 0);

  for (const result of lastCompareResults) {
    const chip = document.createElement("span");
    chip.className = "compare-result-chip";
    if (result?.manualOnly) chip.classList.add("manual");
    else if (result?.ok) chip.classList.add("ok");
    else chip.classList.add("failed");

    const modelName = getModelLabel(result?.modelId);
    chip.textContent = `${modelName}: ${getCompareResultLabel(result)}`;
    chip.title = result?.error ? `${modelName}: ${result.error}` : chip.textContent;
    resultsEl.appendChild(chip);
  }
}

function buildNewChatResultMessage(result) {
  if (!result) return "New chat failed.";
  const total = Number.isFinite(result.totalCount) ? result.totalCount : 0;
  const success = Number.isFinite(result.successCount) ? result.successCount : 0;
  const manual = Number.isFinite(result.manualCount) ? result.manualCount : 0;
  const failed = Number.isFinite(result.failureCount) ? result.failureCount : Math.max(0, total - success - manual);
  const parts = [];
  if (success) parts.push(`${success} started`);
  if (manual) parts.push(`${manual} manual`);
  if (failed) parts.push(`${failed} failed`);
  return parts.length ? `New chat: ${parts.join(", ")}.` : "No visible compare panes.";
}

function initCompareComposer() {
  const input = document.getElementById("compare-prompt-input");
  const sendButton = document.getElementById("compare-send-button");
  const newChatButton = document.getElementById("compare-new-chat-button");
  const historyButton = document.getElementById("compare-history-button");
  const attachButton = document.getElementById("compare-attach-button");
  const fileButton = document.getElementById("compare-file-button");
  const attachmentsEl = document.getElementById("compare-attachments");
  if (!input || !sendButton || !newChatButton || !historyButton || !attachButton || !fileButton || !attachmentsEl) return;

  const focusCompareInput = () => {
    try {
      window.focus();
    } catch (_) {}
    input.focus();
    const length = input.value.length;
    input.setSelectionRange(length, length);
  };

  const renderCompareAttachments = () => {
    attachmentsEl.innerHTML = "";
    const hasItems = compareAttachments.length > 0;
    const imageCount = compareAttachments.filter((item) => item.type === "image").length;
    const fileCount = compareAttachments.filter((item) => item.type === "file").length;
    attachmentsEl.classList.toggle("has-items", hasItems);
    attachButton.classList.toggle("has-items", imageCount > 0);
    fileButton.classList.toggle("has-items", fileCount > 0);
    attachButton.title = imageCount ? `Attached images (${imageCount})` : "Attach images";
    attachButton.setAttribute(
      "aria-label",
      imageCount ? `Attached images (${imageCount})` : "Attach images"
    );
    fileButton.title = fileCount ? `Attached files (${fileCount})` : "Attach files";
    fileButton.setAttribute(
      "aria-label",
      fileCount ? `Attached files (${fileCount})` : "Attach files"
    );

    if (!hasItems) return;

    for (const item of compareAttachments) {
      const chip = document.createElement("div");
      chip.className = "compare-attachment-chip";
      chip.classList.add(item.type === "file" ? "file" : "image");

      const name = document.createElement("span");
      name.className = "compare-attachment-name";
      name.textContent = item.name || (item.type === "file" ? "File" : "Image");
      name.title = name.textContent;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "compare-attachment-remove";
      remove.textContent = "×";
      remove.title = `Remove ${item.name || "image"}`;
      remove.dataset.path = item.path || "";

      chip.appendChild(name);
      chip.appendChild(remove);
      attachmentsEl.appendChild(chip);
    }
  };

  const setCompareAttachments = (items) => {
    const next = Array.isArray(items) ? items : [];
    compareAttachments = next
      .filter((item) => item && typeof item.path === "string" && item.path)
      .map((item) => ({
        path: item.path,
        type: item.type === "file" ? "file" : "image",
        name: typeof item.name === "string" && item.name
          ? item.name
          : item.path.split(/[\\/]/).pop() || (item.type === "file" ? "File" : "Image")
      }));
    renderCompareAttachments();
  };

  const toggleCompareHistoryFromUI = async () => {
    try {
      if (compareHistoryOpen) {
        window.electronAPI.closeCompareHistory();
        return;
      }

      const rect = historyButton.getBoundingClientRect();
      await window.electronAPI.toggleCompareHistory({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      });
    } catch (err) {
      console.warn("Multi-AI-Wrapper(renderer): compare history toggle failed", err);
    }
  };

  const placePromptInComposer = (promptText) => {
    input.value = typeof promptText === "string" ? promptText : "";
    focusCompareInput();
  };

  const sendPrompt = async () => {
    const promptText = input.value || "";
    const imagePaths = compareAttachments
      .filter((item) => item.type === "image")
      .map((item) => item.path)
      .filter(Boolean);
    const filePaths = compareAttachments
      .filter((item) => item.type === "file")
      .map((item) => item.path)
      .filter(Boolean);
    if (!promptText.trim() && imagePaths.length === 0 && filePaths.length === 0) {
      setCompareStatus("Enter a prompt or attach a file first.");
      input.focus();
      return;
    }

    sendButton.disabled = true;
    attachButton.disabled = true;
    fileButton.disabled = true;
    newChatButton.disabled = true;
    setCompareStatus("Sending...");
    renderCompareResults([]);

    try {
      const result = await window.electronAPI.sendComparePrompt({ promptText, imagePaths, filePaths });
      setCompareStatus(buildCompareResultMessage(result));
      renderCompareResults(result?.results || []);

      if (result?.ok && !result?.manualCount) {
        input.value = "";
        setCompareAttachments([]);
      }
    } catch (err) {
      console.warn("Multi-AI-Wrapper(renderer): shared send failed", err);
      setCompareStatus("Shared send failed.");
    } finally {
      sendButton.disabled = false;
      attachButton.disabled = false;
      fileButton.disabled = false;
      newChatButton.disabled = false;
      focusCompareInput();
      setTimeout(() => {
        focusCompareInput();
      }, 80);
    }
  };

  const startNewChat = async () => {
    newChatButton.disabled = true;
    sendButton.disabled = true;
    attachButton.disabled = true;
    fileButton.disabled = true;
    setCompareStatus("Starting new chats...");
    renderCompareResults([]);

    try {
      const result = await window.electronAPI.startNewChatInCompare();
      setCompareStatus(buildNewChatResultMessage(result));
      renderCompareResults(result?.results || []);
    } catch (err) {
      console.warn("Multi-AI-Wrapper(renderer): new chat failed", err);
      setCompareStatus("New chat failed.");
    } finally {
      newChatButton.disabled = false;
      sendButton.disabled = false;
      attachButton.disabled = false;
      fileButton.disabled = false;
      focusCompareInput();
    }
  };

  sendButton.addEventListener("click", () => {
    sendPrompt();
  });

  newChatButton.addEventListener("click", () => {
    startNewChat();
  });

  historyButton.addEventListener("click", async () => {
    await toggleCompareHistoryFromUI();
  });

  attachButton.addEventListener("click", async () => {
    try {
      const result = await window.electronAPI.pickCompareImages();
      if (!result?.ok || result?.canceled) return;

      const incoming = Array.isArray(result.images) ? result.images : [];
      if (!incoming.length) return;

      const next = compareAttachments.slice();
      const seen = new Set(next.map((item) => item.path));
      for (const item of incoming) {
        if (!item?.path || seen.has(item.path)) continue;
        seen.add(item.path);
        next.push({
          path: item.path,
          type: "image",
          name: item.name || item.path.split(/[\\/]/).pop() || "Image"
        });
      }

      setCompareAttachments(next);
      renderCompareResults(lastCompareResults);
      setCompareStatus(
        next.length === 1 ? "1 image attached." : `${next.length} images attached.`
      );
      focusCompareInput();
    } catch (err) {
      console.warn("Multi-AI-Wrapper(renderer): pickCompareImages failed", err);
      setCompareStatus("Image picker failed.");
    }
  });

  fileButton.addEventListener("click", async () => {
    try {
      const result = await window.electronAPI.pickCompareFiles();
      if (!result?.ok || result?.canceled) return;

      const incoming = Array.isArray(result.files) ? result.files : [];
      if (!incoming.length) return;

      const next = compareAttachments.slice();
      const seen = new Set(next.map((item) => item.path));
      for (const item of incoming) {
        if (!item?.path || seen.has(item.path)) continue;
        seen.add(item.path);
        next.push({
          path: item.path,
          type: "file",
          name: item.name || item.path.split(/[\\/]/).pop() || "File"
        });
      }

      setCompareAttachments(next);
      renderCompareResults(lastCompareResults);
      const fileCount = next.filter((item) => item.type === "file").length;
      setCompareStatus(fileCount === 1 ? "1 file attached." : `${fileCount} files attached.`);
      focusCompareInput();
    } catch (err) {
      console.warn("Multi-AI-Wrapper(renderer): pickCompareFiles failed", err);
      setCompareStatus("File picker failed.");
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendPrompt();
    }
  });

  attachmentsEl.addEventListener("click", (event) => {
    const button = event.target?.closest?.(".compare-attachment-remove");
    if (!button) return;

    const path = button.dataset.path || "";
    setCompareAttachments(compareAttachments.filter((item) => item.path !== path));
    setCompareStatus(compareAttachments.length ? "Attachment removed." : "");
    focusCompareInput();
  });

  window.electronAPI.onCompareHistorySelected((payload) => {
    placePromptInComposer(payload?.promptText || "");
    setCompareStatus("Prompt loaded from history.");
  });

  window.electronAPI.onCompareHistoryVisibilityChanged((payload) => {
    applyCompareHistoryVisibility(!!payload?.open);
  });

  window.electronAPI.onShortcutCommand(async (payload) => {
    const command = payload?.command;
    if (command === "focus-compare-composer") {
      focusCompareInput();
      return;
    }
    if (command === "toggle-compare-history") {
      await toggleCompareHistoryFromUI();
    }
  });

  renderCompareAttachments();
}

// -----------------------------
// MODELS CATALOG
// -----------------------------

function buildModelsById(payload) {
  const map = Object.create(null);
  const list = Array.isArray(payload?.models) ? payload.models : [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    if (typeof m.id !== "string" || !m.id) continue;
    map[m.id] = m;
  }
  return map;
}

function applyModelsPayload(payload) {
  modelsById = buildModelsById(payload);
  compareModelIds = Array.isArray(payload?.compareModelIds) ? payload.compareModelIds.slice() : [];
}

function computeVisibleOrderFromModelsPayload(payload) {
  if (Array.isArray(payload?.visibleModelIds)) {
    return payload.visibleModelIds.filter((id) => typeof id === "string");
  }

  const order = Array.isArray(payload?.modelOrder) ? payload.modelOrder : [];
  const enabled = new Set(Array.isArray(payload?.enabledModels) ? payload.enabledModels : []);
  const byId = buildModelsById(payload);

  // visible tabs = enabled models, in modelOrder
  const out = [];
  const seen = new Set();

  for (const id of order) {
    if (!byId[id]) continue;
    if (!enabled.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  // append any enabled models missing from order
  for (const id of Object.keys(byId)) {
    if (!enabled.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  return out;
}

// -----------------------------
// TABS + DOTS
// -----------------------------

function ensureState(model) {
  if (!modelStates[model]) {
    modelStates[model] = { initialized: false, loading: false, error: false };
  }
  return modelStates[model];
}

function stateToDotClass(state) {
  if (!state) return "";
  if (state.error) return "error";
  if (state.loading) return "loading";
  if (state.composerReady || state.manualOnly) return "ready";
  if (state.initialized) return "loaded";
  return "";
}

function getModelLabel(modelId) {
  const m = modelsById[modelId];
  if (m && typeof m.name === "string" && m.name.trim()) return m.name.trim();
  return modelId;
}

function isManualOnlyModel(modelId) {
  const m = modelsById[modelId];
  return !!m && !m.builtIn;
}

function renderTabs(order) {
  const tabsEl = document.getElementById("tabs");
  tabsEl.innerHTML = "";

  lastTabOrder = Array.isArray(order) ? order.slice() : [];

  for (const model of lastTabOrder) {
    const btn = document.createElement("button");
    btn.className = "tab-button";
    btn.dataset.model = model;

    const dot = document.createElement("span");
    dot.className = "status-dot";
    dot.dataset.model = model;

    const label = document.createElement("span");
    label.textContent = getModelLabel(model);

    btn.appendChild(dot);
    btn.appendChild(label);

    btn.addEventListener("click", () => {
      window.electronAPI.switchModel(model);
    });

    // drag reorder
    btn.draggable = true;

    btn.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", model);
      e.dataTransfer.effectAllowed = "move";
    });

    btn.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });

    btn.addEventListener("drop", (e) => {
      e.preventDefault();
      const fromModel = e.dataTransfer.getData("text/plain");
      const toModel = model;

      if (!fromModel || fromModel === toModel) return;

      const currentOrder = Array.from(tabsEl.querySelectorAll(".tab-button")).map(
        (b) => b.dataset.model
      );

      const fromIdx = currentOrder.indexOf(fromModel);
      const toIdx = currentOrder.indexOf(toModel);
      if (fromIdx < 0 || toIdx < 0) return;

      currentOrder.splice(fromIdx, 1);
      currentOrder.splice(toIdx, 0, fromModel);

      window.electronAPI.setModelOrder(currentOrder);
    });

    tabsEl.appendChild(btn);
  }

  renderCompareHeaders(compareModelIds);
  updateActiveTabUI(activeModel);
  updateAllDots();
}

function renderCompareHeaders(order) {
  const headersEl = document.getElementById("compare-pane-headers");
  if (!headersEl) return;

  const visibleOrder = Array.isArray(order) ? order.slice() : [];
  headersEl.innerHTML = "";

  if (!visibleOrder.length) {
    headersEl.style.gridTemplateColumns = "";
    return;
  }

  const headerWidth = headersEl.clientWidth;
  if (headerWidth > 0) {
    const widthPerPane = Math.floor(headerWidth / visibleOrder.length);
    let usedWidth = 0;
    const columnWidths = visibleOrder.map((_model, index) => {
      const isLast = index === visibleOrder.length - 1;
      const width = isLast ? Math.max(0, headerWidth - usedWidth) : widthPerPane;
      usedWidth += widthPerPane;
      return `${Math.max(0, width)}px`;
    });
    headersEl.style.gridTemplateColumns = columnWidths.join(" ");
  } else {
    headersEl.style.gridTemplateColumns = `repeat(${visibleOrder.length}, minmax(0, 1fr))`;
  }

  for (const model of visibleOrder) {
    const header = document.createElement("div");
    header.className = "compare-pane-header";
    header.dataset.model = model;

    const chip = document.createElement("div");
    chip.className = "compare-pane-chip";
    chip.dataset.model = model;

    const dot = document.createElement("span");
    dot.className = "status-dot";
    dot.dataset.model = model;

    const label = document.createElement("span");
    label.className = "compare-pane-label";
    label.textContent = getModelLabel(model);

    const manualBadge = document.createElement("span");
    manualBadge.className = "compare-pane-badge";
    manualBadge.textContent = "Manual";
    manualBadge.hidden = !isManualOnlyModel(model);

    const actions = document.createElement("div");
    actions.className = "compare-pane-actions";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "compare-pane-action";
    openButton.textContent = "↗";
    openButton.title = `Open ${getModelLabel(model)} in single view`;
    openButton.addEventListener("click", async () => {
      try {
        await window.electronAPI.setAppSettings({ layoutMode: "tabs" });
        window.electronAPI.switchModel(model);
      } catch (err) {
        console.warn("Multi-AI-Wrapper(renderer): compare pane open failed", err);
      }
    });

    const hideButton = document.createElement("button");
    hideButton.type = "button";
    hideButton.className = "compare-pane-action";
    hideButton.textContent = "x";
    hideButton.title = `Hide ${getModelLabel(model)} from compare view`;
    hideButton.disabled = visibleOrder.length <= 1;
    hideButton.addEventListener("click", async () => {
      try {
        const nextIds = compareModelIds.filter((id) => id !== model);
        if (!nextIds.length) return;
        await window.electronAPI.setCompareModels(nextIds);
      } catch (err) {
        console.warn("Multi-AI-Wrapper(renderer): compare pane hide failed", err);
      }
    });

    actions.appendChild(openButton);
    actions.appendChild(hideButton);
    chip.appendChild(dot);
    chip.appendChild(label);
    chip.appendChild(manualBadge);
    chip.appendChild(actions);
    header.appendChild(chip);
    headersEl.appendChild(header);
  }
}

function updateActiveTabUI(model) {
  const buttons = document.querySelectorAll(".tab-button");
  buttons.forEach((b) => {
    b.classList.toggle("active", b.dataset.model === model);
  });

  const compareButtons = document.querySelectorAll(".compare-pane-chip");
  compareButtons.forEach((b) => {
    b.classList.toggle("active", b.dataset.model === model);
  });
}

function updateDot(model) {
  const state = ensureState(model);
  const cls = stateToDotClass(state);

  for (const dot of document.querySelectorAll(`.status-dot[data-model="${model}"]`)) {
    dot.classList.remove("loading", "ready", "loaded", "error");
    if (cls) dot.classList.add(cls);
    const state = ensureState(model);
    dot.title = state.error
      ? "Load failed"
      : state.loading
        ? "Loading"
        : state.manualOnly
          ? "Manual-only pane"
          : state.composerReady
            ? "Composer ready"
            : state.initialized
              ? "Loaded; composer not detected yet"
              : "Not loaded";
  }
}

function updateAllDots() {
  for (const el of document.querySelectorAll(".status-dot")) {
    updateDot(el.dataset.model);
  }
}

function wireDotClicks() {
  document.addEventListener("click", (e) => {
    const dot =
      e.target && e.target.classList && e.target.classList.contains("status-dot")
        ? e.target
        : null;

    if (!dot) return;

    const model = dot.dataset.model;
    if (!model) return;

    const state = ensureState(model);

    // If loading: stop (optionally confirm)
    if (state.loading) {
      if (confirmBeforeStop) {
        const ok = window.confirm("Stop loading this model?");
        if (!ok) return;
      }

      window.electronAPI.stopModel(model);
      return;
    }

    // If error or ready (or even uninitialized): reload
    // Respect hardReloadOnRefresh setting for manual refresh actions
    window.electronAPI.refreshModel(model, !!hardReloadOnRefresh);
  });
}

function wireIPC() {
  window.electronAPI.onActiveModelChanged((modelName) => {
    activeModel = modelName;
    updateActiveTabUI(activeModel);
  });

  // This is the visible (enabled) order from main
  window.electronAPI.onModelOrderChanged((order) => {
    renderTabs(order);
  });

  window.electronAPI.onModelLoadStateChanged((payload) => {
    if (!payload || !payload.model) return;
    modelStates[payload.model] = {
      initialized: !!payload.initialized,
      loading: !!payload.loading,
      error: !!payload.error,
      composerReady: !!payload.composerReady,
      manualOnly: !!payload.manualOnly
    };
    updateDot(payload.model);
  });

  window.electronAPI.onAllModelLoadStates((states) => {
    if (states && typeof states === "object") {
      for (const [model, st] of Object.entries(states)) {
        modelStates[model] = {
          initialized: !!st.initialized,
          loading: !!st.loading,
          error: !!st.error,
          composerReady: !!st.composerReady,
          manualOnly: !!st.manualOnly
        };
      }
      updateAllDots();
    }
  });

  // Update labels when the catalog changes
  window.electronAPI.onAppModelsChanged((payload) => {
    applyModelsPayload(payload);

    // If we already have a visible order from main, re-render tabs to update labels
    if (lastTabOrder.length) {
      renderTabs(lastTabOrder);
      return;
    }

    // Fallback: derive a visible order from the models payload
    const visible = computeVisibleOrderFromModelsPayload(payload);
    if (visible.length) renderTabs(visible);
  });
}

// -----------------------------
// BOOTSTRAP
// -----------------------------

document.addEventListener("DOMContentLoaded", async () => {
  applyLayoutModeToDOM(layoutMode);

  // Load models first so labels are correct even before model-order-changed arrives.
  try {
    const payload = await window.electronAPI.getAppModels();
    applyModelsPayload(payload);

    const visible = computeVisibleOrderFromModelsPayload(payload);
    if (visible.length) renderTabs(visible);
  } catch {
    // last-resort fallback (should be rare)
    renderTabs(["chatgpt", "claude", "copilot", "gemini", "perplexity"]);
  }

  initAppSettings();

  wireIPC();
  wireDotClicks();

  initCompareModeButton();
  initCompareComposer();
  initCompareComposerSizing();
  initSetupOverlay();
  initThemeSync();
  initSettingsButton();

  window.addEventListener("resize", () => {
    if (layoutMode === "compare") {
      renderCompareHeaders(compareModelIds);
    }
  });
});
