const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BUILTIN_MODELS,
  deriveModelCatalogState
} = require("../lib/model-catalog.cjs");

test("seeds built-in models on first run", () => {
  const state = deriveModelCatalogState({ persisted: {} });

  assert.deepEqual(
    state.models.map((model) => model.id),
    ["chatgpt", "claude", "copilot", "gemini", "perplexity"]
  );
  assert.deepEqual(state.modelOrder, ["chatgpt", "claude", "copilot", "gemini", "perplexity"]);
  assert.deepEqual(state.enabledModels, ["chatgpt"]);
  assert.equal(state.defaultModel, "chatgpt");
  assert.equal(state.activeModel, "chatgpt");
  assert.deepEqual(state.compareModelIds, ["chatgpt"]);
});

test("derives catalog state from persisted custom models and stale preferences", () => {
  const models = [
    BUILTIN_MODELS[0],
    { id: "custom-local", name: "Local Model", url: "https://local.example/", builtIn: false },
    BUILTIN_MODELS[1]
  ];

  const state = deriveModelCatalogState({
    persisted: {
      models,
      modelOrder: ["missing", "custom-local", "custom-local", "chatgpt"],
      enabledModels: ["missing", "custom-local", "custom-local"],
      defaultModel: "missing",
      compareModelIds: ["claude", "missing", "custom-local"],
      activeModel: "missing",
      restoreLastActive: true
    }
  });

  assert.deepEqual(
    state.models.map((model) => model.id),
    ["chatgpt", "custom-local", "claude"]
  );
  assert.deepEqual(state.modelOrder, ["custom-local", "chatgpt", "claude"]);
  assert.deepEqual(state.enabledModels, ["custom-local"]);
  assert.equal(state.defaultModel, "custom-local");
  assert.equal(state.activeModel, "custom-local");
  assert.deepEqual(state.compareSelectedModelIds, ["custom-local", "claude"]);
  assert.deepEqual(state.compareModelIds, ["custom-local"]);
  assert.deepEqual(state.compareEligibleModelIds, ["custom-local"]);
});

test("keeps disabled compare selections but shows an enabled fallback pane", () => {
  const state = deriveModelCatalogState({
    persisted: {
      models: BUILTIN_MODELS.slice(0, 3),
      modelOrder: ["chatgpt", "claude", "copilot"],
      enabledModels: ["claude"],
      compareModelIds: ["chatgpt"]
    }
  });

  assert.deepEqual(state.compareSelectedModelIds, ["chatgpt"]);
  assert.deepEqual(state.compareModelIds, ["claude"]);
  assert.deepEqual(state.compareEligibleModelIds, ["claude"]);
  assert.deepEqual(state.visibleModelIds, ["claude"]);
  assert.deepEqual(state.settingsModelIds, ["claude", "chatgpt", "copilot"]);
});
