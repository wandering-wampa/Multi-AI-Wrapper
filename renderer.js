// renderer.js

const MODEL_LABELS = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  copilot: "Copilot",
  gemini: "Gemini",
  perplexity: "Perplexity"
};

let activeModel = null;

// load states keyed by model
// { [model]: { initialized: boolean, loading: boolean, error: boolean } }
const modelStates = Object.create(null);

// Behavior settings (defaults match main.js)
let confirmBeforeStop = false;
let hardReloadOnRefresh = false;

// -----------------------------
// APP SETTINGS (Behavior flags)
// -----------------------------

function applyAppSettingsToRenderer(settings) {
  if (!settings || typeof settings !== "object") return;

  if (typeof settings.confirmBeforeStop === "boolean") {
    confirmBeforeStop = settings.confirmBeforeStop;
  }
  if (typeof settings.hardReloadOnRefresh === "boolean") {
    hardReloadOnRefresh = settings.hardReloadOnRefresh;
  }
}

function initAppSettings() {
  // initial load
  window.electronAPI.getAppSettings()
    .then(applyAppSettingsToRenderer)
    .catch(() => {});

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

function initThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;

  // initial paint
  window.electronAPI.getTheme()
    .then(applyThemeToDOM)
    .catch(() => document.documentElement.setAttribute("data-theme", "dark"));

  btn.addEventListener("click", async () => {
    try {
      const current = await window.electronAPI.getTheme();

      // Toggle behavior:
      // - if currently system: flip opposite of effective OS theme to force override
      // - if currently light/dark: flip to the other
      let nextSource;
      if (current.source === "system") {
        nextSource = current.shouldUseDarkColors ? "light" : "dark";
      } else {
        nextSource = current.source === "dark" ? "light" : "dark";
      }

      const updated = await window.electronAPI.setTheme(nextSource);
      applyThemeToDOM(updated);
    } catch {}
  });

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
    } catch {}
  });
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

function renderTabs(order) {
  const tabsEl = document.getElementById("tabs");
  tabsEl.innerHTML = "";

  for (const model of order) {
    const btn = document.createElement("button");
    btn.className = "tab-button";
    btn.dataset.model = model;

    const dot = document.createElement("span");
    dot.className = "status-dot";
    dot.dataset.model = model;

    const label = document.createElement("span");
    label.textContent = MODEL_LABELS[model] || model;

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

  updateActiveTabUI(activeModel);
  updateAllDots();
}

function updateActiveTabUI(model) {
  const buttons = document.querySelectorAll(".tab-button");
  buttons.forEach((b) => {
    b.classList.toggle("active", b.dataset.model === model);
  });
}

function updateDot(model) {
  const dot = document.querySelector(`.status-dot[data-model="${model}"]`);
  if (!dot) return;

  const state = ensureState(model);

  dot.classList.remove("loading", "ready", "error");
  const cls = stateToDotClass(state);
  if (cls) dot.classList.add(cls);
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
}

// -----------------------------
// BOOTSTRAP
// -----------------------------

document.addEventListener("DOMContentLoaded", () => {
  renderTabs(["chatgpt", "claude", "copilot", "gemini", "perplexity"]);

  initAppSettings();

  wireIPC();
  wireDotClicks();

  initThemeToggle();
  initSettingsButton();
});
