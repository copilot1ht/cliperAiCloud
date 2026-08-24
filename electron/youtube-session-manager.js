const fs = require("fs");
const path = require("path");

const SESSION_STATES = new Set([
  "NO_SESSION",
  "SESSION_PRESENT",
  "SESSION_VALID",
  "SESSION_EXPIRING",
  "SESSION_INVALID",
  "SESSION_UPDATE_REQUIRED",
  "SESSION_ERROR"
]);

function isoNow() {
  return new Date().toISOString();
}

function safeJson(pathname) {
  try {
    const value = JSON.parse(fs.readFileSync(pathname, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function replaceFileSync(sourcePath, destinationPath) {
  const backupPath = `${destinationPath}.${process.pid}.bak`;
  const hadDestination = fs.existsSync(destinationPath);
  try {
    if (hadDestination) fs.renameSync(destinationPath, backupPath);
    fs.renameSync(sourcePath, destinationPath);
    if (hadDestination) fs.unlinkSync(backupPath);
  } catch (error) {
    try {
      if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath);
      if (hadDestination && fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, destinationPath);
      }
    } catch {}
    throw error;
  } finally {
    try {
      if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
    } catch {}
    try {
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    } catch {}
  }
}

class YouTubeSessionManager {
  constructor(rootPath, logger = () => {}) {
    this.rootPath = path.resolve(rootPath);
    this.cookiePath = path.join(this.rootPath, "cookies.txt");
    this.metadataPath = path.join(this.rootPath, "session-meta.json");
    this.logger = logger;
  }

  ensureDirectory() {
    fs.mkdirSync(this.rootPath, { recursive: true });
  }

  readMetadata() {
    const present = fs.existsSync(this.cookiePath);
    const stored = safeJson(this.metadataPath);
    const state = SESSION_STATES.has(stored.state)
      ? stored.state
      : present
        ? "SESSION_PRESENT"
        : "NO_SESSION";
    return {
      schema: 1,
      present,
      state: present ? state : "NO_SESSION",
      path: present ? this.cookiePath : "",
      source: stored.source || "manual_import",
      browser: stored.browser || "unknown",
      fileName: stored.fileName || "cookies.txt",
      sizeBytes: present ? Number(fs.statSync(this.cookiePath).size || 0) : 0,
      createdAt: stored.createdAt || null,
      updatedAt: stored.updatedAt || null,
      lastChecked: stored.lastChecked || null,
      lastSuccess: stored.lastSuccess || null,
      lastFailure: stored.lastFailure || null,
      lastUsed: stored.lastUsed || null,
      errorClass: stored.errorClass || null,
      reason: stored.reason || null
    };
  }

  writeMetadata(patch) {
    this.ensureDirectory();
    const current = this.readMetadata();
    const next = {
      ...current,
      ...patch,
      schema: 1,
      path: undefined,
      present: undefined,
      sizeBytes: undefined
    };
    fs.writeFileSync(this.metadataPath, JSON.stringify(next, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
    return this.readMetadata();
  }

  importFile(sourcePath, validation = {}) {
    const source = path.resolve(String(sourcePath || ""));
    if (!sourcePath || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error("File cookies tidak ditemukan.");
    }
    if (validation.ok !== true) {
      throw new Error("File cookies belum lolos validasi.");
    }
    this.ensureDirectory();
    const temporaryPath = `${this.cookiePath}.${process.pid}.tmp`;
    fs.copyFileSync(source, temporaryPath);
    fs.chmodSync(temporaryPath, 0o600);
    replaceFileSync(temporaryPath, this.cookiePath);
    const now = isoNow();
    const current = this.readMetadata();
    const metadata = this.writeMetadata({
      state: "SESSION_PRESENT",
      source: "manual_import",
      browser: validation.browser || current.browser || "unknown",
      fileName: path.basename(source),
      createdAt: current.createdAt || now,
      updatedAt: now,
      lastChecked: null,
      lastFailure: null,
      errorClass: null,
      reason: validation.warning || null
    });
    this.logger("youtube-session:imported");
    return metadata;
  }

  recordCheck(result = {}) {
    const ok = result.testOk === true || result.ok === true;
    const errorClass = String(result.errorClass || "").trim() || null;
    const state = ok
      ? "SESSION_VALID"
      : ["AUTH_REQUIRED", "COOKIE_INVALID", "COOKIE_EXPIRED"].includes(errorClass)
        ? "SESSION_UPDATE_REQUIRED"
        : "SESSION_ERROR";
    const now = isoNow();
    const metadata = this.writeMetadata({
      state,
      lastChecked: result.testedAt || now,
      lastSuccess: ok ? now : this.readMetadata().lastSuccess,
      lastFailure: ok ? null : now,
      errorClass: ok ? null : errorClass,
      reason: ok ? null : String(result.status || result.reason || "Session check gagal").slice(0, 300)
    });
    this.logger(`youtube-session:check state=${metadata.state}`);
    return metadata;
  }

  recordUse(success, errorClass = null) {
    const now = isoNow();
    return this.writeMetadata({
      state: success ? "SESSION_VALID" : this.readMetadata().state,
      lastUsed: now,
      lastSuccess: success ? now : this.readMetadata().lastSuccess,
      lastFailure: success ? null : now,
      errorClass: success ? null : errorClass || this.readMetadata().errorClass
    });
  }

  remove() {
    for (const pathname of [this.cookiePath, this.metadataPath]) {
      try {
        fs.unlinkSync(pathname);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    this.logger("youtube-session:removed");
    return this.readMetadata();
  }
}

module.exports = { YouTubeSessionManager };
