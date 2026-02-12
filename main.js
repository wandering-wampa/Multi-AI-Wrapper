const {
  app,
  BrowserWindow,
  BrowserView,
  ipcMain,
  Menu,
  shell,
  session,
  nativeTheme,
  clipboard
} = require("electron");

const path = require("path");
const fs = require("fs");

let mainWindow;
let settingsWindow;

// Allow dev runs to isolate profile data (cookies/storage/settings) per project folder.
const PROFILE_OVERRIDE_DIR =
  !app.isPackaged &&
  typeof process.env.MAW_PROFILE_DIR === "string" &&
  process.env.MAW_PROFILE_DIR.trim()
    ? path.resolve(process.env.MAW_PROFILE_DIR.trim())
    : null;

if (PROFILE_OVERRIDE_DIR) {
  try {
    fs.mkdirSync(PROFILE_OVERRIDE_DIR, { recursive: true });
    app.setPath("userData", PROFILE_OVERRIDE_DIR);
  } catch (err) {
    console.warn("Multi-AI-Wrapper: failed to apply MAW_PROFILE_DIR override", err);
  }
}

// -----------------------------
// Models catalog seed (used only when no persisted catalog exists)
// -----------------------------

const BUILTIN_MODELS = [
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/", builtIn: true },
  { id: "claude", name: "Claude", url: "https://claude.ai/", builtIn: true },
  { id: "copilot", name: "Copilot", url: "https://copilot.microsoft.com/", builtIn: true },
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com/app", builtIn: true },
  { id: "perplexity", name: "Perplexity", url: "https://www.perplexity.ai/", builtIn: true }
];

const DEFAULT_MODEL_ORDER = BUILTIN_MODELS.map((m) => m.id);
const STORAGE_PATH = path.join(app.getPath("userData"), "settings.json");

// -----------------------------
// Persistence
// -----------------------------

function loadPersisted() {
  try {
    if (!fs.existsSync(STORAGE_PATH)) return {};
    return JSON.parse(fs.readFileSync(STORAGE_PATH, "utf-8")) || {};
  } catch (err) {
    console.warn("Multi-AI-Wrapper: failed to load persisted settings", err);
    return {};
  }
}

function savePersisted(obj) {
  try {
    const data = JSON.stringify(obj, null, 2);
    const tmp = `${STORAGE_PATH}.tmp`;
    fs.writeFileSync(tmp, data, "utf-8");
    try {
      fs.renameSync(tmp, STORAGE_PATH);
    } catch (err) {
      console.warn("Multi-AI-Wrapper: atomic rename failed, falling back to direct write", err);
      fs.writeFileSync(STORAGE_PATH, data, "utf-8");
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  } catch (err) {
    console.warn("Multi-AI-Wrapper: failed to save persisted settings", err);
  }
}

function isHttpsUrl(url) {
  return typeof url === "string" && /^https:\/\//i.test(url.trim());
}

function normalizeModelsCatalog(rawModels) {
  // IMPORTANT:
  // - If persisted.models does NOT exist yet, we seed with BUILTIN_MODELS.
  // - Once persisted.models exists, it becomes the source of truth (so deletions stick).
  if (rawModels === undefined || rawModels === null) {
    return BUILTIN_MODELS.map((m) => ({ ...m }));
  }

  const rawList = Array.isArray(rawModels)
    ? rawModels
    : rawModels && typeof rawModels === "object"
      ? Object.values(rawModels)
      : [];

  const out = [];
  const seen = new Set();

  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;

    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    if (seen.has(id)) continue;

    const name = typeof item.name === "string" ? item.name.trim() : "";
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!name || !isHttpsUrl(url)) continue;

    const builtIn = !!item.builtIn;
    seen.add(id);
    out.push({ id, name, url, builtIn });
  }

  // Ensure at least 1 model exists
  if (!out.length) {
    return BUILTIN_MODELS.map((m) => ({ ...m }));
  }

  return out;
}

function buildCatalogMap(models) {
  const map = Object.create(null);
  for (const m of Array.isArray(models) ? models : []) {
    if (!m || typeof m !== "object") continue;
    if (typeof m.id !== "string" || !m.id) continue;
    map[m.id] = m;
  }
  return map;
}

function normalizeModelOrder(rawOrder, models) {
  const catalog = buildCatalogMap(models);
  const input = Array.isArray(rawOrder) ? rawOrder : [];
  const seen = new Set();
  const out = [];

  for (const id of input) {
    if (typeof id !== "string") continue;
    if (!catalog[id]) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  // Append any missing catalog entries
  for (const m of models) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      out.push(m.id);
    }
  }

  // If still empty, fall back to whatever exists
  if (!out.length) {
    const first = models[0]?.id;
    return first ? [first] : DEFAULT_MODEL_ORDER.slice();
  }

  return out;
}

function normalizeEnabledModels(rawEnabled, models, modelOrder) {
  const catalog = buildCatalogMap(models);
  const order = Array.isArray(modelOrder) ? modelOrder : [];
  const input = Array.isArray(rawEnabled) ? rawEnabled : [];
  const seen = new Set();
  const out = [];

  for (const id of input) {
    if (typeof id !== "string") continue;
    if (!catalog[id]) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  if (out.length) return out;

  // Fallback: enable the first model in order (ensures at least one enabled)
  const first = order.find((id) => !!catalog[id]) || models[0]?.id;
  return first ? [first] : DEFAULT_MODEL_ORDER.slice();
}

// Back-compat note:
// Existing keys: modelOrder, activeModel, themeSource
// Existing keys we continue honoring: enabledModels, restoreLastActive, defaultModel, confirmBeforeStop, hardReloadOnRefresh
// New key added: models (catalog)
const persisted = loadPersisted();

// Models catalog (array of { id, name, url, builtIn? })
let MODELS = normalizeModelsCatalog(persisted.models);
let MODELS_BY_ID = buildCatalogMap(MODELS);

// Order + enabled should be normalized against the catalog.
let MODEL_ORDER = normalizeModelOrder(
  Array.isArray(persisted.modelOrder) && persisted.modelOrder.length ? persisted.modelOrder : DEFAULT_MODEL_ORDER,
  MODELS
);

let ENABLED_MODELS = normalizeEnabledModels(persisted.enabledModels, MODELS, MODEL_ORDER);

let RESTORE_LAST_ACTIVE_ON_LAUNCH =
  typeof persisted.restoreLastActive === "boolean" ? persisted.restoreLastActive : true;

let DEFAULT_MODEL =
  typeof persisted.defaultModel === "string" && MODELS_BY_ID[persisted.defaultModel]
    ? persisted.defaultModel
    : MODEL_ORDER[0] || MODELS[0]?.id || DEFAULT_MODEL_ORDER[0];

let CONFIRM_BEFORE_STOP =
  typeof persisted.confirmBeforeStop === "boolean" ? persisted.confirmBeforeStop : false;

let HARD_RELOAD_ON_REFRESH =
  typeof persisted.hardReloadOnRefresh === "boolean" ? persisted.hardReloadOnRefresh : false;

// Theme persistence: "system" | "light" | "dark"
let THEME_SOURCE = persisted.themeSource || "system";

function getEnabledSet() {
  return new Set(ENABLED_MODELS);
}

function getVisibleModelOrder() {
  const enabled = getEnabledSet();
  return MODEL_ORDER.filter((id) => enabled.has(id) && !!MODELS_BY_ID[id]);
}

function getModelsPayload() {
  return {
    models: MODELS.map((m) => ({ ...m })),
    modelOrder: MODEL_ORDER.slice(),
    enabledModels: ENABLED_MODELS.slice(),
    activeModel
  };
}

function broadcastModels() {
  const payload = getModelsPayload();

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send("app-models-changed", payload);
    } catch (err) {
      console.warn("Multi-AI-Wrapper: sending models to mainWindow failed", err);
    }
  }

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    try {
      settingsWindow.webContents.send("app-models-changed", payload);
    } catch (err) {
      console.warn("Multi-AI-Wrapper: sending models to settingsWindow failed", err);
    }
  }
}

function persistModelsState(partial) {
  savePersisted({
    ...loadPersisted(),
    ...partial
  });
}

function ensureActiveModelIsValid() {
  // Ensure we always have at least one enabled model that exists in the catalog.
  const enabledExisting = ENABLED_MODELS.filter((id) => !!MODELS_BY_ID[id]);
  if (!enabledExisting.length) {
    const first = MODEL_ORDER.find((id) => !!MODELS_BY_ID[id]) || MODELS[0]?.id;
    ENABLED_MODELS = first ? [first] : [];
    persistModelsState({ enabledModels: ENABLED_MODELS.slice() });
  } else if (enabledExisting.length !== ENABLED_MODELS.length) {
    ENABLED_MODELS = enabledExisting;
    persistModelsState({ enabledModels: ENABLED_MODELS.slice() });
  }

  // Ensure order only includes existing ids, and append missing.
  const normalizedOrder = normalizeModelOrder(MODEL_ORDER, MODELS);
  if (normalizedOrder.join("|") !== MODEL_ORDER.join("|")) {
    MODEL_ORDER = normalizedOrder;
    persistModelsState({ modelOrder: MODEL_ORDER.slice() });
  }

  const enabled = getEnabledSet();
  if (!enabled.has(activeModel) || !MODELS_BY_ID[activeModel]) {
    activeModel = getVisibleModelOrder()[0] || MODEL_ORDER[0] || MODELS[0]?.id || null;
  }
}

function computeInitialActiveModel() {
  const enabled = getEnabledSet();

  const candidate = RESTORE_LAST_ACTIVE_ON_LAUNCH ? persisted.activeModel : DEFAULT_MODEL;
  if (
    typeof candidate === "string" &&
    MODELS_BY_ID[candidate] &&
    enabled.has(candidate) &&
    MODEL_ORDER.includes(candidate)
  ) {
    return candidate;
  }

  const visible = getVisibleModelOrder();
  return visible[0] || MODEL_ORDER[0] || MODELS[0]?.id || null;
}

let activeModel = computeInitialActiveModel();

// -----------------------------
// App settings helpers (IPC)
// -----------------------------

function getAppSettingsPayload() {
  return {
    themeSource: THEME_SOURCE, // single source of truth
    enabledModels: ENABLED_MODELS.slice(),
    restoreLastActive: !!RESTORE_LAST_ACTIVE_ON_LAUNCH,
    defaultModel: DEFAULT_MODEL,
    confirmBeforeStop: !!CONFIRM_BEFORE_STOP,
    hardReloadOnRefresh: !!HARD_RELOAD_ON_REFRESH
  };
}

function broadcastAppSettings() {
  const payload = getAppSettingsPayload();

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send("app-settings-changed", payload);
    } catch (err) {
      console.warn("Multi-AI-Wrapper: sending app-settings to mainWindow failed", err);
    }
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    try {
      settingsWindow.webContents.send("app-settings-changed", payload);
    } catch (err) {
      console.warn("Multi-AI-Wrapper: sending app-settings to settingsWindow failed", err);
    }
  }
}

function persistAppSettings(partial) {
  savePersisted({
    ...loadPersisted(),
    ...partial
  });
}

function applySettingsPatch(patch) {
  if (!patch || typeof patch !== "object") return getAppSettingsPayload();

  const toPersist = {};

  if (typeof patch.themeSource === "string") {
    setThemeSource(patch.themeSource);
  }

  if (Array.isArray(patch.enabledModels)) {
    ENABLED_MODELS = normalizeEnabledModels(patch.enabledModels, MODELS, MODEL_ORDER);
    toPersist.enabledModels = ENABLED_MODELS.slice();

    ensureActiveModelIsValid();
    notifyModelOrder(getVisibleModelOrder());
    notifyActiveModel(activeModel);
    broadcastModels();
  }

  if (typeof patch.restoreLastActive === "boolean") {
    RESTORE_LAST_ACTIVE_ON_LAUNCH = patch.restoreLastActive;
    toPersist.restoreLastActive = RESTORE_LAST_ACTIVE_ON_LAUNCH;
  }

  if (typeof patch.defaultModel === "string" && MODELS_BY_ID[patch.defaultModel]) {
    DEFAULT_MODEL = patch.defaultModel;
    toPersist.defaultModel = DEFAULT_MODEL;
  }

  if (typeof patch.confirmBeforeStop === "boolean") {
    CONFIRM_BEFORE_STOP = patch.confirmBeforeStop;
    toPersist.confirmBeforeStop = CONFIRM_BEFORE_STOP;
  }

  if (typeof patch.hardReloadOnRefresh === "boolean") {
    HARD_RELOAD_ON_REFRESH = patch.hardReloadOnRefresh;
    toPersist.hardReloadOnRefresh = !!HARD_RELOAD_ON_REFRESH;
  }

  if (Object.keys(toPersist).length) {
    persistAppSettings(toPersist);
  }

  broadcastAppSettings();
  return getAppSettingsPayload();
}

// -----------------------------
// Views + state
// -----------------------------

const views = Object.create(null);
// Track which views have been added to the window (add-once policy)
const addedViews = new Set();

const modelLoadState = Object.create(null);

function ensureLoadState(modelName) {
  if (!modelLoadState[modelName]) {
    modelLoadState[modelName] = { initialized: false, loading: false, error: false };
  }
  return modelLoadState[modelName];
}

function notifyActiveModel(modelName) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("active-model-changed", modelName);
  } catch (err) {
    console.warn("Multi-AI-Wrapper: notifyActiveModel failed", err);
  }
}

function notifyModelOrder(order) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("model-order-changed", order);
  } catch (err) {
    console.warn("Multi-AI-Wrapper: notifyModelOrder failed", err);
  }
}

function notifyModelLoadState(modelName) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("model-load-state-changed", {
      model: modelName,
      ...modelLoadState[modelName]
    });
  } catch (err) {
    console.warn("Multi-AI-Wrapper: notifyModelLoadState failed", err);
  }
}

function notifyAllModelLoadStates() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("all-model-load-states", modelLoadState);
  } catch (err) {
    console.warn("Multi-AI-Wrapper: notifyAllModelLoadStates failed", err);
  }
}

function markLoading(modelName, loading) {
  const state = ensureLoadState(modelName);
  state.loading = !!loading;
  notifyModelLoadState(modelName);
}

function markInitialized(modelName, initialized) {
  const state = ensureLoadState(modelName);
  state.initialized = !!initialized;
  notifyModelLoadState(modelName);
}

function markError(modelName, error) {
  const state = ensureLoadState(modelName);
  state.error = !!error;
  notifyModelLoadState(modelName);
}

// -----------------------------
// Theme helpers
// -----------------------------

function syncNativeTheme() {
  nativeTheme.themeSource = THEME_SOURCE;
}

function getThemePayload() {
  const shouldUseDarkColors =
    THEME_SOURCE === "dark"
      ? true
      : THEME_SOURCE === "light"
        ? false
        : !!nativeTheme.shouldUseDarkColors;

  return {
    source: THEME_SOURCE,
    shouldUseDarkColors
  };
}

function broadcastTheme() {
  const payload = getThemePayload();

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send("theme-changed", payload);
    } catch (err) {
      console.warn("Multi-AI-Wrapper: sending theme to mainWindow failed", err);
    }
  }

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    try {
      settingsWindow.webContents.send("theme-changed", payload);
    } catch (err) {
      console.warn("Multi-AI-Wrapper: sending theme to settingsWindow failed", err);
    }
  }
}

function setThemeSource(source) {
  if (source !== "system" && source !== "light" && source !== "dark") return;
  THEME_SOURCE = source;

  savePersisted({
    ...loadPersisted(),
    themeSource: THEME_SOURCE
  });

  syncNativeTheme();
  broadcastAppSettings();
}

nativeTheme.on("updated", () => {
  broadcastTheme();
});

// -----------------------------
// BrowserView management
// -----------------------------

function createModelView(modelName) {
  const model = MODELS_BY_ID[modelName];
  const url = model?.url;
  if (!url) return null;

  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  views[modelName] = view;

  try {
    view.setAutoResize({ width: true, height: true });
  } catch (err) {
    console.warn("Multi-AI-Wrapper: setAutoResize failed", err);
  }

  const wc = view.webContents;

  // Attach the same context-menu handler to each model view's webContents
  try {
    wc.on("context-menu", (_event, params) => {
      try {
        const { editFlags = {}, isEditable, dictionarySuggestions = [] } = params || {};
        const template = [];

        if (isEditable && Array.isArray(dictionarySuggestions) && dictionarySuggestions.length) {
          for (const s of dictionarySuggestions.slice(0, 5)) {
            template.push({
              label: s,
              click: () => {
                try {
                  if (wc && typeof wc.replaceMisspelling === "function") wc.replaceMisspelling(s);
                } catch (err) {
                  console.warn("Multi-AI-Wrapper: replaceMisspelling failed", err);
                }
              }
            });
          }
          template.push({ type: "separator" });
        }

        const safeExecWc = (fnName, ...args) => {
          try {
            if (wc && typeof wc[fnName] === "function") return wc[fnName](...args);
          } catch (err) {
            console.warn(`Multi-AI-Wrapper: ${fnName} failed`, err);
          }
        };

        template.push({ label: "Cut", accelerator: "CmdOrCtrl+X", enabled: !!editFlags.canCut, click: () => safeExecWc("cut") });
        template.push({ label: "Copy", accelerator: "CmdOrCtrl+C", enabled: !!editFlags.canCopy, click: () => safeExecWc("copy") });
        template.push({ label: "Paste", accelerator: "CmdOrCtrl+V", enabled: !!editFlags.canPaste, click: () => safeExecWc("paste") });
        template.push({
          label: "Paste as plain text",
          accelerator: "CmdOrCtrl+Shift+V",
          enabled: !!editFlags.canPaste,
          click: () => {
            try {
              const text = clipboard.readText();
              if (text != null) safeExecWc("insertText", text);
            } catch (err) {
              console.warn("Multi-AI-Wrapper: paste-as-plain-text failed", err);
            }
          }
        });
        template.push({ label: "Select All", accelerator: "CmdOrCtrl+A", enabled: !!editFlags.canSelectAll, click: () => safeExecWc("selectAll") });

        const menu = Menu.buildFromTemplate(template);
        menu.popup({ window: mainWindow });
      } catch (err) {
        console.warn("Multi-AI-Wrapper: view context-menu handler failed", err);
      }
    });
  } catch (err) {
    console.warn("Multi-AI-Wrapper: attaching context-menu to view failed", err);
  }

  ensureLoadState(modelName);
  markLoading(modelName, true);
  markError(modelName, false);

  wc.on("did-start-loading", () => {
    markLoading(modelName, true);
    markError(modelName, false);
  });

  wc.on("did-stop-loading", () => {
    markLoading(modelName, false);
    markInitialized(modelName, true);
    markError(modelName, false);
    // Soft reflow on load: dispatch a resize to fix layout issues (preserve scroll)
    try {
      // More robust soft reflow: preserve scroll position and try to refocus the input
      const script = `(function(){
        try{
          const y = window.scrollY || document.documentElement.scrollTop || 0;
          const doResize = ()=>window.dispatchEvent(new Event('resize'));
          doResize();
          setTimeout(doResize, 50);
          setTimeout(()=>{
            try{ window.scrollTo(0, y); }catch(e){}
            try{
              const input = document.querySelector('textarea, input[type="text"], [contenteditable="true"]');
              if(input){
                try{ input.focus();
                  if(typeof input.selectionStart === 'number'){
                    input.selectionStart = input.selectionEnd = (input.value || '').length;
                  } else {
                    const r = document.createRange(); r.selectNodeContents(input); r.collapse(false);
                    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
                  }
                }catch(e){}
              }
            }catch(e){}
          }, 120);
        }catch(e){}
      })();`;

      wc.executeJavaScript(script, true).catch(() => {});
    } catch (err) {
      console.warn("Multi-AI-Wrapper: soft reflow on did-stop-loading failed", err);
    }
  });

  wc.on("did-fail-load", () => {
    markLoading(modelName, false);
    markError(modelName, true);
  });

  wc.setWindowOpenHandler(({ url: target }) => {
    try {
      shell.openExternal(target);
    } catch (err) {
      console.warn("Multi-AI-Wrapper: shell.openExternal failed", err);
    }
    return { action: "deny" };
  });

  wc.loadURL(url);

  return view;
}

const TOP_BAR_HEIGHT = 48;

function getActiveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const [width, height] = mainWindow.getContentSize();
  return {
    x: 0,
    y: TOP_BAR_HEIGHT,
    width,
    height: Math.max(0, height - TOP_BAR_HEIGHT)
  };
}

function layoutView(view, { forceRepaint = false } = {}) {
  if (!view) return;
  const bounds = getActiveBounds();
  if (!bounds) return;

  try {
    view.setBounds(bounds);
  } catch (err) {
    console.warn("Multi-AI-Wrapper: layoutView setBounds failed", err);
    return;
  }

  if (forceRepaint && process.platform === "win32") {
    setTimeout(() => {
      try {
        if (views[activeModel] === view && addedViews.has(view)) {
          view.setBounds(bounds);
        }
      } catch (err) {
        console.warn("Multi-AI-Wrapper: layoutView repaint setBounds failed", err);
      }
    }, 0);
  }
}

function layoutActiveView({ forceRepaint = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!activeModel) return;
  const view = views[activeModel];
  if (!view) return;
  if (!ensureViewAddedOnce(view)) return;
  layoutView(view, { forceRepaint });
}

function runSoftReflowOnWebContents(wc) {
  if (!wc) return;
  try {
    const script = `(function(){
      try{
        const y = window.scrollY || document.documentElement.scrollTop || 0;
        const doResize = ()=>window.dispatchEvent(new Event('resize'));
        doResize();
        setTimeout(doResize,50);
        setTimeout(()=>{
          try{ window.scrollTo(0,y); }catch(e){}
          try{ const input = document.querySelector('textarea, input[type="text"], [contenteditable="true"]'); if(input){ try{ input.focus(); if(typeof input.selectionStart === 'number'){ input.selectionStart = input.selectionEnd = (input.value||'').length; } else { const r=document.createRange(); r.selectNodeContents(input); r.collapse(false); const s=window.getSelection(); s.removeAllRanges(); s.addRange(r); } }catch(e){} } }catch(e){}
        },120);
      }catch(e){}
    })();`;

    const delays = [60, 200, 600];
    for (const d of delays) {
      setTimeout(() => {
        try {
          if (wc && !wc.isDestroyed()) wc.executeJavaScript(script, true).catch(() => {});
        } catch (err) {
          console.warn("Multi-AI-Wrapper: soft reflow execution failed", err);
        }
      }, d);
    }
  } catch (err) {
    console.warn("Multi-AI-Wrapper: scheduling soft reflow failed", err);
  }
}

function hideView(view) {
  try {
    // Prefer removing the view from the window so it cannot intercept clicks.
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.removeBrowserView(view);
        addedViews.delete(view);
        return;
      } catch (err) {
        // Fall through to bounds zeroing if removal fails
      }
    }

    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  } catch (err) {
    console.warn("Multi-AI-Wrapper: hideView failed", err);
  }
}

function showOnlyView(activeView) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Hide everything else (iterate a snapshot to avoid mutating the set during iteration)
  for (const v of Array.from(addedViews)) {
    if (v !== activeView) hideView(v);
  }

  // Show active
  try {
    layoutView(activeView, { forceRepaint: true });
  } catch (err) {
    console.warn("Multi-AI-Wrapper: showOnlyView failed", err);
  }
}

function ensureViewAddedOnce(view) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (!view) return false;

  if (addedViews.has(view)) return true;

  // Add ONLY once per view (prevents BrowserWindow 'closed' listener accumulation)
  try {
    mainWindow.addBrowserView(view);
    addedViews.add(view);
    return true;
  } catch (err) {
    console.warn("Multi-AI-Wrapper: ensureViewAddedOnce failed", err);
    return false;
  }
}

function showView(modelName) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const enabled = getEnabledSet();
  if (!MODELS_BY_ID[modelName]) return;
  if (!enabled.has(modelName)) return;
  if (!MODEL_ORDER.includes(modelName)) return;

  let view = views[modelName];
  if (!view) view = createModelView(modelName);
  if (!view) return;

  const prevActive = activeModel;
  activeModel = modelName;

  // Persist only when the active model actually changes (avoid writes on resize)
  if (prevActive !== activeModel) {
    savePersisted({
      ...loadPersisted(),
      activeModel
    });
  }

  if (!ensureViewAddedOnce(view)) return;
  showOnlyView(view);

  // Soft reflow shortly after showing the view to correct off-center layouts (preserve scroll)
  try {
    const wcShown = view.webContents;
    setTimeout(() => {
      try {
        if (wcShown && !wcShown.isDestroyed()) {
          const script = `(function(){
            try{
              const y = window.scrollY || document.documentElement.scrollTop || 0;
              const doResize = ()=>window.dispatchEvent(new Event('resize'));
              doResize();
              setTimeout(doResize,50);
              setTimeout(()=>{ try{ window.scrollTo(0,y); }catch(e){}; try{ const input = document.querySelector('textarea, input[type="text"], [contenteditable="true"]'); if(input){ try{ input.focus(); if(typeof input.selectionStart === 'number'){ input.selectionStart = input.selectionEnd = (input.value||'').length; } else { const r=document.createRange(); r.selectNodeContents(input); r.collapse(false); const s=window.getSelection(); s.removeAllRanges(); s.addRange(r); } }catch(e){} } }catch(e){} },120);
            }catch(e){}
          })();`;
          wcShown.executeJavaScript(script, true).catch(() => {});
        }
      } catch (err) {
        console.warn("Multi-AI-Wrapper: soft reflow after showView failed", err);
      }
    }, 120);
  } catch (err) {
    console.warn("Multi-AI-Wrapper: scheduling soft reflow failed", err);
  }

  notifyActiveModel(activeModel);
}

function refreshModel(modelName, hard = false) {
  const view = views[modelName];
  if (!view) {
    if (modelName === activeModel) showView(modelName);
    return;
  }

  const wc = view.webContents;
  if (!wc || wc.isDestroyed()) return;

  try {
    markError(modelName, false);
    markLoading(modelName, true);
    if (hard) wc.reloadIgnoringCache();
    else wc.reload();
  } catch (err) {
    console.warn("Multi-AI-Wrapper: refreshModel failed", err);
    markLoading(modelName, false);
    markError(modelName, true);
  }
}

function stopModel(modelName) {
  const view = views[modelName];
  if (!view) return;

  const wc = view.webContents;
  if (!wc || wc.isDestroyed()) return;

  try {
    wc.stop();
  } catch (err) {
    console.warn("Multi-AI-Wrapper: stopModel failed", err);
  }
}

// -----------------------------
// Settings window (covers app only)
// -----------------------------

function syncSettingsBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!settingsWindow || settingsWindow.isDestroyed()) return;

  const b = mainWindow.getBounds();
  try {
    settingsWindow.setBounds(b, false);
  } catch (err) {
    console.warn("Multi-AI-Wrapper: syncSettingsBounds failed", err);
  }
}

function createSettingsWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;

  const b = mainWindow.getBounds();

  settingsWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    parent: mainWindow,
    modal: true,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: "#0b0b0b",
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.loadFile(path.join(__dirname, "settings.html"));

  settingsWindow.once("ready-to-show", () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    syncSettingsBounds();
    settingsWindow.show();
    try {
      settingsWindow.focus();
    } catch (err) {
      console.warn("Multi-AI-Wrapper: settingsWindow.focus failed", err);
    }
    try {
      settingsWindow.webContents.send("theme-changed", getThemePayload());
    } catch (err) {
      console.warn("Multi-AI-Wrapper: sending theme to settingsWindow failed", err);
    }
    try {
      settingsWindow.webContents.send("app-settings-changed", getAppSettingsPayload());
    } catch (err) {
      console.warn("Multi-AI-Wrapper: sending app-settings to settingsWindow failed", err);
    }
    try {
      settingsWindow.webContents.send("app-models-changed", getModelsPayload());
    } catch (err) {
      console.warn("Multi-AI-Wrapper: sending models to settingsWindow failed", err);
    }
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });

  return settingsWindow;
}

function openSettingsWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (!settingsWindow || settingsWindow.isDestroyed()) {
    createSettingsWindow();
  } else {
    syncSettingsBounds();
    settingsWindow.show();
    try {
      settingsWindow.focus();
    } catch (err) {
      console.warn("Multi-AI-Wrapper: settingsWindow.focus failed", err);
    }
  }
}

function closeSettingsWindow() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  try {
    settingsWindow.close();
  } catch (err) {
    console.warn("Multi-AI-Wrapper: closeSettingsWindow failed", err);
  }
}

// -----------------------------
// Models: IPC (Settings UI)
// -----------------------------

ipcMain.handle("appModels:get", () => getModelsPayload());

ipcMain.handle("appModels:add", (_event, payload) => {
  const name = typeof payload?.name === "string" ? payload.name.trim() : "";
  const url = typeof payload?.url === "string" ? payload.url.trim() : "";

  if (!name) return { ok: false, error: "Model name is required." };
  if (!isHttpsUrl(url)) return { ok: false, error: "Model URL must start with https://." };

  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 32) || "custom";

  let id = `custom-${base}-${Date.now()}`;
  while (MODELS_BY_ID[id]) id = `custom-${base}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const model = { id, name, url, builtIn: false };

  MODELS = [...MODELS, model];
  MODELS_BY_ID = buildCatalogMap(MODELS);

  MODEL_ORDER = normalizeModelOrder([...MODEL_ORDER, id], MODELS);
  if (!ENABLED_MODELS.includes(id)) {
    ENABLED_MODELS = [...ENABLED_MODELS, id];
  }
  ENABLED_MODELS = normalizeEnabledModels(ENABLED_MODELS, MODELS, MODEL_ORDER);

  persistModelsState({
    models: MODELS.map((m) => ({ ...m })),
    modelOrder: MODEL_ORDER.slice(),
    enabledModels: ENABLED_MODELS.slice()
  });

  ensureActiveModelIsValid();

  notifyModelOrder(getVisibleModelOrder());
  notifyActiveModel(activeModel);
  broadcastAppSettings();
  broadcastModels();

  return { ok: true, payload: getModelsPayload() };
});

function destroyModelView(modelId) {
  const view = views[modelId];
  if (!view) return;

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      if (addedViews.has(view)) {
        mainWindow.removeBrowserView(view);
      }
    } catch (err) {
      console.warn("Multi-AI-Wrapper: removeBrowserView failed", err);
    }
  }

  try {
    if (view.webContents && !view.webContents.isDestroyed()) {
      view.webContents.destroy();
    }
  } catch (err) {
    console.warn("Multi-AI-Wrapper: destroying view.webContents failed", err);
  }

  addedViews.delete(view);
  delete views[modelId];
  delete modelLoadState[modelId];
}

ipcMain.handle("appModels:delete", (_event, payload) => {
  const id = typeof payload?.id === "string" ? payload.id : "";

  if (!id || !MODELS_BY_ID[id]) return { ok: false, error: "Unknown model id." };
  if (MODELS.length <= 1) return { ok: false, error: "You must keep at least one model." };

  MODELS = MODELS.filter((m) => m.id !== id);
  MODELS_BY_ID = buildCatalogMap(MODELS);

  MODEL_ORDER = MODEL_ORDER.filter((mid) => mid !== id);
  ENABLED_MODELS = ENABLED_MODELS.filter((mid) => mid !== id);

  destroyModelView(id);

  MODEL_ORDER = normalizeModelOrder(MODEL_ORDER, MODELS);
  ENABLED_MODELS = normalizeEnabledModels(ENABLED_MODELS, MODELS, MODEL_ORDER);

  if (activeModel === id) {
    activeModel = getVisibleModelOrder()[0] || MODEL_ORDER[0] || MODELS[0]?.id || null;
    persistModelsState({ activeModel });
  }

  persistModelsState({
    models: MODELS.map((m) => ({ ...m })),
    modelOrder: MODEL_ORDER.slice(),
    enabledModels: ENABLED_MODELS.slice(),
    activeModel
  });

  ensureActiveModelIsValid();

  try {
    if (mainWindow && !mainWindow.isDestroyed() && activeModel) {
      showView(activeModel);
    }
  } catch (err) {
    console.warn("Multi-AI-Wrapper: showView after delete failed", err);
  }

  notifyModelOrder(getVisibleModelOrder());
  notifyActiveModel(activeModel);
  broadcastAppSettings();
  broadcastModels();

  return { ok: true, payload: getModelsPayload() };
});

ipcMain.handle("appInfo:get", () => {
  return {
    appName: app.getName(),
    appVersion: app.getVersion(),
    electronVersion: process.versions?.electron || ""
  };
});

// settings window
ipcMain.handle("settings:open", () => {
  openSettingsWindow();
  return true;
});

ipcMain.on("settings:close", () => {
  closeSettingsWindow();
});

// -----------------------------
// IPC
// -----------------------------

ipcMain.on("switch-model", (_event, modelName) => {
  showView(modelName);
});

ipcMain.on("set-model-order", (_event, order) => {
  if (!Array.isArray(order)) return;

  const enabled = getEnabledSet();

  const requestedEnabled = [];
  const seen = new Set();

  for (const id of order) {
    if (typeof id !== "string") continue;
    if (!MODELS_BY_ID[id]) continue;
    if (!enabled.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    requestedEnabled.push(id);
  }

  for (const id of MODEL_ORDER) {
    if (!MODELS_BY_ID[id]) continue;
    if (!enabled.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    requestedEnabled.push(id);
  }

  const disabledInPrev = MODEL_ORDER.filter((id) => !!MODELS_BY_ID[id] && !enabled.has(id));
  MODEL_ORDER = requestedEnabled.concat(disabledInPrev);

  persistModelsState({ modelOrder: MODEL_ORDER.slice() });

  ensureActiveModelIsValid();

  notifyModelOrder(getVisibleModelOrder());
  notifyActiveModel(activeModel);
  broadcastModels();
});

ipcMain.on("refresh-active", (_event, payload) => {
  refreshModel(activeModel, !!payload?.hard);
});

ipcMain.on("refresh-model", (_event, payload) => {
  if (!payload || !payload.modelName) return;
  refreshModel(payload.modelName, !!payload.hard);
});

ipcMain.on("stop-model", (_event, payload) => {
  if (!payload || !payload.modelName) return;
  stopModel(payload.modelName);
});

// theme
ipcMain.handle("theme:get", () => getThemePayload());
ipcMain.handle("theme:set", (_event, source) => {
  setThemeSource(source);
  return getThemePayload();
});

// app settings (for the Settings UI)
ipcMain.handle("appSettings:get", () => getAppSettingsPayload());
ipcMain.handle("appSettings:set", (_event, patch) => applySettingsPatch(patch));

// -----------------------------
// Window + menu
// -----------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#111111",
    title: "Multi-AI Cockpit",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.on("move", syncSettingsBounds);
  mainWindow.on("resize", () => {
    syncSettingsBounds();

    // Layout the active view without altering state/persistence.
    try {
      layoutActiveView({ forceRepaint: true });
      const activeView = views[activeModel];
      if (activeView && addedViews.has(activeView)) runSoftReflowOnWebContents(activeView.webContents);
    } catch (err) {
      console.warn("Multi-AI-Wrapper: layoutActiveView on resize failed", err);
    }
  });
  
  // Also trigger reflow on maximize/unmaximize/fullscreen transitions
  mainWindow.on("maximize", () => {
    layoutActiveView({ forceRepaint: true });
    const activeView = views[activeModel];
    if (activeView && addedViews.has(activeView)) runSoftReflowOnWebContents(activeView.webContents);
  });
  mainWindow.on("unmaximize", () => {
    layoutActiveView({ forceRepaint: true });
    const activeView = views[activeModel];
    if (activeView && addedViews.has(activeView)) runSoftReflowOnWebContents(activeView.webContents);
  });
  mainWindow.on("enter-full-screen", () => {
    layoutActiveView({ forceRepaint: true });
    const activeView = views[activeModel];
    if (activeView && addedViews.has(activeView)) runSoftReflowOnWebContents(activeView.webContents);
  });
  mainWindow.on("leave-full-screen", () => {
    layoutActiveView({ forceRepaint: true });
    const activeView = views[activeModel];
    if (activeView && addedViews.has(activeView)) runSoftReflowOnWebContents(activeView.webContents);
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.webContents.on("did-finish-load", () => {
    try {
      notifyModelOrder(getVisibleModelOrder());
    } catch (err) {
      console.warn("Multi-AI-Wrapper: notifyModelOrder failed", err);
    }
    try {
      notifyActiveModel(activeModel);
    } catch (err) {
      console.warn("Multi-AI-Wrapper: notifyActiveModel failed", err);
    }
    try {
      notifyAllModelLoadStates();
    } catch (err) {
      console.warn("Multi-AI-Wrapper: notifyAllModelLoadStates failed", err);
    }
    try {
      broadcastTheme();
    } catch (err) {
      console.warn("Multi-AI-Wrapper: broadcastTheme failed", err);
    }
    try {
      broadcastAppSettings();
    } catch (err) {
      console.warn("Multi-AI-Wrapper: broadcastAppSettings failed", err);
    }
    try {
      broadcastModels();
    } catch (err) {
      console.warn("Multi-AI-Wrapper: broadcastModels failed", err);
    }
  });

  ensureActiveModelIsValid();
  if (activeModel) {
    showView(activeModel);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
    addedViews.clear();
  });

  // Restore a richer context menu in the requested order with plain-text paste
  mainWindow.webContents.on("context-menu", (_event, params) => {
    try {
      const { editFlags = {}, isEditable, dictionarySuggestions = [] } = params || {};
      const template = [];

      // 1) Spelling suggestions (if any)
      if (isEditable && Array.isArray(dictionarySuggestions) && dictionarySuggestions.length) {
        for (const s of dictionarySuggestions.slice(0, 5)) {
          template.push({
            label: s,
            click: () => {
              try {
                if (mainWindow && mainWindow.webContents && typeof mainWindow.webContents.replaceMisspelling === "function") {
                  mainWindow.webContents.replaceMisspelling(s);
                }
              } catch (err) {
                console.warn("Multi-AI-Wrapper: replaceMisspelling failed", err);
              }
            }
          });
        }
        template.push({ type: "separator" });
      }

      // Helper to safely call webContents methods only when available
      const safeExec = (fnName, ...args) => {
        try {
          if (mainWindow && mainWindow.webContents && typeof mainWindow.webContents[fnName] === "function") {
            return mainWindow.webContents[fnName](...args);
          }
        } catch (err) {
          console.warn(`Multi-AI-Wrapper: ${fnName} failed`, err);
        }
      };

      // 2) Cut
      template.push({
        label: "Cut",
        accelerator: "CmdOrCtrl+X",
        enabled: !!editFlags.canCut,
        click: () => safeExec("cut")
      });

      // 3) Copy
      template.push({
        label: "Copy",
        accelerator: "CmdOrCtrl+C",
        enabled: !!editFlags.canCopy,
        click: () => safeExec("copy")
      });

      // 4) Paste (regular)
      template.push({
        label: "Paste",
        accelerator: "CmdOrCtrl+V",
        enabled: !!editFlags.canPaste,
        click: () => safeExec("paste")
      });

      // 5) Paste as plain text (Ctrl+Shift+V / CmdOrCtrl+Shift+V)
      template.push({
        label: "Paste as plain text",
        accelerator: "CmdOrCtrl+Shift+V",
        enabled: !!editFlags.canPaste,
        click: () => {
          try {
            const text = clipboard.readText();
            if (text != null) safeExec("insertText", text);
          } catch (err) {
            console.warn("Multi-AI-Wrapper: paste-as-plain-text failed", err);
          }
        }
      });

      // 6) Select All
      template.push({
        label: "Select All",
        accelerator: "CmdOrCtrl+A",
        enabled: !!editFlags.canSelectAll,
        click: () => safeExec("selectAll")
      });

      const menu = Menu.buildFromTemplate(template);
      menu.popup({ window: mainWindow });
    } catch (err) {
      console.warn("Multi-AI-Wrapper: context-menu handler failed", err);
    }
  });

  const template = [
    {
      label: "App",
      submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "quit" }]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// -----------------------------
// App lifecycle
// -----------------------------

app.whenReady().then(() => {
  try {
    session.defaultSession.setSpellCheckerLanguages(["en-US"]);
  } catch (err) {
    console.warn("Multi-AI-Wrapper: setting spellchecker languages failed", err);
  }

  syncNativeTheme();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
