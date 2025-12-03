window.addEventListener("DOMContentLoaded", () => {
  const buttons = document.querySelectorAll("[data-model]");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const model = btn.getAttribute("data-model");
      if (model && window.electronAPI && window.electronAPI.switchModel) {
        window.electronAPI.switchModel(model);
        setActiveButton(model);
      }
    });
  });

  // default to ChatGPT (alphabetical first)
  setActiveButton("chatgpt");
});

function setActiveButton(modelName) {
  const buttons = document.querySelectorAll("[data-model]");
  buttons.forEach((btn) => {
    if (btn.getAttribute("data-model") === modelName) {
      btn.classList.add("active-model");
    } else {
      btn.classList.remove("active-model");
    }
  });
}
