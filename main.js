const {
  app,
  BrowserWindow,
  BrowserView,
  ipcMain,
  Menu,
  shell,
  session,
  nativeTheme
} = require("electron");

const path = require("path");
const fs = require("fs");

let mainWindow;
let settingsWindow;

// Map of model -> URL
const MODEL_URLS = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/",
  copilot: "https://copilot.microsoft.com/",
  gemini: "https://gemini.google.com/app",
  perplexity: "https://www.perplexity.ai/"
};

const DEFAULT_MODEL_ORDER = ["chatgpt", "claude", "copilot", "gemini", "perplexity"];
const STORAGE_PATH = path.join(app.getPath("userData"), "settings.json");

// -----------------------------
// Persistence
// -----------------------------

function loadPersisted() {
  try {
    if (!fs.existsSync(STORAGE_PATH)) return {};
    return JSON.parse(fs.readFileSync(STORAGE_PATH, "utf-8")) || {};
  } catch {
    return {};
  }
}

function savePersisted(obj) {
  try {
    fs.writeFileSync(STORAGE_PATH, JSON.stringify(obj, null, 2), "utf-8");
  } catch {}
}

function normalizeEnabledModels(list) {
  const arr = Array.isArray(list) ? list : [];
  const seen = new Set();
  const out = [];
  for (const m of arr) {
    if (!DEFAULT_MODEL_ORDER.includes(m)) continue;
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out.length ? out : DEFAULT_MODEL_ORDER.slice();
}

function isValidModelName(m) {
  return typeof m === "string" && DEFAULT_MODEL_ORDER.includes(m);
}

// Back-compat note:
// Existing keys: modelOrder, activeModel, themeSource
// New keys added: enabledModels, restoreLastActive, defaultModel, confirmBeforeStop, hardReloadOnRefresh
const persisted = loadPersisted();

let MODEL_ORDER =
  Array.isArray(persisted.modelOrder) && persisted.modelOrder.length
    ? persisted.modelOrder.filter((m) => DEFAULT_MODEL_ORDER.includes(m))
    : DEFAULT_MODEL_ORDER.slice();

if (MODEL_ORDER.length !== DEFAULT_MODEL_ORDER.length) {
  for (const m of DEFAULT_MODEL_ORDER) {
    if (!MODEL_ORDER.includes(m)) MODEL_ORDER.push(m);
  }
}

let ENABLED_MODELS = normalizeEnabledModels(persisted.enabledModels);

let RESTORE_LAST_ACTIVE_ON_LAUNCH =
  typeof persisted.restoreLastActive === "boolean" ? persisted.restoreLastActive : true;

let DEFAULT_MODEL =
  isValidModelName(persisted.defaultModel) ? persisted.defaultModel : DEFAULT_MODEL_ORDER[0];

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
  return MODEL_ORDER.filter((m) => enabled.has(m));
}

function ensureActiveModelIsValid() {
  const visible = getVisibleModelOrder();
  if (!visible.length) {
    // should not happen due to normalizeEnabledModels fallback, but guard anyway
    ENABLED_MODELS = DEFAULT_MODEL_ORDER.slice();
  }
  const enabled = getEnabledSet();
  if (!enabled.has(activeModel) || !MODEL_ORDER.includes(activeModel)) {
    activeModel = getVisibleModelOrder()[0] || MODEL_ORDER[0];
  }
}

function computeInitialActiveModel() {
  const enabled = getEnabledSet();

  const candidate = RESTORE_LAST_ACTIVE_ON_LAUNCH ? persisted.activeModel : DEFAULT_MODEL;
  if (isValidModelName(candidate) && enabled.has(candidate) && MODEL_ORDER.includes(candidate)) {
    return candidate;
  }

  const visible = getVisibleModelOrder();
  return visible[0] || MODEL_ORDER[0];
}

let activeModel = computeInitialActiveModel();

// -----------------------------
// App settings helpers (IPC)
// -----------------------------

function getAppSettingsPayload() {
  return {
    themeSource: THEME_SOURCE, // still single source of truth
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
    } catch {}
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    try {
      settingsWindow.webContents.send("app-settings-changed", payload);
    } catch {}
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

  // Theme stays handled via existing theme:set pathway (keeps toggle behavior + broadcasting)
  if (typeof patch.themeSource === "string") {
    setThemeSource(patch.themeSource);
    // setThemeSource already persists themeSource and broadcasts theme-changed
  }

  if (Array.isArray(patch.enabledModels)) {
    ENABLED_MODELS = normalizeEnabledModels(patch.enabledModels);
    toPersist.enabledModels = ENABLED_MODELS.slice();

    // If the active model becomes disabled, switch to first enabled
    ensureActiveModelIsValid();
    // Tabs should reflect enabled models
    notifyModelOrder(getVisibleModelOrder());
    notifyActiveModel(activeModel);
  }

  if (typeof patch.restoreLastActive === "boolean") {
    RESTORE_LAST_ACTIVE_ON_LAUNCH = patch.restoreLastActive;
    toPersist.restoreLastActive = RESTORE_LAST_ACTIVE_ON_LAUNCH;
  }

  if (typeof patch.defaultModel === "string" && isValidModelName(patch.defaultModel)) {
    DEFAULT_MODEL = patch.defaultModel;
    toPersist.defaultModel = DEFAULT_MODEL;
  }

  if (typeof patch.confirmBeforeStop === "boolean") {
    CONFIRM_BEFORE_STOP = patch.confirmBeforeStop;
    toPersist.confirmBeforeStop = CONFIRM_BEFORE_STOP;
  }

  if (typeof patch.hardReloadOnRefresh === "boolean") {
    HARD_RELOAD_ON_REFRESH = patch.hardReloadOnRefresh;
    toPersist.hardReloadOnRefresh = HARD_RELOAD_ON_REFRESH;
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

// { [model]: { initialized: boolean, loading: boolean, error: boolean } }
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
  } catch {}
}

function notifyModelOrder(order) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("model-order-changed", order);
  } catch {}
}

function notifyModelLoadState(modelName) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("model-load-state-changed", {
      model: modelName,
      ...modelLoadState[modelName]
    });
  } catch {}
}

function notifyAllModelLoadStates() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("all-model-load-states", modelLoadState);
  } catch {}
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
    } catch {}
  }

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    try {
      settingsWindow.webContents.send("theme-changed", payload);
    } catch {}
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
  broadcastTheme();
  broadcastAppSettings();
}

nativeTheme.on("updated", () => {
  if (THEME_SOURCE === "system") broadcastTheme();
});

// -----------------------------
// BrowserView management
// -----------------------------

function createModelView(modelName) {
  const url = MODEL_URLS[modelName];
  if (!url) return null;

  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  views[modelName] = view;

  const wc = view.webContents;

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
  });

  wc.on("did-fail-load", () => {
    markLoading(modelName, false);
    markError(modelName, true);
  });

  wc.setWindowOpenHandler(({ url: target }) => {
    try {
      shell.openExternal(target);
    } catch {}
    return { action: "deny" };
  });

  wc.loadURL(url);

  return view;
}

function resizeActiveView(viewOverride) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const view = viewOverride || mainWindow.getBrowserView();
  if (!view) return;

  const [winWidth, winHeight] = mainWindow.getSize();
  const topBarHeight = 48;

  view.setBounds({
    x: 0,
    y: topBarHeight,
    width: winWidth,
    height: Math.max(0, winHeight - topBarHeight)
  });

  view.setAutoResize({ width: true, height: true });
}

function showView(modelName) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const enabled = getEnabledSet();
  if (!enabled.has(modelName)) return;
  if (!MODEL_ORDER.includes(modelName)) return;

  let view = views[modelName];
  if (!view) view = createModelView(modelName);
  if (!view) return;

  activeModel = modelName;

  savePersisted({
    ...loadPersisted(),
    activeModel
  });

  mainWindow.setBrowserView(view);
  resizeActiveView(view);

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
  } catch {
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
  } catch {}
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
  } catch {}
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
    try { settingsWindow.focus(); } catch {}
    try { settingsWindow.webContents.send("theme-changed", getThemePayload()); } catch {}
    try { settingsWindow.webContents.send("app-settings-changed", getAppSettingsPayload()); } catch {}
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
    try { settingsWindow.focus(); } catch {}
  }
}

function closeSettingsWindow() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  try { settingsWindow.close(); } catch {}
}

// -----------------------------
// Main window
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

  // Keep Settings window aligned with the main window (added once to avoid listener leaks)
  mainWindow.on("move", syncSettingsBounds);
  mainWindow.on("resize", syncSettingsBounds);

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // Send initial UI state AFTER the renderer has loaded (prevents missing IPC messages)
  mainWindow.webContents.on("did-finish-load", () => {
    try { notifyModelOrder(getVisibleModelOrder()); } catch {}
    try { notifyActiveModel(activeModel); } catch {}
    try { notifyAllModelLoadStates(); } catch {}
    try { broadcastTheme(); } catch {}
    try { broadcastAppSettings(); } catch {}
  });

  // initial view
  ensureActiveModelIsValid();
  const initialView = createModelView(activeModel);
  if (initialView) {
    mainWindow.setBrowserView(initialView);
    resizeActiveView(initialView);
  }

  mainWindow.on("resize", () => resizeActiveView());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const template = [
    {
      label: "App",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "quit" }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// -----------------------------
// IPC
// -----------------------------

ipcMain.on("switch-model", (_event, modelName) => {
  showView(modelName);
});

ipcMain.on("set-model-order", (_event, order) => {
  if (!Array.isArray(order)) return;

  const enabled = getEnabledSet();
  const filtered = order.filter((m) => DEFAULT_MODEL_ORDER.includes(m));
  const requestedEnabled = filtered.filter((m) => enabled.has(m));

  for (const m of DEFAULT_MODEL_ORDER) {
    if (enabled.has(m) && !requestedEnabled.includes(m)) requestedEnabled.push(m);
  }

  const disabledInPrev = MODEL_ORDER.filter((m) => !enabled.has(m));
  MODEL_ORDER = requestedEnabled.concat(disabledInPrev);

  savePersisted({
    ...loadPersisted(),
    modelOrder: MODEL_ORDER
  });

  ensureActiveModelIsValid();

  notifyModelOrder(getVisibleModelOrder());
  notifyActiveModel(activeModel);
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
// App lifecycle
// -----------------------------

app.whenReady().then(() => {
  try {
    session.defaultSession.setSpellCheckerLanguages(["en-US"]);
  } catch {}

  syncNativeTheme();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
