const path = require("path");
const packager = require("electron-packager");
const pkg = require("../package.json");

(async () => {
  const projectDir = path.join(__dirname, "..");
  const outDir = path.join(projectDir, "dist");
  const name = `MultiAICockpit-v${pkg.version}`;

  try {
    const appPaths = await packager({
      dir: projectDir,
      name,
      platform: "darwin",
      arch: "universal",
      out: outDir,
      overwrite: true
    });

    if (Array.isArray(appPaths) && appPaths.length) {
      console.log(`Wrote new app to: ${appPaths.join(", ")}`);
    }
  } catch (err) {
    console.error("Multi-AI-Wrapper: macOS packaging failed", err);
    process.exit(1);
  }
})();
