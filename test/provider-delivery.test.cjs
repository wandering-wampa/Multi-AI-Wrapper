const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BROADCAST_SUPPORTED_MODEL_IDS,
  buildClickNewChatScript,
  buildClickSendButtonScript,
  buildFocusPromptTargetScript,
  buildInspectPromptStateScript,
  buildPreparePromptTargetScript,
  buildProbePromptTargetScript
} = require("../lib/provider-delivery.cjs");

test("lists built-in providers that support automated compare delivery", () => {
  assert.deepEqual(
    Array.from(BROADCAST_SUPPORTED_MODEL_IDS),
    ["chatgpt", "claude", "copilot", "gemini", "perplexity"]
  );
});

test("builds provider prompt delivery scripts", () => {
  const scripts = [
    buildPreparePromptTargetScript("chatgpt"),
    buildInspectPromptStateScript("claude", "hello"),
    buildClickSendButtonScript("copilot"),
    buildFocusPromptTargetScript("gemini"),
    buildProbePromptTargetScript("perplexity")
  ];

  for (const script of scripts) {
    assert.match(script, /findInputElement/);
    assert.match(script, /composer-not-found/);
  }
});

test("builds provider new-chat script", () => {
  const script = buildClickNewChatScript("chatgpt");

  assert.match(script, /New chat/);
  assert.match(script, /new-chat-not-found/);
});
