const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const packageJson = require(path.join(root, "package.json"));
const { name, version } = packageJson;
const productName = packageJson.build?.productName || "Cliper Studio Plus";
const releaseName = `${productName.replace(/\s+/g, "-")}-${version}`;
const releaseDir = path.join(dist, "release", releaseName);
const artifacts = [
  `Cliper-Studio-Plus-Setup-${version}.exe`,
  `Cliper-Studio-Plus-Setup-${version}.exe.blockmap`,
  `Cliper-Studio-Plus-Portable-${version}.exe`,
  "SHA256SUMS.txt",
  "latest.yml"
];

fs.mkdirSync(releaseDir, { recursive: true });
for (const artifact of artifacts) {
  const source = path.join(dist, artifact);
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, path.join(releaseDir, artifact));
  }
}

const releaseType = version.includes("-") ? "Release Candidate" : "Stable";
const manifest = [
  `${productName} ${version}`,
  `Release type: ${releaseType}`,
  "",
  "Google Drive upload:",
  `- ${`Cliper-Studio-Plus-Setup-${version}.exe`}`,
  `- ${`Cliper-Studio-Plus-Portable-${version}.exe`}`,
  "- SHA256SUMS.txt",
  "",
  "Keep the Setup and Portable filenames unchanged so their checksums remain valid."
].join("\r\n");
fs.writeFileSync(path.join(releaseDir, "RELEASE.txt"), `${manifest}\r\n`, "utf8");

console.log(`Assembled ${releaseType.toLowerCase()} release for ${name}: ${releaseDir}`);
