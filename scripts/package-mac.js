const packager = require("electron-packager");
const { createPackagerOptions } = require("./package-common");

(async () => {
  try {
    const appPaths = await packager(createPackagerOptions({
      platform: "darwin",
      arch: "universal"
    }));

    if (Array.isArray(appPaths) && appPaths.length) {
      console.log(`Wrote new app to: ${appPaths.join(", ")}`);
    }
  } catch (err) {
    console.error("Multi-AI-Wrapper: macOS packaging failed", err);
    process.exit(1);
  }
})();
