const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } = require("electron");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

let activeWorker = null;
let mainWindow = null;
let cloudDesktopSession = null;
let cloudHeartbeatTimer = null;
const APP_NAME = "Cliper Studio Plus";

app.setName(APP_NAME);
app.setPath("userData", path.join(app.getPath("appData"), APP_NAME));

function mainLog(message) {
  try {
    const logPath = path.join(app.getPath("userData"), "main.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {}
}

process.on("uncaughtException", (error) => {
  mainLog(`uncaughtException: ${error?.stack || error}`);
});

process.on("unhandledRejection", (error) => {
  mainLog(`unhandledRejection: ${error?.stack || error}`);
});

function getLocalCachePath() {
  return path.join(process.env.LOCALAPPDATA || app.getPath("appData"), APP_NAME, "cache");
}

const MODEL_PROVIDER_DEFAULTS = {
  cloud: { baseUrl: "https://api.cliper.cloud/v1", modelsPath: "/models", auth: "bearer" }
};

function getConfigPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function readConfig() {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
      return {};
    }
    const stored = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (stored.apiKey && !stored.apiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
      const migratedKey = String(stored.apiKey);
      stored.apiKeyEncrypted = safeStorage.encryptString(migratedKey).toString("base64");
      delete stored.apiKey;
      fs.writeFileSync(configPath, JSON.stringify(stored, null, 2), "utf8");
      stored.apiKey = migratedKey;
    }
    if (stored.apiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
      stored.apiKey = safeStorage.decryptString(Buffer.from(stored.apiKeyEncrypted, "base64"));
    }
    delete stored.apiKeyEncrypted;
    return stored;
  } catch {
    return {};
  }
}

function writeConfig(config) {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const stored = { ...(config || {}) };
  const apiKey = String(stored.apiKey || "").trim();
  delete stored.apiKey;
  delete stored.apiKeyEncrypted;
  if (apiKey) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Penyimpanan aman OS tidak tersedia. API key tidak disimpan ke disk.");
    }
    stored.apiKeyEncrypted = safeStorage.encryptString(apiKey).toString("base64");
  }
  fs.writeFileSync(configPath, JSON.stringify(stored, null, 2), "utf8");
  return { ok: true, path: configPath };
}

function getRuntimeAppPath() {
  return app.getAppPath();
}

function getUnpackedAppPath() {
  const appPath = app.getAppPath();
  if (appPath.endsWith("app.asar")) {
    return path.join(path.dirname(appPath), "app.asar.unpacked");
  }
  return appPath;
}

function getWorkerPath() {
  return path.join(getUnpackedAppPath(), "worker", "cliper_worker.py");
}

function getUserGuidePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "docs", "PANDUAN_PENGGUNA.md");
  }
  return path.join(app.getAppPath(), "docs", "PANDUAN_PENGGUNA.md");
}

function getAssetPath(...parts) {
  return path.join(getRuntimeAppPath(), "assets", ...parts);
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function ensureRuntimeLogo() {
  const source = getAssetPath("icon-512.png");
  const target = path.join(app.getPath("userData"), "brand", "icon-512.png");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const sourceBuffer = fs.readFileSync(source);
  const sourceHash = hashBuffer(sourceBuffer);
  let shouldWrite = true;
  if (fs.existsSync(target)) {
    try {
      shouldWrite = hashBuffer(fs.readFileSync(target)) !== sourceHash;
    } catch {
      shouldWrite = true;
    }
  }
  if (shouldWrite) {
    fs.writeFileSync(target, sourceBuffer);
  }
  return target;
}

function resolveWorkerLogoPath(value) {
  const runtimeLogo = ensureRuntimeLogo();
  if (!value) {
    return runtimeLogo;
  }
  if (path.isAbsolute(value)) {
    return value;
  }
  const normalized = String(value).replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized === "assets/cliper-logo-transparent.png" || normalized === "assets/icon-512.png") {
    return runtimeLogo;
  }
  return path.join(getRuntimeAppPath(), normalized);
}

function getPythonCommand() {
  return process.env.CLIPER_PYTHON || process.env.PYTHON || "python";
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeProviderApiRoot(value) {
  return normalizeBaseUrl(value)
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/responses$/i, "");
}

async function loadProviderModels(payload = {}) {
  const providerType = "cloud";
  if (providerType === "cloud") {
    if (!String(payload.apiKey || "").trim()) {
      return { ok: false, providerType, models: ["auto"], suggestedModel: "auto", status: "API key Cliper AI Cloud kosong" };
    }
    return {
      ok: true,
      providerType,
      models: ["auto"],
      suggestedModel: "auto",
      source: "cliper-cloud-router",
      status: "Model dipilih otomatis oleh Cliper Cloud"
    };
  }

}

function desktopDeviceFingerprint() {
  const source = [
    os.hostname(),
    os.platform(),
    os.release(),
    os.arch(),
    process.env.COMPUTERNAME || "",
    process.env.USERDOMAIN || "",
    process.env.PROCESSOR_IDENTIFIER || "",
    process.env.SystemDrive || "",
    app.getPath("userData")
  ].join("|");
  return crypto.createHash("sha256").update(source).digest("hex");
}

function cliperCloudEndpoint(baseUrl, route) {
  const parsed = new URL(normalizeProviderApiRoot(baseUrl));
  parsed.pathname = `${parsed.pathname.replace(/\/v1\/?$/i, "").replace(/\/$/, "")}${route}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function cloudJson(endpoint, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(timeoutMs || 15000));
  try {
    const response = await fetch(endpoint, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.reason || `Cliper Cloud HTTP ${response.status}`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function signedCloudHeaders(session, method, pathName, body) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(18).toString("base64url");
  const contentSha256 = crypto.createHash("sha256").update(JSON.stringify(body || {})).digest("hex");
  const canonical = [method.toUpperCase(), pathName, timestamp, nonce, contentSha256].join("\n");
  const signature = crypto.createHmac("sha256", session.signingSecret).update(canonical).digest("hex");
  return {
    Authorization: `Bearer ${session.accessToken}`,
    "Content-Type": "application/json",
    "X-Cliper-Timestamp": timestamp,
    "X-Cliper-Nonce": nonce,
    "X-Cliper-Content-SHA256": contentSha256,
    "X-Cliper-Signature": signature
  };
}

async function refreshCliperCloudSession(session, timeoutMs) {
  const endpoint = cliperCloudEndpoint(session.baseUrl, "/api/auth/desktop/refresh");
  const body = await cloudJson(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: session.refreshToken, deviceFingerprint: session.deviceFingerprint })
  }, timeoutMs);
  cloudDesktopSession = { ...session, ...body };
  return cloudDesktopSession;
}

async function ensureCliperCloudSession(payload = {}, forceActivation = false) {
  const apiKey = String(payload.apiKey || "").trim();
  const baseUrl = normalizeProviderApiRoot(payload.baseUrl || MODEL_PROVIDER_DEFAULTS.cloud.baseUrl);
  if (!baseUrl || !apiKey) return { ok: false, status: "Cliper Cloud URL atau API key kosong" };
  const deviceFingerprint = desktopDeviceFingerprint();
  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
  const compatible = cloudDesktopSession
    && cloudDesktopSession.baseUrl === baseUrl
    && cloudDesktopSession.keyHash === keyHash
    && cloudDesktopSession.deviceFingerprint === deviceFingerprint;
  if (!forceActivation && compatible && Date.parse(cloudDesktopSession.accessExpiresAt || 0) > Date.now() + 60_000) {
    return { ok: true, session: cloudDesktopSession };
  }
  try {
    if (!forceActivation && compatible && Date.parse(cloudDesktopSession.refreshExpiresAt || 0) > Date.now() + 60_000) {
      const session = await refreshCliperCloudSession(cloudDesktopSession, payload.timeoutMs);
      return { ok: true, session };
    }
    const endpoint = cliperCloudEndpoint(baseUrl, "/api/auth/desktop/activate");
    const body = await cloudJson(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: apiKey,
        deviceFingerprint,
        deviceName: os.hostname(),
        appVersion: app.getVersion()
      })
    }, payload.timeoutMs);
    cloudDesktopSession = { ...body, baseUrl, keyHash, deviceFingerprint };
    startCloudHeartbeat();
    return { ok: true, session: cloudDesktopSession };
  } catch (error) {
    cloudDesktopSession = null;
    return { ok: false, status: error.name === "AbortError" ? "Cliper Cloud timeout" : error.message };
  }
}

async function heartbeatCliperCloud() {
  if (!cloudDesktopSession) return null;
  const body = {};
  const pathName = "/api/auth/desktop/heartbeat";
  const endpoint = cliperCloudEndpoint(cloudDesktopSession.baseUrl, pathName);
  return cloudJson(endpoint, {
    method: "POST",
    headers: signedCloudHeaders(cloudDesktopSession, "POST", pathName, body),
    body: JSON.stringify(body)
  }, 15000);
}

function startCloudHeartbeat() {
  if (cloudHeartbeatTimer) clearInterval(cloudHeartbeatTimer);
  cloudHeartbeatTimer = setInterval(() => {
    heartbeatCliperCloud().catch((error) => mainLog(`cloud:heartbeat ${error.message}`));
  }, 15 * 60_000);
  cloudHeartbeatTimer.unref?.();
}

async function verifyCliperCloud(payload = {}) {
  const ready = await ensureCliperCloudSession(payload, true);
  if (!ready.ok) return ready;
  try {
    const heartbeat = await heartbeatCliperCloud();
    const license = ready.session.license || {};
    return {
      ok: true,
      status: `Active · ${license.plan || "plan"} · ${Number(heartbeat?.creditsRemainingMicro || license.creditsRemainingMicro || 0).toLocaleString("id-ID")} microcredits`,
      response: "SESSION_OK",
      usage: {},
      license: {
        valid: true,
        status: "active",
        plan: license.plan,
        credits: heartbeat?.creditsRemainingMicro || license.creditsRemainingMicro || 0,
        deviceSlots: license.deviceSlots,
        expiresAt: license.expiresAt
      }
    };
  } catch (error) {
    return { ok: false, status: error.message };
  }
}

async function runWorker(mode, payload, event) {
  let securedPayload = { ...(payload || {}) };
  if (securedPayload.providerType === "cloud") {
    const ready = await ensureCliperCloudSession(securedPayload);
    if (!ready.ok) return { type: "error", message: ready.status || "Sesi Cliper Cloud gagal dibuat." };
    securedPayload.cloudAccessToken = ready.session.accessToken;
    securedPayload.cloudSigningSecret = ready.session.signingSecret;
    delete securedPayload.apiKey;
  }
  return new Promise((resolve) => {
    const workerPayload = {
      ...securedPayload,
      cacheRoot: getLocalCachePath(),
      appRoot: getRuntimeAppPath(),
      unpackedAppRoot: getUnpackedAppPath(),
      defaultLogoPath: ensureRuntimeLogo(),
      logoPath: resolveWorkerLogoPath(securedPayload?.logoPath)
    };
    const payloadPath = path.join(app.getPath("userData"), `cliper-${mode}-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
    fs.writeFileSync(payloadPath, JSON.stringify(workerPayload, null, 2), "utf8");

    const args = [getWorkerPath(), "--mode", mode, "--payload", payloadPath];
    const worker = spawn(getPythonCommand(), args, {
      cwd: app.getPath("documents"),
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });

    activeWorker = worker;
    let finalResult = null;
    let stderr = "";
    let buffer = "";

    const send = (data) => {
      if (event?.sender && !event.sender.isDestroyed()) {
        event.sender.send("cliper:worker-event", data);
      }
    };

    worker.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          send(data);
          if (data.type === "done" || data.type === "error") {
            finalResult = data;
          }
        } catch {
          send({ type: "log", message: line });
        }
      }
    });

    worker.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      send({ type: "log", level: "stderr", message: chunk.toString().trim() });
    });

    worker.on("error", (error) => {
      activeWorker = null;
      resolve({ type: "error", message: error.message });
    });

    worker.on("close", (code) => {
      activeWorker = null;
      try {
        fs.unlinkSync(payloadPath);
      } catch {}

      if (finalResult) {
        resolve(finalResult);
      } else if (code === 0) {
        resolve({ type: "done", result: null });
      } else {
        resolve({
          type: "error",
          message: stderr.trim() || `Worker berhenti dengan kode ${code}`
        });
      }
    });
  });
}

function createWindow() {
  mainLog("createWindow:start");
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    title: APP_NAME,
    backgroundColor: "#eef2f5",
    icon: getAssetPath("icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.removeMenu();
  const indexPath = path.join(__dirname, "..", "index.html");
  mainLog(`createWindow:loadFile ${indexPath}`);
  mainWindow.loadFile(indexPath).catch((error) => {
    mainLog(`loadFile:error ${error?.stack || error}`);
  });
  mainWindow.webContents.on("did-finish-load", () => mainLog("renderer:did-finish-load"));
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (Number(level) >= 2) {
      mainLog(`renderer:console level=${level} message=${message} line=${line} source=${sourceId}`);
    }
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    mainLog(`renderer:did-fail-load code=${code} description=${description} url=${url}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    mainLog(`renderer:gone ${JSON.stringify(details || {})}`);
  });
  mainWindow.on("closed", () => {
    mainLog("window:closed");
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  mainLog("app:ready");
  ipcMain.handle("cliper:check-dependencies", (event) => runWorker("check", {}, event));
  ipcMain.handle("cliper:get-config", () => readConfig());
  ipcMain.handle("cliper:save-config", (_event, config) => writeConfig(config));
  ipcMain.handle("cliper:read-clipboard", () => clipboard.readText());
  ipcMain.handle("cliper:load-models", (_event, payload) => loadProviderModels(payload));
ipcMain.handle("cliper:test-provider", async (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      return { ok: false, status: "Payload test API invalid" };
    }
    if (payload.providerType !== "cloud") {
      return { ok: false, status: "Cliper AI Cloud adalah satu-satunya provider yang didukung." };
    }
    return verifyCliperCloud(payload);
  });
  ipcMain.handle("cliper:validate-cookies", (event, payload) => runWorker("validate-cookies", payload, event));
  ipcMain.handle("cliper:test-cookies", (event, payload) => runWorker("test-cookies", payload, event));
  ipcMain.handle("cliper:analyze", (event, payload) => runWorker("analyze", payload, event));
  ipcMain.handle("cliper:render", (event, payload) => runWorker("render", payload, event));
  ipcMain.handle("cliper:cancel", () => {
    if (activeWorker && !activeWorker.killed) {
      activeWorker.kill();
      activeWorker = null;
      return { ok: true };
    }
    return { ok: false };
  });
  ipcMain.handle("cliper:select-cookie-file", async () => {
    const result = await dialog.showOpenDialog({
      title: "Pilih cookies.txt",
      properties: ["openFile"],
      filters: [{ name: "Cookies text", extensions: ["txt"] }]
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("cliper:select-output-folder", async () => {
    const result = await dialog.showOpenDialog({
      title: "Pilih folder output",
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("cliper:select-logo-file", async () => {
    const result = await dialog.showOpenDialog({
      title: "Pilih logo atau media watermark",
      properties: ["openFile"],
      filters: [
        { name: "Logo / media", extensions: ["png", "jpg", "jpeg", "webp", "gif", "webm"] },
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("cliper:select-font-file", async () => {
    const result = await dialog.showOpenDialog({
      title: "Pilih font subtitle",
      properties: ["openFile"],
      filters: [
        { name: "Font files", extensions: ["ttf", "otf"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("cliper:open-external", async (_event, url) => {
    await shell.openExternal(url);
    return { ok: true };
  });
  ipcMain.handle("cliper:open-user-guide", async () => {
    const guidePath = getUserGuidePath();
    if (!fs.existsSync(guidePath)) {
      return { ok: false, message: "Panduan pengguna tidak ditemukan.", path: guidePath };
    }
    const errorMessage = await shell.openPath(guidePath);
    return errorMessage
      ? { ok: false, message: errorMessage, path: guidePath }
      : { ok: true, path: guidePath };
  });
  ipcMain.handle("cliper:open-folder", async (_event, folderPath) => {
    const target = path.resolve(String(folderPath || ""));
    if (!target || !fs.existsSync(target)) {
      return { ok: false, message: "Folder output tidak ditemukan." };
    }
    const errorMessage = await shell.openPath(target);
    if (errorMessage) {
      clipboard.writeText(target);
      return { ok: false, copied: true, path: target, message: `Folder tidak bisa dibuka otomatis, path disalin. ${errorMessage}` };
    }
    return { ok: true, path: target };
  });

  createWindow();

  app.on("activate", () => {
    if (!mainWindow && BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (activeWorker && !activeWorker.killed) {
    activeWorker.kill();
  }
  activeWorker = null;
});
