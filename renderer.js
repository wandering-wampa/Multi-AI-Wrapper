const LABEL_TO_MODEL = {
  "ChatGPT": "chatgpt",
  "Claude": "claude",
  "Copilot": "copilot",
  "Gemini": "gemini",
  "Perplexity": "perplexity"
};

let lastActiveModel = "chatgpt";
let dragSrcBtn = null;

// NEW: prevent overwriting persisted order on startup
let haveAppliedOrderFromMain = false;
let orderFallbackTimer = null;

function injectStyles() {
  if (document.getElementById("multi-ai-style")) return;

  const style = document.createElement("style");
  style.id = "multi-ai-style";
  style.textContent = `
    /* Force a clearly-visible active tab regardless of existing CSS */
    .multi-ai-tab-active {
      background: #2f6feb !important;
      border-color: #2f6feb !important;
      color: #ffffff !important;
      opacity: 1 !important;
      filter: none !important;
    }
    .multi-ai-tab-active * {
      color: #ffffff !important;
      opacity: 1 !important;
      filter: none !important;
    }

    .multi-ai-tab-dragging {
      opacity: 0.75 !important;
      user-select: none !important;
    }

    .multi-ai-tab-drop-target {
      outline: 2px dashed rgba(255,255,255,0.35);
      outline-offset: 2px;
    }

    /* Prevent text selection glitches while dragging */
    button {
      user-select: none;
      -webkit-user-select: none;
    }
  `;
  document.head.appendChild(style);
}

function getTabButtons() {
  return Array.from(document.querySelectorAll("button")).filter((btn) => {
    const label = (btn.textContent || "").trim();
    return !!LABEL_TO_MODEL[label];
  });
}

function buttonModel(btn) {
  const label = (btn.textContent || "").trim();
  return LABEL_TO_MODEL[label] || null;
}

function setActiveTabUI(modelName) {
  lastActiveModel = modelName;
  getTabButtons().forEach((btn) => {
    btn.classList.toggle("multi-ai-tab-active", buttonModel(btn) === modelName);
  });
}

function swapButtons(a, b) {
  if (!a || !b || a === b) return;

  const parent = a.parentNode;
  if (!parent || parent !== b.parentNode) return;

  // Robust swap that preserves order for non-adjacent nodes
  const aNext = a.nextSibling;
  const bNext = b.nextSibling;

  if (aNext === b) {
    parent.insertBefore(b, a);
    return;
  }
  if (bNext === a) {
    parent.insertBefore(a, b);
    return;
  }

  parent.insertBefore(a, bNext);
  parent.insertBefore(b, aNext);
}

function emitOrderToMain() {
  const order = getTabButtons().map(buttonModel).filter(Boolean);
  window.electronAPI.setModelOrder(order);
}

function clearDropTargets() {
  getTabButtons().forEach((b) => b.classList.remove("multi-ai-tab-drop-target"));
}

function wireTabsOnce() {
  const buttons = getTabButtons();

  buttons.forEach((btn) => {
    const modelName = buttonModel(btn);
    if (!modelName) return;

    // IMPORTANT: prevent duplicate listeners (this was causing lag)
    if (btn.dataset.multiAiWired === "1") return;
    btn.dataset.multiAiWired = "1";

    btn.setAttribute("draggable", "true");

    // CLICK
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.electronAPI.switchModel(modelName);
      setActiveTabUI(modelName);
    });

    // DRAG START
    btn.addEventListener("dragstart", (e) => {
      dragSrcBtn = btn;
      btn.classList.add("multi-ai-tab-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", modelName);
    });

    // DRAG OVER
    btn.addEventListener("dragover", (e) => {
      if (!dragSrcBtn || dragSrcBtn === btn) return;
      e.preventDefault();
      clearDropTargets();
      btn.classList.add("multi-ai-tab-drop-target");
      e.dataTransfer.dropEffect = "move";
    });

    // DRAG LEAVE
    btn.addEventListener("dragleave", () => {
      btn.classList.remove("multi-ai-tab-drop-target");
    });

    // DROP = SWAP
    btn.addEventListener("drop", (e) => {
      e.preventDefault();
      btn.classList.remove("multi-ai-tab-drop-target");

      if (!dragSrcBtn || dragSrcBtn === btn) return;

      swapButtons(dragSrcBtn, btn);

      // Persist new order immediately
      emitOrderToMain();
      setActiveTabUI(lastActiveModel);
    });

    // DRAG END
    btn.addEventListener("dragend", () => {
      btn.classList.remove("multi-ai-tab-dragging");
      clearDropTargets();
      dragSrcBtn = null;
    });
  });
}

// MAIN → renderer sync
window.electronAPI.onActiveModelChanged((modelName) => {
  setActiveTabUI(modelName);
});

// MAIN → renderer persisted order
window.electronAPI.onModelOrderChanged((order) => {
  if (!Array.isArray(order)) return;

  haveAppliedOrderFromMain = true;
  if (orderFallbackTimer) {
    clearTimeout(orderFallbackTimer);
    orderFallbackTimer = null;
  }

  const buttons = getTabButtons();
  if (!buttons.length) return;

  const parent = buttons[0].parentNode;
  if (!parent) return;

  const map = new Map(buttons.map((b) => [buttonModel(b), b]));

  order.forEach((model) => {
    const btn = map.get(model);
    if (btn) parent.appendChild(btn);
  });

  // After reorder, ensure listeners exist (but only once)
  wireTabsOnce();
  setActiveTabUI(lastActiveModel);

  // IMPORTANT: do NOT immediately emit here.
  // Main already has this order; re-sending can create loops in some setups.
});

window.addEventListener("DOMContentLoaded", () => {
  injectStyles();
  wireTabsOnce();
  setActiveTabUI(lastActiveModel);

  // CRITICAL CHANGE:
  // Do NOT send order to main immediately, or you'll overwrite saved order
  // with the default DOM order at startup.
  orderFallbackTimer = setTimeout(() => {
    if (!haveAppliedOrderFromMain) {
      // first run / no settings yet
      emitOrderToMain();
    }
  }, 800);
});
