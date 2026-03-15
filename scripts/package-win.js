const packager = require("electron-packager");
const { createPackagerOptions } = require("./package-common");

(async () => {
  try {
    const appPaths = await packager(createPackagerOptions({
      platform: "win32",
      arch: "x64",
      icon: "assets/Multi-Ai-logo.ico"
    }));

    if (Array.isArray(appPaths) && appPaths.length) {
      console.log(`Wrote new app to: ${appPaths.join(", ")}`);
    }
  } catch (err) {
    console.error("Multi-AI-Wrapper: Windows packaging failed", err);
    process.exit(1);
  }
})();
