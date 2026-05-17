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

function buildProbePromptTargetScript(modelId) {
  return `(function () {
    ${buildProviderDomHelperPreamble(modelId)}

    const inputEl = findInputElement();
    if (!inputEl) {
      return { ok: false, error: "composer-not-found" };
    }

    return {
      ok: true,
      inputTag: inputEl.tagName,
      isContentEditable: !!inputEl.isContentEditable
    };
  })();`;
}

function buildClickNewChatScript(modelId) {
  const encodedModelId = JSON.stringify(modelId);
  return `(function () {
    const modelId = ${encodedModelId};
    const selectors = {
      chatgpt: ["a[href='/']", "button[aria-label*='New chat']", "button[title*='New chat']"],
      claude: ["a[href='/new']", "button[aria-label*='New chat']", "button[title*='New chat']"],
      copilot: ["button[aria-label*='New chat']", "button[title*='New chat']", "a[href*='conversationstyle']"],
      gemini: ["button[aria-label*='New chat']", "button[aria-label*='New']", "a[href='/app']"],
      perplexity: ["a[href='/']", "button[aria-label*='New Thread']", "button[aria-label*='New thread']", "button[title*='New']"]
    }[modelId] || ["button[aria-label*='New']", "button[title*='New']", "a[href='/']"];

    function isVisible(el) {
      if (!el || !el.isConnected) return false;
      const style = window.getComputedStyle(el);
      if (!style || style.visibility === "hidden" || style.display === "none") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    const candidates = [];
    for (const selector of selectors) {
      try { candidates.push(...Array.from(document.querySelectorAll(selector))); } catch (_) {}
    }

    function labelFor(el) {
      return [
        el.getAttribute?.("aria-label") || "",
        el.getAttribute?.("title") || "",
        el.innerText || "",
        el.textContent || ""
      ].join(" ").trim().toLowerCase();
    }

    const ranked = Array.from(new Set(candidates))
      .filter(isVisible)
      .map((el) => {
        const label = labelFor(el);
        let score = 0;
        if (/new chat|new thread|new conversation/.test(label)) score += 40;
        if (/new/.test(label)) score += 12;
        if (el.tagName === "A") score += 2;
        const rect = el.getBoundingClientRect();
        score -= Math.max(0, rect.left) / 1000;
        score -= Math.max(0, rect.top) / 1000;
        return { el, score };
      })
      .sort((a, b) => b.score - a.score);

    const target = ranked[0]?.el;
    if (!target) return { ok: false, error: "new-chat-not-found" };
    target.click();
    return { ok: true };
  })();`;
}

module.exports = {
  BROADCAST_SUPPORTED_MODEL_IDS,
  buildClickNewChatScript,
  buildClickSendButtonScript,
  buildFocusPromptTargetScript,
  buildInspectPromptStateScript,
  buildPreparePromptTargetScript,
  buildProbePromptTargetScript
};
