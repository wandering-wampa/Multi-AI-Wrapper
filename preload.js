const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  switchModel: (modelName) => ipcRenderer.send("switch-model", modelName),

  setModelOrder: (order) => ipcRenderer.send("set-model-order", order),

  // kept for compatibility (UI no longer needs it)
  refreshActive: (hard = false) => ipcRenderer.send("refresh-active", { hard: !!hard }),

  refreshModel: (modelName, hard = false) =>
    ipcRenderer.send("refresh-model", { modelName, hard: !!hard }),

  stopModel: (modelName) => ipcRenderer.send("stop-model", { modelName }),
  sendComparePrompt: (promptText) => ipcRenderer.invoke("compare:send-prompt", { promptText }),
  toggleCompareHistory: (anchorRect) => ipcRenderer.invoke("compareHistory:toggle", { anchorRect }),
  closeCompareHistory: () => ipcRenderer.send("compareHistory:close"),
  getComparePromptHistory: () => ipcRenderer.invoke("compareHistory:get"),
  selectComparePromptHistory: (promptText) =>
    ipcRenderer.invoke("compareHistory:select", { promptText }),
  removeComparePromptHistory: (promptText) =>
    ipcRenderer.invoke("compareHistory:remove", { promptText }),
  clearComparePromptHistory: () => ipcRenderer.invoke("compareHistory:clear"),

  // theme
  getTheme: () => ipcRenderer.invoke("theme:get"),
  setTheme: (source) => ipcRenderer.invoke("theme:set", source),
  onThemeChanged: (callback) => {
    ipcRenderer.on("theme-changed", (_event, payload) => callback(payload));
  },

  // app settings (Settings UI)
  getAppSettings: () => ipcRenderer.invoke("appSettings:get"),
  setAppSettings: (patch) => ipcRenderer.invoke("appSettings:set", patch),
  onAppSettingsChanged: (callback) => {
    ipcRenderer.on("app-settings-changed", (_event, payload) => callback(payload));
  },

  // models catalog (used by Settings UI + main renderer tabs)
  getAppModels: () => ipcRenderer.invoke("appModels:get"),
  setCompareModels: (modelIds) => ipcRenderer.invoke("compareModels:set", { modelIds }),
  addAppModel: (payload) => ipcRenderer.invoke("appModels:add", payload),
  deleteAppModel: (id) => ipcRenderer.invoke("appModels:delete", { id }),
  onAppModelsChanged: (callback) => {
    ipcRenderer.on("app-models-changed", (_event, payload) => callback(payload));
  },

  // about/info
  getAppInfo: () => ipcRenderer.invoke("appInfo:get"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", { url }),

  // settings window
  openSettings: () => ipcRenderer.invoke("settings:open"),
  closeSettings: () => ipcRenderer.send("settings:close"),

  // events
  onActiveModelChanged: (callback) => {
    ipcRenderer.on("active-model-changed", (_event, modelName) => callback(modelName));
  },

  onModelOrderChanged: (callback) => {
    ipcRenderer.on("model-order-changed", (_event, order) => callback(order));
  },

  onModelLoadStateChanged: (callback) => {
    ipcRenderer.on("model-load-state-changed", (_event, state) => callback(state));
  },

  onAllModelLoadStates: (callback) => {
    ipcRenderer.on("all-model-load-states", (_event, states) => callback(states));
  },

  onCompareHistorySelected: (callback) => {
    ipcRenderer.on("compare-history-selected", (_event, payload) => callback(payload));
  },

  onCompareHistoryVisibilityChanged: (callback) => {
    ipcRenderer.on("compare-history-visibility-changed", (_event, payload) => callback(payload));
  },

  onShortcutCommand: (callback) => {
    ipcRenderer.on("shortcut-command", (_event, payload) => callback(payload));
  }
});
