const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const { version } = require(path.join(root, "package.json"));
const artifacts = [
  `Cliper-Studio-Plus-Setup-${version}.exe`,
  `Cliper-Studio-Plus-Portable-${version}.exe`
];

const lines = artifacts.map((name) => {
  const file = path.join(dist, name);
  if (!fs.existsSync(file)) {
    throw new Error(`Release artifact is missing: ${file}`);
  }
  const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  return `${hash}  ${name}`;
});

const manifest = `${lines.join("\n")}\n`;
for (const output of [path.join(root, "SHA256SUMS.txt"), path.join(dist, "SHA256SUMS.txt")]) {
  fs.writeFileSync(output, manifest, "utf8");
}

console.log(`Wrote SHA256 manifests for ${artifacts.length} release artifacts.`);
