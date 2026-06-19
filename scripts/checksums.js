// Generates SHA-256 checksums for the release ZIPs in dist/ and writes them to
// dist/SHA256SUMS.txt in the standard `sha256sum` format (lowercase hash, two
// spaces, filename). Run AFTER all platform ZIPs are present in dist/ — including
// the macOS ZIP produced by the release-mac GitHub Actions workflow (download it
// into dist/ first). Attach SHA256SUMS.txt to the GitHub Release so users can
// verify their download was not tampered with:
//
//   Windows : CertUtil -hashfile <file>.zip SHA256   (or  Get-FileHash <file>.zip)
//   macOS   : shasum -a 256 -c SHA256SUMS.txt
//   Linux   : sha256sum -c SHA256SUMS.txt
//
// Usage: node scripts/checksums.js   (or: npm run checksums)

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const pkg = require("../package.json");

const distDir = path.join(__dirname, "..", "dist");
const outFile = path.join(distDir, "SHA256SUMS.txt");

// Only checksum ZIPs for the CURRENT version, so stale builds left in dist/ from
// previous releases never leak into SHA256SUMS.txt. Matches `v<version>` followed
// by `-` (win/linux) or `.zip` (mac), e.g. ...-v1.2.0-win32-x64.zip / ...-v1.2.0.zip.
const versionTag = new RegExp(
  `v${pkg.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[-.])`
);

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

(async () => {
  if (!fs.existsSync(distDir)) {
    console.error(`Multi-AI-Wrapper: dist/ not found — build the packages first.`);
    process.exit(1);
  }

  const zips = fs
    .readdirSync(distDir)
    .filter((name) => name.toLowerCase().endsWith(".zip") && versionTag.test(name))
    .sort();

  if (!zips.length) {
    console.error(
      `Multi-AI-Wrapper: no v${pkg.version} .zip files in dist/ to checksum.`
    );
    process.exit(1);
  }

  const lines = [];
  for (const name of zips) {
    const digest = await sha256(path.join(distDir, name));
    lines.push(`${digest}  ${name}`);
    console.log(`${digest}  ${name}`);
  }

  fs.writeFileSync(outFile, lines.join("\n") + "\n", "utf8");
  console.log(`\nWrote ${zips.length} checksum(s) to ${outFile}`);
})().catch((err) => {
  console.error("Multi-AI-Wrapper: checksum generation failed", err);
  process.exit(1);
});
