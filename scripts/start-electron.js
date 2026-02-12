const { spawn } = require("child_process");
const path = require("path");

// VS Code sometimes sets ELECTRON_RUN_AS_NODE=1, which makes Electron run like Node
// and breaks app.getPath, BrowserWindow, etc. Clear it before launching.
delete process.env.ELECTRON_RUN_AS_NODE;

// Keep development profile data local to this repo to avoid touching globally installed app data.
const devProfileDir = path.resolve(__dirname, "..", ".dev-profile");

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
  env: {
    ...process.env,
    MAW_PROFILE_DIR: process.env.MAW_PROFILE_DIR || devProfileDir
  }
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
