const path = require("path");
const pkg = require("../package.json");

const projectDir = path.join(__dirname, "..");
const outDir = path.join(projectDir, "dist");
const appName = `${pkg.productName}-v${pkg.version}`;

const ignore = [
  /^\/\.dev-profile($|\/)/,
  /^\/\.git($|\/)/,
  /^\/\.github($|\/)/,
  /^\/dist($|\/)/,
  /^\/docs($|\/)/
];

function createPackagerOptions(overrides = {}) {
  return {
    dir: projectDir,
    name: appName,
    out: outDir,
    overwrite: true,
    prune: true,
    ignore,
    ...overrides
  };
}

module.exports = {
  appName,
  createPackagerOptions
};
