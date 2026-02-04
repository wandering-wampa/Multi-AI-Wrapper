const { spawn } = require("child_process");

// VS Code sometimes sets ELECTRON_RUN_AS_NODE=1, which makes Electron run like Node
// and breaks app.getPath, BrowserWindow, etc. Clear it before launching.
delete process.env.ELECTRON_RUN_AS_NODE;

let electronPath;
try {
  // In Node, require("electron") returns the path to the Electron binary.
  electronPath = require("electron");
} catch (err) {
  console.error("Multi-AI-Wrapper: failed to resolve Electron binary", err);
  process.exit(1);
}

const child = spawn(electronPath, ["."], {
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
