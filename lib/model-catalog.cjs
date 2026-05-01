const BUILTIN_MODELS = [
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/", builtIn: true },
  { id: "claude", name: "Claude", url: "https://claude.ai/", builtIn: true },
  { id: "copilot", name: "Copilot", url: "https://copilot.microsoft.com/", builtIn: true },
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com/app", builtIn: true },
  { id: "perplexity", name: "Perplexity", url: "https://www.perplexity.ai/", builtIn: true }
];

const DEFAULT_MODEL_ORDER = BUILTIN_MODELS.map((model) => model.id);

function cloneModel(model) {
  return {
    id: model.id,
    name: model.name,
    url: model.url,
    builtIn: !!model.builtIn
  };
}

function cloneModels(models) {
  return (Array.isArray(models) ? models : []).map(cloneModel);
}

function isHttpsUrl(url) {
  return typeof url === "string" && /^https:\/\//i.test(url.trim());
}

function normalizeModelsCatalog(rawModels) {
  // Missing persisted catalog means first-run defaults. An empty persisted catalog
  // falls back too, so the app always has at least one model.
  if (rawModels === undefined || rawModels === null) {
    return cloneModels(BUILTIN_MODELS);
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
    if (!id || seen.has(id)) continue;

    const name = typeof item.name === "string" ? item.name.trim() : "";
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!name || !isHttpsUrl(url)) continue;

    seen.add(id);
    out.push({ id, name, url, builtIn: !!item.builtIn });
  }

  return out.length ? out : cloneModels(BUILTIN_MODELS);
}

function buildCatalogMap(models) {
  const map = Object.create(null);
  for (const model of Array.isArray(models) ? models : []) {
    if (!model || typeof model !== "object") continue;
    if (typeof model.id !== "string" || !model.id) continue;
    map[model.id] = model;
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
    if (!catalog[id] || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  for (const model of Array.isArray(models) ? models : []) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model.id);
  }

  if (!out.length) {
    const first = models?.[0]?.id;
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
    if (!catalog[id] || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  if (out.length) return out;

  const first = order.find((id) => !!catalog[id]) || models?.[0]?.id;
  return first ? [first] : DEFAULT_MODEL_ORDER.slice();
}

function getVisibleModelOrder({ models, modelOrder, enabledModels }) {
  const catalog = buildCatalogMap(models);
  const enabled = new Set(Array.isArray(enabledModels) ? enabledModels : []);
  return (Array.isArray(modelOrder) ? modelOrder : []).filter((id) => enabled.has(id) && !!catalog[id]);
}

function getSettingsModelOrder({ models, modelOrder, enabledModels }) {
  const catalog = buildCatalogMap(models);
  const enabled = new Set(Array.isArray(enabledModels) ? enabledModels : []);
  const seen = new Set();
  const out = [];
  const order = Array.isArray(modelOrder) ? modelOrder : [];

  for (const id of order) {
    if (!catalog[id] || !enabled.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  for (const id of order) {
    if (!catalog[id] || enabled.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }

  for (const model of Array.isArray(models) ? models : []) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model.id);
  }

  return out;
}

function normalizeCompareSelectionIds(rawCompareIds, models, modelOrder) {
  const normalizedOrder = normalizeModelOrder(modelOrder, models);
  const requested = Array.isArray(rawCompareIds)
    ? new Set(rawCompareIds.filter((id) => typeof id === "string"))
    : null;

  if (!requested) return normalizedOrder.slice();

  const out = normalizedOrder.filter((id) => requested.has(id));
  return out.length ? out : normalizedOrder.slice(0, 1);
}

function getCompareVisibleModelOrder({ models, modelOrder, enabledModels, compareModelIds }) {
  const selected = normalizeCompareSelectionIds(compareModelIds, models, modelOrder);
  const enabled = new Set(normalizeEnabledModels(enabledModels, models, modelOrder));
  const visible = selected.filter((id) => enabled.has(id));

  if (visible.length) return visible;

  const enabledVisible = getVisibleModelOrder({ models, modelOrder, enabledModels });
  return enabledVisible.length ? enabledVisible.slice(0, 1) : [];
}

function selectDefaultModel({ persisted, modelsById, modelOrder, fallbackModels }) {
  const desired = persisted && typeof persisted.defaultModel === "string" ? persisted.defaultModel : "";
  if (desired && modelsById[desired]) return desired;
  return modelOrder[0] || fallbackModels[0]?.id || DEFAULT_MODEL_ORDER[0];
}

function selectActiveModel({
  persisted,
  restoreLastActive,
  defaultModel,
  modelsById,
  modelOrder,
  visibleModelOrder,
  fallbackModels
}) {
  const candidate = restoreLastActive ? persisted?.activeModel : defaultModel;
  if (
    typeof candidate === "string" &&
    modelsById[candidate] &&
    visibleModelOrder.includes(candidate) &&
    modelOrder.includes(candidate)
  ) {
    return candidate;
  }

  return visibleModelOrder[0] || modelOrder[0] || fallbackModels[0]?.id || null;
}

function deriveModelCatalogState(options = {}) {
  const persisted = options.persisted && typeof options.persisted === "object" ? options.persisted : {};
  const models = normalizeModelsCatalog(persisted.models);
  const modelsById = buildCatalogMap(models);
  const rawOrder = Array.isArray(persisted.modelOrder) && persisted.modelOrder.length
    ? persisted.modelOrder
    : DEFAULT_MODEL_ORDER;
  const modelOrder = normalizeModelOrder(rawOrder, models);
  const enabledModels = normalizeEnabledModels(persisted.enabledModels, models, modelOrder);
  const visibleModelOrder = getVisibleModelOrder({ models, modelOrder, enabledModels });
  const settingsModelOrder = getSettingsModelOrder({ models, modelOrder, enabledModels });
  const restoreLastActive =
    typeof persisted.restoreLastActive === "boolean" ? persisted.restoreLastActive : true;
  const defaultModel = selectDefaultModel({ persisted, modelsById, modelOrder, fallbackModels: models });
  const activeModel = selectActiveModel({
    persisted,
    restoreLastActive,
    defaultModel,
    modelsById,
    modelOrder,
    visibleModelOrder,
    fallbackModels: models
  });
  const initialCompareIds = Array.isArray(persisted.compareModelIds)
    ? normalizeCompareSelectionIds(persisted.compareModelIds, models, modelOrder)
    : visibleModelOrder;
  const compareSelectedModelIds = normalizeCompareSelectionIds(initialCompareIds, models, modelOrder);
  const compareModelIds = getCompareVisibleModelOrder({
    models,
    modelOrder,
    enabledModels,
    compareModelIds: compareSelectedModelIds
  });

  return {
    models: cloneModels(models),
    modelsById,
    modelOrder: modelOrder.slice(),
    enabledModels: enabledModels.slice(),
    visibleModelIds: visibleModelOrder.slice(),
    settingsModelIds: settingsModelOrder.slice(),
    defaultModel,
    activeModel,
    compareModelIds,
    compareSelectedModelIds,
    compareEligibleModelIds: visibleModelOrder.slice()
  };
}

module.exports = {
  BUILTIN_MODELS,
  DEFAULT_MODEL_ORDER,
  buildCatalogMap,
  deriveModelCatalogState,
  getCompareVisibleModelOrder,
  getSettingsModelOrder,
  getVisibleModelOrder,
  isHttpsUrl,
  normalizeCompareSelectionIds,
  normalizeEnabledModels,
  normalizeModelOrder,
  normalizeModelsCatalog
};
