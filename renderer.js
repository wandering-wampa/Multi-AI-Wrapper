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
let compareImageAttachments = [];

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

function buildCompareResultMessage(result) {
  if (!result) return "Shared send failed.";
  if (result.error === "empty-prompt") return "Enter a prompt or attach an image first.";

  const total = Number.isFinite(result.totalCount) ? result.totalCount : 0;
  const success = Number.isFinite(result.successCount) ? result.successCount : 0;
  const attachmentCount = Number.isFinite(result.attachmentCount) ? result.attachmentCount : 0;
  const hasPrompt = !!result.hasPrompt;
  const stagedOnly = attachmentCount > 0;
  const stagedLabel = hasPrompt ? "Prompt and images staged" : "Images staged";
  const sentLabel = attachmentCount > 0
    ? hasPrompt ? "Prompt sent and image paste attempted" : "Image paste attempted"
    : "Prompt sent";
  const failedLabel = attachmentCount > 0
    ? hasPrompt ? "Prompt/image send failed" : "Image send failed"
    : "Shared send failed";

  if (stagedOnly) {
    if (total > 0 && success === total) {
      return total === 1
        ? `${stagedLabel}. Submit manually in that pane.`
        : `${stagedLabel} in ${success}/${total} models. Submit manually in each pane.`;
    }

    if (total > 0) {
      return `${stagedLabel} in ${success}/${total} models. Submit manually where staged; check panes that did not accept it.`;
    }
  }

  if (result.ok) {
    return total === 1 ? `${sentLabel}.` : `${sentLabel} to ${success}/${total} models.`;
  }

  if (total > 0) {
    return `${sentLabel} to ${success}/${total} models. Check panes that were still loading, unsupported, or rejected images.`;
  }

  return failedLabel;
}

function initCompareComposer() {
  const input = document.getElementById("compare-prompt-input");
  const sendButton = document.getElementById("compare-send-button");
  const historyButton = document.getElementById("compare-history-button");
  const attachButton = document.getElementById("compare-attach-button");
  const attachmentsEl = document.getElementById("compare-attachments");
  if (!input || !sendButton || !historyButton || !attachButton || !attachmentsEl) return;

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
    const hasItems = compareImageAttachments.length > 0;
    attachmentsEl.classList.toggle("has-items", hasItems);
    attachButton.classList.toggle("has-items", hasItems);
    attachButton.title = hasItems ? `Attached images (${compareImageAttachments.length})` : "Attach images";
    attachButton.setAttribute(
      "aria-label",
      hasItems ? `Attached images (${compareImageAttachments.length})` : "Attach images"
    );

    if (!hasItems) return;

    for (const item of compareImageAttachments) {
      const chip = document.createElement("div");
      chip.className = "compare-attachment-chip";

      const name = document.createElement("span");
      name.className = "compare-attachment-name";
      name.textContent = item.name || "Image";
      name.title = item.name || "Image";

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
    compareImageAttachments = next
      .filter((item) => item && typeof item.path === "string" && item.path)
      .map((item) => ({
        path: item.path,
        name: typeof item.name === "string" && item.name ? item.name : item.path.split(/[\\/]/).pop() || "Image"
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
    const imagePaths = compareImageAttachments.map((item) => item.path).filter(Boolean);
    if (!promptText.trim() && imagePaths.length === 0) {
      setCompareStatus("Enter a prompt or attach an image first.");
      input.focus();
      return;
    }

    sendButton.disabled = true;
    attachButton.disabled = true;
    setCompareStatus("Sending...");

    try {
      const result = await window.electronAPI.sendComparePrompt({ promptText, imagePaths });
      setCompareStatus(buildCompareResultMessage(result));

      if (result?.ok) {
        input.value = "";
        setCompareAttachments([]);
      }
    } catch (err) {
      console.warn("Multi-AI-Wrapper(renderer): shared send failed", err);
      setCompareStatus("Shared send failed.");
    } finally {
      sendButton.disabled = false;
      attachButton.disabled = false;
      focusCompareInput();
      setTimeout(() => {
        focusCompareInput();
      }, 80);
    }
  };

  sendButton.addEventListener("click", () => {
    sendPrompt();
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

      const next = compareImageAttachments.slice();
      const seen = new Set(next.map((item) => item.path));
      for (const item of incoming) {
        if (!item?.path || seen.has(item.path)) continue;
        seen.add(item.path);
        next.push({
          path: item.path,
          name: item.name || item.path.split(/[\\/]/).pop() || "Image"
        });
      }

      setCompareAttachments(next);
      setCompareStatus(
        next.length === 1 ? "1 image attached." : `${next.length} images attached.`
      );
      focusCompareInput();
    } catch (err) {
      console.warn("Multi-AI-Wrapper(renderer): pickCompareImages failed", err);
      setCompareStatus("Image picker failed.");
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
    setCompareAttachments(compareImageAttachments.filter((item) => item.path !== path));
    setCompareStatus(compareImageAttachments.length ? "Attachment removed." : "");
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
  if (state.initialized) return "ready";
  return "";
}

function getModelLabel(modelId) {
  const m = modelsById[modelId];
  if (m && typeof m.name === "string" && m.name.trim()) return m.name.trim();
  return modelId;
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

    actions.appendChild(openButton);
    chip.appendChild(dot);
    chip.appendChild(actions);
    chip.appendChild(label);
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
    dot.classList.remove("loading", "ready", "error");
    if (cls) dot.classList.add(cls);
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
      error: !!payload.error
    };
    updateDot(payload.model);
  });

  window.electronAPI.onAllModelLoadStates((states) => {
    if (states && typeof states === "object") {
      for (const [model, st] of Object.entries(states)) {
        modelStates[model] = {
          initialized: !!st.initialized,
          loading: !!st.loading,
          error: !!st.error
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
  initThemeSync();
  initSettingsButton();

  window.addEventListener("resize", () => {
    if (layoutMode === "compare") {
      renderCompareHeaders(compareModelIds);
    }
  });
});
