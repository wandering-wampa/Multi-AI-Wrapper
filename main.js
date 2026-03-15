const {
  app,
  BrowserWindow,
  BrowserView,
  ipcMain,
  Menu,
  dialog,
  shell,
  session,
  nativeTheme,
  nativeImage,
  clipboard,
  screen
} = require("electron");

const path = require("path");
const fs = require("fs");
const APP_DISPLAY_NAME = "Multi-AI-Wrapper";
const APP_ICON_PATH = path.join(__dirname, "assets", "Multi-Ai-logo.ico");
const GITHUB_REPO_URL = "https://github.com/wandering-wampa/Multi-AI-Wrapper";

let mainWindow;
let settingsWindow;
let compareHistoryWindow;
let lastCompareHistoryClosedAt = 0;

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
const COMPARE_PROMPT_HISTORY_LIMIT = 30;
const COMPARE_HISTORY_WINDOW_WIDTH = 396;
const COMPARE_HISTORY_WINDOW_HEIGHT = 420;
const COMPARE_HISTORY_WINDOW_GAP = 10;
const COMPARE_HISTORY_REOPEN_GUARD_MS = 250;
const COMPARE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

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

function normalizeComparePromptHistory(rawHistory) {
  const input = Array.isArray(rawHistory) ? rawHistory : [];
  const out = [];
  const seen = new Set();

  for (const item of input) {
    const promptText = typeof item === "string" ? item.trim() : "";
    if (!promptText) continue;
    if (seen.has(promptText)) continue;
    seen.add(promptText);
    out.push(promptText);
    if (out.length >= COMPARE_PROMPT_HISTORY_LIMIT) break;
  }

  return out;
}

function normalizeCompareImagePaths(rawPaths) {
  const input = Array.isArray(rawPaths) ? rawPaths : [];
  const out = [];
  const seen = new Set();

  for (const item of input) {
    const rawPath = typeof item === "string" ? item.trim() : "";
    if (!rawPath) continue;

    let resolvedPath;
    try {
      resolvedPath = path.resolve(rawPath);
    } catch (_) {
      continue;
    }

    if (seen.has(resolvedPath)) continue;

    let stats;
    try {
      stats = fs.statSync(resolvedPath);
    } catch (_) {
      continue;
    }
    if (!stats?.isFile?.()) continue;

    const ext = path.extname(resolvedPath).slice(1).toLowerCase();
    if (!COMPARE_IMAGE_EXTENSIONS.has(ext)) continue;

    seen.add(resolvedPath);
    out.push(resolvedPath);
  }

  return out;
}

function captureClipboardSnapshot() {
  try {
    return {
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
      image: clipboard.readImage()
    };
  } catch (_) {
    return null;
  }
}

function restoreClipboardSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;

  try {
    clipboard.clear();
    const data = {};
    if (typeof snapshot.text === "string" && snapshot.text) data.text = snapshot.text;
    if (typeof snapshot.html === "string" && snapshot.html) data.html = snapshot.html;
    if (typeof snapshot.rtf === "string" && snapshot.rtf) data.rtf = snapshot.rtf;
    if (snapshot.image && typeof snapshot.image.isEmpty === "function" && !snapshot.image.isEmpty()) {
      data.image = snapshot.image;
    }

    if (Object.keys(data).length) {
      clipboard.write(data);
    }
  } catch (_) {}
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
let ENABLE_KEYBOARD_SHORTCUTS =
  typeof persisted.enableKeyboardShortcuts === "boolean" ? persisted.enableKeyboardShortcuts : true;

let LAYOUT_MODE = "tabs";
let COMPARE_PROMPT_HISTORY = normalizeComparePromptHistory(persisted.comparePromptHistory);

// Theme persistence: "system" | "light" | "dark"
let THEME_SOURCE = persisted.themeSource || "system";

function getEnabledSet() {
  return new Set(ENABLED_MODELS);
}

function getVisibleModelOrder() {
  const enabled = getEnabledSet();
  return MODEL_ORDER.filter((id) => enabled.has(id) && !!MODELS_BY_ID[id]);
}

function normalizeCompareSelectionIds(rawCompareIds, models, modelOrder) {
  const normalizedOrder = normalizeModelOrder(modelOrder, models);
  const requested = Array.isArray(rawCompareIds)
    ? new Set(rawCompareIds.filter((id) => typeof id === "string"))
    : null;

  if (!requested) return normalizedOrder.slice();

  const out = normalizedOrder.filter((id) => requested.has(id));
  if (out.length) return out;

  return normalizedOrder.length ? [normalizedOrder[0]] : [];
}

let COMPARE_MODEL_IDS = Array.isArray(persisted.compareModelIds)
  ? normalizeCompareSelectionIds(persisted.compareModelIds, MODELS, MODEL_ORDER)
  : getVisibleModelOrder();

COMPARE_MODEL_IDS = normalizeCompareSelectionIds(COMPARE_MODEL_IDS, MODELS, MODEL_ORDER);

function getCompareVisibleModelOrder() {
  const selected = normalizeCompareSelectionIds(COMPARE_MODEL_IDS, MODELS, MODEL_ORDER);
  const enabled = new Set(normalizeEnabledModels(ENABLED_MODELS, MODELS, MODEL_ORDER));
  const visible = selected.filter((id) => enabled.has(id));

  if (visible.length) return visible;

  const enabledVisible = getVisibleModelOrder();
  return enabledVisible.length ? [enabledVisible[0]] : [];
}

function ensureCompareModelsAreValid() {
  const normalizedCompareIds = normalizeCompareSelectionIds(COMPARE_MODEL_IDS, MODELS, MODEL_ORDER);
  if (normalizedCompareIds.join("|") !== COMPARE_MODEL_IDS.join("|")) {
    COMPARE_MODEL_IDS = normalizedCompareIds;
    persistModelsState({ compareModelIds: COMPARE_MODEL_IDS.slice() });
  }
}

function getModelsPayload() {
  const compareVisibleModelOrder = getCompareVisibleModelOrder();
  const compareSelectedModelOrder = normalizeCompareSelectionIds(COMPARE_MODEL_IDS, MODELS, MODEL_ORDER);
  return {
    models: MODELS.map((m) => ({ ...m })),
    modelOrder: MODEL_ORDER.slice(),
    enabledModels: ENABLED_MODELS.slice(),
    compareModelIds: compareVisibleModelOrder,
    compareSelectedModelIds: compareSelectedModelOrder,
    compareEligibleModelIds: getVisibleModelOrder(),
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

function persistComparePromptHistory() {
  savePersisted({
    ...loadPersisted(),
    comparePromptHistory: COMPARE_PROMPT_HISTORY.slice()
  });
}

function getComparePromptHistoryPayload() {
  return {
    prompts: COMPARE_PROMPT_HISTORY.slice()
  };
}

function rememberComparePrompt(promptText) {
  const normalizedPrompt = typeof promptText === "string" ? promptText.trim() : "";
  if (!normalizedPrompt) return;

  COMPARE_PROMPT_HISTORY = normalizeComparePromptHistory([
    normalizedPrompt,
    ...COMPARE_PROMPT_HISTORY.filter((item) => item !== normalizedPrompt)
  ]);
  persistComparePromptHistory();
}

function removeComparePromptHistoryItem(promptText) {
  const normalizedPrompt = typeof promptText === "string" ? promptText.trim() : "";
  if (!normalizedPrompt) return getComparePromptHistoryPayload();

  COMPARE_PROMPT_HISTORY = COMPARE_PROMPT_HISTORY.filter((item) => item !== normalizedPrompt);
  persistComparePromptHistory();
  return getComparePromptHistoryPayload();
}

function clearComparePromptHistory() {
  COMPARE_PROMPT_HISTORY = [];
  persistComparePromptHistory();
  return getComparePromptHistoryPayload();
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

  ensureCompareModelsAreValid();
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
    layoutMode: LAYOUT_MODE,
    enabledModels: ENABLED_MODELS.slice(),
    restoreLastActive: !!RESTORE_LAST_ACTIVE_ON_LAUNCH,
    defaultModel: DEFAULT_MODEL,
    confirmBeforeStop: !!CONFIRM_BEFORE_STOP,
    hardReloadOnRefresh: !!HARD_RELOAD_ON_REFRESH,
    enableKeyboardShortcuts: !!ENABLE_KEYBOARD_SHORTCUTS
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
  let shouldRelayout = false;

  if (typeof patch.themeSource === "string") {
    setThemeSource(patch.themeSource);
  }

  if (typeof patch.layoutMode === "string") {
    const nextLayoutMode = patch.layoutMode === "compare" ? "compare" : "tabs";
    if (nextLayoutMode !== LAYOUT_MODE) {
      LAYOUT_MODE = nextLayoutMode;
      if (LAYOUT_MODE !== "compare") closeCompareHistoryWindow();
      shouldRelayout = true;
    }
  }

  if (Array.isArray(patch.enabledModels)) {
    ENABLED_MODELS = normalizeEnabledModels(patch.enabledModels, MODELS, MODEL_ORDER);
    toPersist.enabledModels = ENABLED_MODELS.slice();

    ensureActiveModelIsValid();
    shouldRelayout = true;
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

  if (typeof patch.enableKeyboardShortcuts === "boolean") {
    ENABLE_KEYBOARD_SHORTCUTS = !!patch.enableKeyboardShortcuts;
    toPersist.enableKeyboardShortcuts = ENABLE_KEYBOARD_SHORTCUTS;
  }

  if (Object.keys(toPersist).length) {
    persistAppSettings(toPersist);
  }

  if (shouldRelayout) {
    applyCurrentLayout({ forceRepaint: true });
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

function notifyCompareHistorySelected(promptText) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("compare-history-selected", { promptText });
  } catch (err) {
    console.warn("Multi-AI-Wrapper: notifyCompareHistorySelected failed", err);
  }
}

function notifyCompareHistoryVisibility(isOpen) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("compare-history-visibility-changed", { open: !!isOpen });
  } catch (err) {
    console.warn("Multi-AI-Wrapper: notifyCompareHistoryVisibility failed", err);
  }
}

function notifyShortcutCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("shortcut-command", { command });
  } catch (err) {
    console.warn("Multi-AI-Wrapper: notifyShortcutCommand failed", err);
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
  attachShortcutHandler(wc);

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
const COMPARE_COMPOSER_HEIGHT = 210;

function getContentBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const [width, height] = mainWindow.getContentSize();
  const composerHeight = LAYOUT_MODE === "compare" ? COMPARE_COMPOSER_HEIGHT : 0;
  return {
    x: 0,
    y: TOP_BAR_HEIGHT,
    width,
    height: Math.max(0, height - TOP_BAR_HEIGHT - composerHeight)
  };
}

function layoutView(view, { forceRepaint = false } = {}) {
  if (!view) return;
  const bounds = getContentBounds();
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

function setViewBounds(view, bounds, { forceRepaint = false } = {}) {
  if (!view || !bounds) return;

  try {
    view.setBounds(bounds);
  } catch (err) {
    console.warn("Multi-AI-Wrapper: setViewBounds failed", err);
    return;
  }

  if (forceRepaint && process.platform === "win32") {
    setTimeout(() => {
      try {
        if (view && addedViews.has(view)) {
          view.setBounds(bounds);
        }
      } catch (err) {
        console.warn("Multi-AI-Wrapper: setViewBounds repaint failed", err);
      }
    }, 0);
  }
}

function layoutCompareViews({ forceRepaint = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const visibleModelIds = getCompareVisibleModelOrder();
  const bounds = getContentBounds();
  if (!bounds || !visibleModelIds.length) return;

  const compareViews = [];
  for (const modelId of visibleModelIds) {
    let view = views[modelId];
    if (!view) view = createModelView(modelId);
    if (!view) continue;
    if (!ensureViewAddedOnce(view)) continue;
    compareViews.push({ modelId, view });
  }

  const compareSet = new Set(compareViews.map(({ view }) => view));
  for (const view of Array.from(addedViews)) {
    if (!compareSet.has(view)) hideView(view);
  }

  if (!compareViews.length) return;

  const widthPerView = Math.floor(bounds.width / compareViews.length);
  let currentX = bounds.x;

  compareViews.forEach(({ view }, index) => {
    const isLast = index === compareViews.length - 1;
    const nextWidth = isLast ? Math.max(0, bounds.x + bounds.width - currentX) : widthPerView;
    setViewBounds(
      view,
      {
        x: currentX,
        y: bounds.y,
        width: Math.max(0, nextWidth),
        height: bounds.height
      },
      { forceRepaint }
    );
    currentX += widthPerView;
  });
}

function applyCurrentLayout({ forceRepaint = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (LAYOUT_MODE === "compare") {
    layoutCompareViews({ forceRepaint });
    return;
  }

  if (activeModel) {
    showView(activeModel);
  }
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

  if (LAYOUT_MODE === "compare") {
    applyCurrentLayout({ forceRepaint: true });
    notifyActiveModel(activeModel);
    return;
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

const BROADCAST_SUPPORTED_MODEL_IDS = new Set(["chatgpt", "claude", "copilot", "gemini", "perplexity"]);

function buildProviderDomHelperPreamble(modelId) {
  const encodedModelId = JSON.stringify(modelId);
  return `
    const modelId = ${encodedModelId};
    const providerConfigs = {
      chatgpt: {
        inputSelectors: ["#prompt-textarea", "textarea", "[contenteditable='true'][role='textbox']", "[contenteditable='true']"],
        sendButtonSelectors: ["button[data-testid='send-button']", "button[aria-label*='Send']", "form button[type='submit']"]
      },
      claude: {
        inputSelectors: ["div[contenteditable='true'][role='textbox']", "div[contenteditable='true']", "textarea"],
        sendButtonSelectors: ["button[aria-label*='Send']", "button[title*='Send']", "form button[type='submit']"]
      },
      copilot: {
        inputSelectors: ["textarea", "div[contenteditable='true'][role='textbox']", "[role='textbox'][contenteditable='true']"],
        sendButtonSelectors: ["button[aria-label*='Send']", "button[title*='Send']", "form button[type='submit']"]
      },
      gemini: {
        inputSelectors: ["div.ql-editor[contenteditable='true']", "div[contenteditable='true'][role='textbox']", "textarea", "rich-textarea div[contenteditable='true']"],
        sendButtonSelectors: ["button[aria-label*='Send']", "button[mattooltip*='Send']", "form button[type='submit']"]
      },
      perplexity: {
        inputSelectors: ["textarea", "div[contenteditable='true'][role='textbox']", "[role='textbox'][contenteditable='true']"],
        sendButtonSelectors: ["button[aria-label*='Submit']", "button[aria-label*='Send']", "form button[type='submit']"]
      }
    };

    const config = providerConfigs[modelId] || {
      inputSelectors: ["textarea", "div[contenteditable='true'][role='textbox']", "[role='textbox'][contenteditable='true']", "[contenteditable='true']"],
      sendButtonSelectors: ["button[aria-label*='Send']", "button[type='submit']", "form button[type='submit']"]
    };

    function isVisible(el) {
      if (!el || !el.isConnected) return false;
      const style = window.getComputedStyle(el);
      if (!style || style.visibility === "hidden" || style.display === "none") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function uniqueElements(elements) {
      return Array.from(new Set(elements.filter(Boolean)));
    }

    function collectQueryMatches(selectors, root, visibleOnly) {
      const scope = root || document;
      const out = [];
      const visited = new Set();

      function visit(node) {
        if (!node || visited.has(node)) return;
        visited.add(node);

        for (const selector of selectors) {
          try {
            out.push(...Array.from(node.querySelectorAll(selector)));
          } catch (_) {}
        }

        let descendants = [];
        try {
          descendants = Array.from(node.querySelectorAll("*"));
        } catch (_) {}

        for (const el of descendants) {
          if (el && el.shadowRoot) {
            visit(el.shadowRoot);
          }
        }
      }

      visit(scope);
      return uniqueElements(out).filter((el) => (visibleOnly ? isVisible(el) : true));
    }

    function queryVisible(selectors, root) {
      return collectQueryMatches(selectors, root, true);
    }

    function pickBottomMost(elements) {
      return elements
        .slice()
        .sort((a, b) => {
          const aRect = a.getBoundingClientRect();
          const bRect = b.getBoundingClientRect();
          if (aRect.top !== bRect.top) return bRect.top - aRect.top;
          return bRect.left - aRect.left;
        })[0] || null;
    }

    function getTextValue(el) {
      if (!el) return "";
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        return typeof el.value === "string" ? el.value : "";
      }
      return typeof el.innerText === "string" ? el.innerText : (typeof el.textContent === "string" ? el.textContent : "");
    }

    function findInputElement() {
      const active = document.activeElement;
      if (active && isVisible(active)) {
        if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement || active.isContentEditable) {
          return active;
        }
      }

      const candidates = queryVisible(config.inputSelectors);
      if (candidates.length) return pickBottomMost(candidates);

      const fallback = queryVisible([
        "textarea:not([disabled])",
        "input[type='text']:not([disabled])",
        "[contenteditable='true']",
        "[role='textbox']"
      ]);
      return pickBottomMost(fallback);
    }

    function setNativeValue(el, value) {
      const prototype = Object.getPrototypeOf(el);
      const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor && typeof descriptor.set === "function") {
        descriptor.set.call(el, value);
      } else {
        el.value = value;
      }
    }

    function dispatchInputEvents(el, inputType, data) {
      try {
        el.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: inputType || "insertText",
          data: data == null ? null : data
        }));
      } catch (_) {}

      try {
        el.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType: inputType || "insertText",
          data: data == null ? null : data
        }));
      } catch (_) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }

      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function clearPromptValue(el) {
      el.focus();

      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        try { el.select(); } catch (_) {}
        setNativeValue(el, "");
        dispatchInputEvents(el, "deleteContentBackward", null);
        return true;
      }

      if (el.isContentEditable) {
        try {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand("delete", false);
        } catch (_) {
          el.textContent = "";
        }

        if (getTextValue(el).trim()) {
          el.textContent = "";
        }

        dispatchInputEvents(el, "deleteContentBackward", null);
        return true;
      }

      return false;
    }

    function isClickableButton(el) {
      if (!el || !isVisible(el)) return false;
      if (el.disabled) return false;
      if (el.getAttribute("aria-disabled") === "true") return false;
      return true;
    }

    function findSendButton(inputEl) {
      const form = inputEl?.closest?.("form");
      const formCandidates = form ? queryVisible(config.sendButtonSelectors, form) : [];
      if (formCandidates.length) {
        const button = pickBottomMost(formCandidates.filter(isClickableButton));
        if (button) return button;
      }

      const providerCandidates = queryVisible(config.sendButtonSelectors);
      if (providerCandidates.length) {
        const button = pickBottomMost(providerCandidates.filter(isClickableButton));
        if (button) return button;
      }

       function getButtonText(el) {
        if (!el) return "";
        return [
          el.getAttribute?.("aria-label") || "",
          el.getAttribute?.("title") || "",
          el.innerText || "",
          el.textContent || ""
        ]
          .join(" ")
          .trim()
          .toLowerCase();
      }

      function scoreButtonCandidate(el) {
        if (!isClickableButton(el)) return -1e9;
        if (inputEl && el === inputEl) return -1e9;

        const text = getButtonText(el);
        if (/(attach|upload|image|photo|file|plus|add|mic|voice|history|new chat|stop|cancel|close|settings)/i.test(text)) {
          return -1e6;
        }

        let score = 0;
        if (/(send|submit|ask|enter)/i.test(text)) score += 40;
        if (el.getAttribute?.("type") === "submit") score += 20;
        if (el.querySelector?.("svg")) score += 3;

        const rect = el.getBoundingClientRect();
        if (inputEl) {
          const inputRect = inputEl.getBoundingClientRect();
          score -= Math.abs(rect.top - inputRect.bottom) / 18;
          score -= Math.abs(rect.right - inputRect.right) / 14;
          if (rect.right >= inputRect.right - 32) score += 8;
          if (rect.top >= inputRect.top - 28) score += 6;
        }

        if (rect.width <= 96 && rect.height <= 72) score += 2;
        return score;
      }

      function pickBestButton(scope) {
        const candidates = queryVisible(["button", "[role='button']"], scope)
          .filter((el) => el !== inputEl);
        if (!candidates.length) return null;
        return candidates
          .slice()
          .sort((a, b) => scoreButtonCandidate(b) - scoreButtonCandidate(a))[0] || null;
      }

      let container = inputEl?.parentElement || null;
      for (let depth = 0; container && depth < 5; depth += 1) {
        const candidate = pickBestButton(container);
        if (candidate && scoreButtonCandidate(candidate) > -1000) {
          return candidate;
        }
        container = container.parentElement;
      }

      const fallbackButton = pickBestButton(document);
      if (fallbackButton && scoreButtonCandidate(fallbackButton) > -1000) {
        return fallbackButton;
      }

      return null;
    }

  `;
}

function buildPreparePromptTargetScript(modelId) {
  return `(function () {
    ${buildProviderDomHelperPreamble(modelId)}

    const inputEl = findInputElement();
    if (!inputEl) {
      return { ok: false, error: "composer-not-found" };
    }

    if (!clearPromptValue(inputEl)) {
      return { ok: false, error: "composer-clear-failed" };
    }

    inputEl.focus();
    return {
      ok: true,
      inputTag: inputEl.tagName,
      isContentEditable: !!inputEl.isContentEditable
    };
  })();`;
}

function buildInspectPromptStateScript(modelId, promptText) {
  const encodedModelId = JSON.stringify(modelId);
  const encodedPromptText = JSON.stringify(promptText);

  return `(function () {
    ${buildProviderDomHelperPreamble(modelId)}

    const promptText = ${encodedPromptText};

    const inputEl = findInputElement();
    if (!inputEl) {
      return { ok: false, error: "composer-not-found" };
    }

    const value = getTextValue(inputEl).trim();
    const expected = promptText.trim();
    return {
      ok: true,
      empty: value.length === 0,
      exactMatch: value === expected,
      includesPrompt: expected.length > 0 && value.includes(expected),
      valueLength: value.length
    };
  })();`;
}

function buildClickSendButtonScript(modelId) {
  return `(function () {
    ${buildProviderDomHelperPreamble(modelId)}

    const inputEl = findInputElement();
    if (!inputEl) {
      return { ok: false, error: "composer-not-found" };
    }

    const sendButton = findSendButton(inputEl);
    if (!sendButton) {
      return { ok: false, error: "send-button-not-found" };
    }

    inputEl.focus();
    sendButton.click();
    return { ok: true, method: "button" };
  })();`;
}

function buildFocusPromptTargetScript(modelId) {
  return `(function () {
    ${buildProviderDomHelperPreamble(modelId)}

    const inputEl = findInputElement();
    if (!inputEl) {
      return { ok: false, error: "composer-not-found" };
    }

    inputEl.focus();
    return { ok: true };
  })();`;
}

function safeWarn(...args) {
  try {
    const line = args
      .map((item) => {
        if (item instanceof Error) {
          return `${item.name}: ${item.message}`;
        }
        if (typeof item === "string") return item;
        try {
          return JSON.stringify(item);
        } catch (_) {
          return String(item);
        }
      })
      .join(" ");
    fs.appendFileSync(path.join(app.getPath("userData"), "maw-main.log"), `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch (_) {}
}

async function attachImagesToModel(modelId, imagePaths, view) {
  const normalizedPaths = normalizeCompareImagePaths(imagePaths);
  if (!normalizedPaths.length) {
    return { modelId, ok: true };
  }

  const targetView = view || views[modelId];
  const wc = targetView?.webContents;
  if (!wc || wc.isDestroyed()) {
    return { modelId, ok: false, error: "view-unavailable" };
  }

  try {
    for (const filePath of normalizedPaths) {
      const image = nativeImage.createFromPath(filePath);
      if (!image || image.isEmpty()) {
        return { modelId, ok: false, error: "invalid-image-file" };
      }

      const focused = await wc.executeJavaScript(
        buildFocusPromptTargetScript(modelId),
        true
      );

      if (!focused?.ok) {
        return { modelId, ok: false, error: focused?.error || "composer-not-found" };
      }

      try {
        wc.focus();
      } catch (_) {}

      clipboard.write({ image });
      await new Promise((resolve) => setTimeout(resolve, 50));
      wc.paste();
      await new Promise((resolve) => setTimeout(resolve, 360));
    }

    return {
      modelId,
      ok: true,
      attachedCount: normalizedPaths.length,
      method: "clipboard-paste"
    };
  } catch (err) {
    safeWarn(`Multi-AI-Wrapper: attachImagesToModel failed for ${modelId}`, err);
    return { modelId, ok: false, error: "file-attach-failed" };
  }
}

async function sendPromptToModel(modelId, promptText, imagePaths = []) {
  const trimmedPrompt = typeof promptText === "string" ? promptText.trim() : "";
  const normalizedImagePaths = normalizeCompareImagePaths(imagePaths);
  const shouldStageOnly = normalizedImagePaths.length > 0;

  if (!MODELS_BY_ID[modelId]) {
    return { modelId, ok: false, error: "unknown-model" };
  }

  if (!BROADCAST_SUPPORTED_MODEL_IDS.has(modelId) || !MODELS_BY_ID[modelId].builtIn) {
    return { modelId, ok: false, error: "unsupported-model" };
  }

  let view = views[modelId];
  if (!view) view = createModelView(modelId);
  if (!view) return { modelId, ok: false, error: "view-unavailable" };

  const state = ensureLoadState(modelId);
  if (!state.initialized || state.loading) {
    return { modelId, ok: false, error: "model-not-ready" };
  }

  try {
    try {
      view.webContents.focus();
    } catch (err) {
      safeWarn(`Multi-AI-Wrapper: focus failed for ${modelId}`, err);
    }

    const prepared = await view.webContents.executeJavaScript(
      buildPreparePromptTargetScript(modelId),
      true
    );

    if (!prepared || prepared.ok !== true) {
      return {
        modelId,
        ok: false,
        error: prepared?.error || "prepare-failed"
      };
    }

    if (normalizedImagePaths.length) {
      const attached = await attachImagesToModel(modelId, normalizedImagePaths, view);
      if (!attached?.ok) {
        return attached;
      }

      await new Promise((resolve) => setTimeout(resolve, 260));
    }

    let inspect = null;

    if (trimmedPrompt) {
      await view.webContents.insertText(trimmedPrompt);
      await new Promise((resolve) => setTimeout(resolve, 120));

      inspect = await view.webContents.executeJavaScript(
        buildInspectPromptStateScript(modelId, trimmedPrompt),
        true
      );
    }

    if (shouldStageOnly) {
      if (trimmedPrompt) {
        const staged = !!(inspect?.exactMatch || inspect?.includesPrompt);
        return {
          modelId,
          ok: staged,
          error: staged ? null : "staging-not-confirmed",
          method: "staged-with-images"
        };
      }

      return {
        modelId,
        ok: true,
        method: "staged-images-only"
      };
    }

    if (trimmedPrompt || normalizedImagePaths.length) {
      try {
        view.webContents.sendInputEvent({ type: "rawKeyDown", keyCode: "Enter" });
        view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      } catch (err) {
        safeWarn(`Multi-AI-Wrapper: sendInputEvent Enter failed for ${modelId}`, err);
      }

      if (trimmedPrompt || normalizedImagePaths.length) {
        try {
          view.webContents.sendInputEvent({ type: "rawKeyDown", keyCode: "Enter", modifiers: ["control"] });
          view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers: ["control"] });
          view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter", modifiers: ["control"] });
        } catch (err) {
          safeWarn(`Multi-AI-Wrapper: sendInputEvent Ctrl+Enter failed for ${modelId}`, err);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 180));
      if (trimmedPrompt) {
        inspect = await view.webContents.executeJavaScript(
          buildInspectPromptStateScript(modelId, trimmedPrompt),
          true
        );
      }
    }

    if (trimmedPrompt && inspect?.empty) {
      return {
        modelId,
        ok: true,
        method: normalizedImagePaths.length ? "native-enter-with-images" : "native-enter"
      };
    }

    if (!trimmedPrompt || normalizedImagePaths.length || inspect?.exactMatch || inspect?.includesPrompt) {
      const clicked = await view.webContents.executeJavaScript(
        buildClickSendButtonScript(modelId),
        true
      );

      if (clicked?.ok) {
        await new Promise((resolve) => setTimeout(resolve, normalizedImagePaths.length ? 360 : 220));
        if (!trimmedPrompt) {
          return {
            modelId,
            ok: true,
            method: "button-images-only"
          };
        }

        inspect = await view.webContents.executeJavaScript(
          buildInspectPromptStateScript(modelId, trimmedPrompt),
          true
        );

        if (normalizedImagePaths.length && inspect?.empty) {
          return {
            modelId,
            ok: true,
            method: "button-with-images"
          };
        }
      }
    }

    if (trimmedPrompt && inspect?.empty) {
      return {
        modelId,
        ok: true,
        method: normalizedImagePaths.length ? "button-with-images" : "button"
      };
    }

    return {
      modelId,
      ok: false,
      error: "submit-not-confirmed"
    };
  } catch (err) {
    safeWarn(`Multi-AI-Wrapper: sendPromptToModel failed for ${modelId}`, err);
    return { modelId, ok: false, error: "execute-javascript-failed" };
  }
}

async function sendPromptToVisibleModels(payload) {
  const promptText = typeof payload?.promptText === "string" ? payload.promptText : "";
  const trimmedPrompt = promptText.trim();
  const imagePaths = normalizeCompareImagePaths(payload?.imagePaths);

  if (!trimmedPrompt && !imagePaths.length) {
    return { ok: false, error: "empty-prompt", results: [] };
  }

  if (trimmedPrompt) {
    rememberComparePrompt(trimmedPrompt);
  }

  const visibleModelIds = getCompareVisibleModelOrder();
  const results = [];
  const clipboardSnapshot = imagePaths.length ? captureClipboardSnapshot() : null;

  try {
    for (const modelId of visibleModelIds) {
      results.push(await sendPromptToModel(modelId, trimmedPrompt, imagePaths));
    }
  } finally {
    if (clipboardSnapshot) {
      restoreClipboardSnapshot(clipboardSnapshot);
    }
  }

  const successCount = results.filter((item) => item.ok).length;
  return {
    ok: successCount === results.length && results.length > 0,
    successCount,
    totalCount: results.length,
    attachmentCount: imagePaths.length,
    hasPrompt: !!trimmedPrompt,
    results
  };
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
    icon: APP_ICON_PATH,
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

function sanitizeAnchorRect(anchorRect) {
  if (!anchorRect || typeof anchorRect !== "object") return null;

  const left = Number(anchorRect.left);
  const top = Number(anchorRect.top);
  const width = Number(anchorRect.width);
  const height = Number(anchorRect.height);

  if (![left, top, width, height].every(Number.isFinite)) return null;

  return {
    left,
    top,
    width: Math.max(0, width),
    height: Math.max(0, height),
    right: Number.isFinite(Number(anchorRect.right)) ? Number(anchorRect.right) : left + width,
    bottom: Number.isFinite(Number(anchorRect.bottom)) ? Number(anchorRect.bottom) : top + height
  };
}

function getCompareHistoryWindowBounds(anchorRect) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;

  const contentBounds = mainWindow.getContentBounds();
  const safeAnchor = sanitizeAnchorRect(anchorRect) || {
    left: contentBounds.width - 220,
    top: contentBounds.height - 140,
    width: 42,
    height: 42,
    right: contentBounds.width - 178,
    bottom: contentBounds.height - 98
  };

  const preferredX = Math.round(
    contentBounds.x + safeAnchor.right - COMPARE_HISTORY_WINDOW_WIDTH
  );
  const preferredY = Math.round(
    contentBounds.y + safeAnchor.top - COMPARE_HISTORY_WINDOW_HEIGHT - COMPARE_HISTORY_WINDOW_GAP
  );

  const display = screen.getDisplayMatching(contentBounds);
  const workArea = display?.workArea || contentBounds;

  const minX = workArea.x + 8;
  const maxX = workArea.x + workArea.width - COMPARE_HISTORY_WINDOW_WIDTH - 8;
  const minY = workArea.y + 8;
  const maxY = workArea.y + workArea.height - COMPARE_HISTORY_WINDOW_HEIGHT - 8;

  return {
    x: Math.min(Math.max(preferredX, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(preferredY, minY), Math.max(minY, maxY)),
    width: COMPARE_HISTORY_WINDOW_WIDTH,
    height: COMPARE_HISTORY_WINDOW_HEIGHT
  };
}

function closeCompareHistoryWindow() {
  if (!compareHistoryWindow || compareHistoryWindow.isDestroyed()) {
    compareHistoryWindow = null;
    lastCompareHistoryClosedAt = Date.now();
    notifyCompareHistoryVisibility(false);
    return;
  }

  try {
    compareHistoryWindow.close();
  } catch (err) {
    console.warn("Multi-AI-Wrapper: closeCompareHistoryWindow failed", err);
    compareHistoryWindow = null;
    lastCompareHistoryClosedAt = Date.now();
    notifyCompareHistoryVisibility(false);
  }
}

function openCompareHistoryWindow(anchorRect) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  if (compareHistoryWindow && !compareHistoryWindow.isDestroyed()) {
    closeCompareHistoryWindow();
    return false;
  }

  if (Date.now() - lastCompareHistoryClosedAt < COMPARE_HISTORY_REOPEN_GUARD_MS) {
    return false;
  }

  const bounds = getCompareHistoryWindowBounds(anchorRect);
  if (!bounds) return false;

  compareHistoryWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    parent: mainWindow,
    modal: false,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: "#121212",
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    movable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  compareHistoryWindow.loadFile(path.join(__dirname, "prompt-history.html"));

  compareHistoryWindow.once("ready-to-show", () => {
    if (!compareHistoryWindow || compareHistoryWindow.isDestroyed()) return;
    compareHistoryWindow.show();
    try {
      compareHistoryWindow.focus();
    } catch (err) {
      console.warn("Multi-AI-Wrapper: compareHistoryWindow.focus failed", err);
    }
    notifyCompareHistoryVisibility(true);
  });

  compareHistoryWindow.on("blur", () => {
    closeCompareHistoryWindow();
  });

  compareHistoryWindow.on("closed", () => {
    compareHistoryWindow = null;
    lastCompareHistoryClosedAt = Date.now();
    notifyCompareHistoryVisibility(false);
  });

  return true;
}

function getVisibleNavigationOrder() {
  const visible = getVisibleModelOrder();
  return visible.length ? visible : [];
}

function focusMainRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.focus();
    mainWindow.webContents.focus();
  } catch (err) {
    console.warn("Multi-AI-Wrapper: focusMainRenderer failed", err);
  }
}

function activateAdjacentModel(direction) {
  const visible = getVisibleNavigationOrder();
  if (!visible.length) return false;

  const currentIndex = visible.indexOf(activeModel);
  const startIndex = currentIndex >= 0 ? currentIndex : 0;
  const delta = direction < 0 ? -1 : 1;
  const nextIndex = (startIndex + delta + visible.length) % visible.length;
  const nextModelId = visible[nextIndex];
  if (!nextModelId) return false;

  showView(nextModelId);
  return true;
}

function handleShortcutInput(input) {
  if (!ENABLE_KEYBOARD_SHORTCUTS || !input) return false;

  const key = typeof input.key === "string" ? input.key.toLowerCase() : "";
  const control = !!input.control || !!input.meta;
  const shift = !!input.shift;
  const alt = !!input.alt;

  if (control && !shift && !alt && key === ",") {
    openSettingsWindow();
    return true;
  }

  if (control && !shift && !alt && key === "tab") {
    return activateAdjacentModel(1);
  }

  if (control && shift && !alt && key === "tab") {
    return activateAdjacentModel(-1);
  }

  if (control && !shift && !alt && key === "r") {
    refreshModel(activeModel, !!HARD_RELOAD_ON_REFRESH);
    return true;
  }

  if (!control && !shift && !alt && key === "escape") {
    const state = activeModel ? ensureLoadState(activeModel) : null;
    if (!state?.loading) return false;
    stopModel(activeModel);
    return true;
  }

  if (control && alt && !shift && key === "c") {
    applySettingsPatch({ layoutMode: LAYOUT_MODE === "compare" ? "tabs" : "compare" });
    return true;
  }

  if (control && alt && !shift && key === "l") {
    if (LAYOUT_MODE !== "compare") return false;
    focusMainRenderer();
    notifyShortcutCommand("focus-compare-composer");
    return true;
  }

  if (control && alt && !shift && key === "h") {
    if (LAYOUT_MODE !== "compare") return false;
    focusMainRenderer();
    notifyShortcutCommand("toggle-compare-history");
    return true;
  }

  return false;
}

function attachShortcutHandler(webContents) {
  if (!webContents || webContents.isDestroyed()) return;

  webContents.on("before-input-event", (event, input) => {
    if (input?.type !== "keyDown") return;
    if (!handleShortcutInput(input)) return;
    event.preventDefault();
  });
}

// -----------------------------
// Models: IPC (Settings UI)
// -----------------------------

ipcMain.handle("appModels:get", () => getModelsPayload());

ipcMain.handle("compareModels:set", (_event, payload) => {
  const requestedIds = Array.isArray(payload?.modelIds) ? payload.modelIds : [];
  const normalizedIds = normalizeCompareSelectionIds(requestedIds, MODELS, MODEL_ORDER);

  COMPARE_MODEL_IDS = normalizedIds;
  persistModelsState({ compareModelIds: COMPARE_MODEL_IDS.slice() });
  applyCurrentLayout({ forceRepaint: true });
  broadcastModels();

  return { ok: true, payload: getModelsPayload() };
});

ipcMain.handle("compare:pick-images", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: "window-unavailable", images: [] };
  }

  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select images for compare view",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Images", extensions: Array.from(COMPARE_IMAGE_EXTENSIONS) }
      ]
    });

    if (result.canceled) {
      return { ok: true, canceled: true, images: [] };
    }

    const imagePaths = normalizeCompareImagePaths(result.filePaths);
    return {
      ok: true,
      canceled: false,
      images: imagePaths.map((filePath) => ({
        path: filePath,
        name: path.basename(filePath)
      }))
    };
  } catch (err) {
    safeWarn("Multi-AI-Wrapper: compare image picker failed", err);
    return { ok: false, error: "picker-failed", images: [] };
  }
});

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
  applyCurrentLayout({ forceRepaint: true });

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
    applyCurrentLayout({ forceRepaint: true });
  } catch (err) {
    console.warn("Multi-AI-Wrapper: applyCurrentLayout after delete failed", err);
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
    electronVersion: process.versions?.electron || "",
    links: {
      repository: GITHUB_REPO_URL,
      readme: `${GITHUB_REPO_URL}#readme`,
      releases: `${GITHUB_REPO_URL}/releases`,
      issues: `${GITHUB_REPO_URL}/issues`
    }
  };
});

ipcMain.handle("shell:openExternal", async (_event, payload) => {
  const url = typeof payload?.url === "string" ? payload.url.trim() : "";
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "invalid-url" };

  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    console.warn("Multi-AI-Wrapper: shell.openExternal failed", err);
    return { ok: false, error: "open-failed" };
  }
});

// settings window
ipcMain.handle("settings:open", () => {
  openSettingsWindow();
  return true;
});

ipcMain.on("settings:close", () => {
  closeSettingsWindow();
});

// compare history popup
ipcMain.handle("compareHistory:toggle", (_event, payload) => {
  const open = openCompareHistoryWindow(payload?.anchorRect);
  return { open };
});

ipcMain.on("compareHistory:close", () => {
  closeCompareHistoryWindow();
});

ipcMain.handle("compareHistory:get", () => getComparePromptHistoryPayload());
ipcMain.handle("compareHistory:remove", (_event, payload) =>
  removeComparePromptHistoryItem(payload?.promptText)
);
ipcMain.handle("compareHistory:clear", () => clearComparePromptHistory());
ipcMain.handle("compareHistory:select", (_event, payload) => {
  const promptText = typeof payload?.promptText === "string" ? payload.promptText.trim() : "";
  if (!promptText) return { ok: false, error: "missing-prompt" };

  rememberComparePrompt(promptText);
  notifyCompareHistorySelected(promptText);
  closeCompareHistoryWindow();
  return { ok: true };
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
  applyCurrentLayout({ forceRepaint: true });

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

ipcMain.handle("compare:send-prompt", (_event, payload) => {
  return sendPromptToVisibleModels(payload).then((result) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
        mainWindow.webContents.focus();
        setTimeout(() => {
          try {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.focus();
            }
          } catch (err) {
            console.warn("Multi-AI-Wrapper: delayed webContents focus failed", err);
          }
        }, 60);
      }
    } catch (err) {
      console.warn("Multi-AI-Wrapper: focus after compare send failed", err);
    }
    return result;
  });
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
    title: APP_DISPLAY_NAME,
    icon: APP_ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenuBarVisibility(false);

  attachShortcutHandler(mainWindow.webContents);

  mainWindow.on("move", () => {
    syncSettingsBounds();
    closeCompareHistoryWindow();
  });
  mainWindow.on("resize", () => {
    syncSettingsBounds();
    closeCompareHistoryWindow();

    try {
      applyCurrentLayout({ forceRepaint: true });
      const viewIds = LAYOUT_MODE === "compare" ? getCompareVisibleModelOrder() : [activeModel];
      for (const modelId of viewIds) {
        const view = views[modelId];
        if (view && addedViews.has(view)) runSoftReflowOnWebContents(view.webContents);
      }
    } catch (err) {
      console.warn("Multi-AI-Wrapper: applyCurrentLayout on resize failed", err);
    }
  });
  
  // Also trigger reflow on maximize/unmaximize/fullscreen transitions
  const relayoutAndReflowVisibleViews = () => {
    closeCompareHistoryWindow();
    applyCurrentLayout({ forceRepaint: true });
    const viewIds = LAYOUT_MODE === "compare" ? getCompareVisibleModelOrder() : [activeModel];
    for (const modelId of viewIds) {
      const view = views[modelId];
      if (view && addedViews.has(view)) runSoftReflowOnWebContents(view.webContents);
    }
  };

  mainWindow.on("maximize", relayoutAndReflowVisibleViews);
  mainWindow.on("unmaximize", relayoutAndReflowVisibleViews);
  mainWindow.on("enter-full-screen", relayoutAndReflowVisibleViews);
  mainWindow.on("leave-full-screen", relayoutAndReflowVisibleViews);

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
  applyCurrentLayout({ forceRepaint: true });

  mainWindow.on("closed", () => {
    closeCompareHistoryWindow();
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
  if (process.platform === "win32") {
    app.setAppUserModelId("com.multi-ai-wrapper.app");
  }

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
