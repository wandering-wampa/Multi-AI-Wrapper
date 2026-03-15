function applyThemeToDOM(payload) {
  const effective = payload && payload.shouldUseDarkColors ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", effective);
}

function buildPromptMeta(promptText) {
  const singleLine = promptText.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 72) return singleLine.length ? "Click to load into composer" : "";
  return `${singleLine.slice(0, 72)}...`;
}

function renderHistory(prompts) {
  const listEl = document.getElementById("history-list");
  const clearButton = document.getElementById("history-clear-button");
  if (!listEl || !clearButton) return;

  const items = Array.isArray(prompts) ? prompts : [];
  listEl.innerHTML = "";
  clearButton.disabled = items.length === 0;

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "Shared prompts will appear here after you send them from compare mode.";
    listEl.appendChild(empty);
    return;
  }

  for (const promptText of items) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "history-item";
    item.title = promptText;
    item.addEventListener("click", async () => {
      try {
        await window.electronAPI.selectComparePromptHistory(promptText);
      } catch (err) {
        console.warn("Multi-AI-Wrapper(prompt-history): selectComparePromptHistory failed", err);
      }
    });

    const main = document.createElement("div");
    main.className = "history-item-main";

    const preview = document.createElement("div");
    preview.className = "history-item-preview";
    preview.textContent = promptText;

    const meta = document.createElement("div");
    meta.className = "history-item-meta";
    meta.textContent = buildPromptMeta(promptText);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "history-item-remove";
    remove.setAttribute("aria-label", "Remove prompt from history");
    remove.title = "Remove";
    remove.textContent = "x";
    remove.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        const result = await window.electronAPI.removeComparePromptHistory(promptText);
        renderHistory(result?.prompts || []);
      } catch (err) {
        console.warn("Multi-AI-Wrapper(prompt-history): removeComparePromptHistory failed", err);
      }
    });

    main.appendChild(preview);
    main.appendChild(meta);
    item.appendChild(main);
    item.appendChild(remove);
    listEl.appendChild(item);
  }
}

async function initHistory() {
  const clearButton = document.getElementById("history-clear-button");

  try {
    const theme = await window.electronAPI.getTheme();
    applyThemeToDOM(theme);
  } catch (err) {
    console.warn("Multi-AI-Wrapper(prompt-history): getTheme failed", err);
  }

  try {
    const payload = await window.electronAPI.getComparePromptHistory();
    renderHistory(payload?.prompts || []);
  } catch (err) {
    console.warn("Multi-AI-Wrapper(prompt-history): getComparePromptHistory failed", err);
    renderHistory([]);
  }

  if (clearButton) {
    clearButton.addEventListener("click", async () => {
      try {
        const result = await window.electronAPI.clearComparePromptHistory();
        renderHistory(result?.prompts || []);
      } catch (err) {
        console.warn("Multi-AI-Wrapper(prompt-history): clearComparePromptHistory failed", err);
      }
    });
  }

  window.electronAPI.onThemeChanged((payload) => {
    applyThemeToDOM(payload);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      window.electronAPI.closeCompareHistory();
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initHistory();
});
