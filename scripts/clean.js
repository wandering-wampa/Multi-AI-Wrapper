// Empties dist/ so each release starts from a clean slate — no graveyard of old
// build folders, zips, or stale SHA256SUMS.txt. dist/ itself is recreated empty.
//
// Usage: node scripts/clean.js   (or: npm run clean)

const fs = require("fs");
const path = require("path");

const distDir = path.join(__dirname, "..", "dist");

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
  console.log("Multi-AI-Wrapper: dist/ did not exist — created empty.");
  process.exit(0);
}

const entries = fs.readdirSync(distDir);
for (const name of entries) {
  fs.rmSync(path.join(distDir, name), { recursive: true, force: true });
}

console.log(`Multi-AI-Wrapper: cleaned ${entries.length} item(s) from dist/.`);
