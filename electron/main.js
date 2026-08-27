const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } = require("electron");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { YouTubeSessionManager } = require("./youtube-session-manager");

const activeWorkers = new Map();
let mainWindow = null;
let cloudDesktopSession = null;
let cloudHeartbeatTimer = null;
let runtimeInstallerProcess = null;
let youtubeSessionManager = null;
let youtubeSessionRefreshPromise = null;
const APP_NAME = "Cliper Studio Plus";
const WORKER_SECRET_ENV = Object.freeze({
  cloudAccessToken: "CLIPER_WORKER_CLOUD_ACCESS_TOKEN",
  cloudSigningSecret: "CLIPER_WORKER_CLOUD_SIGNING_SECRET"
});
const LEGACY_WORKER_PAYLOAD_PATTERN = /^cliper-(?:check|validate-cookies|test-cookies|analyze|render)-\d+\.json$/;
const STALE_WORKER_PAYLOAD_AGE_MS = 6 * 60 * 60_000;

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

function getYouTubeSessionManager() {
  if (!youtubeSessionManager) {
    youtubeSessionManager = new YouTubeSessionManager(
      path.join(app.getPath("userData"), "auth", "youtube"),
      (message) => mainLog(message)
    );
  }
  return youtubeSessionManager;
}

function withPersistentYouTubeSession(payload) {
  const next = { ...(payload || {}) };
  const session = getYouTubeSessionManager().readMetadata();
  if (session.present) {
    next.cookiesPath = session.path;
    next.cookies_path = session.path;
    next.youtubeSession = {
      state: session.state,
      source: session.source,
      lastChecked: session.lastChecked
    };
  }
  return next;
}

function youtubeSessionErrorClass(message) {
  const match = String(message || "").match(
    /\b(SESSION_UPDATE_REQUIRED|AUTH_REQUIRED|COOKIE_MISSING|COOKIE_INVALID|COOKIE_EXPIRED|HTTP_403)\b/i
  );
  if (!match) return null;
  return match[1].toUpperCase() === "SESSION_UPDATE_REQUIRED"
    ? "AUTH_REQUIRED"
    : match[1].toUpperCase();
}

function recordYouTubeSessionResult(result) {
  const manager = getYouTubeSessionManager();
  if (!manager.readMetadata().present) return;
  const errorClass = youtubeSessionErrorClass(result?.message);
  if (result?.type === "error" && errorClass) {
    manager.recordCheck({
      ok: false,
      errorClass,
      reason: String(result?.message || "Session YouTube gagal").slice(0, 300)
    });
  }
}

async function refreshYouTubeSessionFromBrowser(event, request = {}) {
  if (youtubeSessionRefreshPromise) return youtubeSessionRefreshPromise;
  const manager = getYouTubeSessionManager();
  const current = manager.readMetadata();
  const browser = String(request.browser || current.browser || "chrome").trim().toLowerCase();
  youtubeSessionRefreshPromise = (async () => {
    let update;
    try {
      update = manager.beginBrowserUpdate(browser);
      const result = await runWorker("update-youtube-session", {
        browser: update.browser,
        outputPath: update.outputPath,
        url: String(request.url || "").trim()
      }, event);
      const validation = result?.result || {};
      if (result?.type !== "done" || validation.ok !== true) {
        const reason = validation.reason || result?.message || "Pembaruan session browser gagal.";
        const session = manager.failBrowserUpdate(validation.errorClass || "UNKNOWN", reason);
        return { ok: false, reason, session };
      }
      const session = manager.completeBrowserUpdate(browser, validation);
      return { ok: true, session, validation };
    } catch (error) {
      const session = manager.failBrowserUpdate("BROWSER_SESSION_UNAVAILABLE", error?.message);
      return { ok: false, reason: error?.message || "Pembaruan session browser gagal.", session };
    }
  })();
  try {
    return await youtubeSessionRefreshPromise;
  } finally {
    youtubeSessionRefreshPromise = null;
  }
}

async function runWorkerWithYouTubeRecovery(mode, payload, event) {
  let normalized = withPersistentYouTubeSession(payload);
  let result = await runWorker(mode, normalized, event);
  const errorClass = youtubeSessionErrorClass(result?.message);
  const session = getYouTubeSessionManager().readMetadata();
  if (
    result?.type === "error"
    && errorClass === "AUTH_REQUIRED"
    && session.source === "browser"
    && session.autoRefresh === true
  ) {
    mainLog(`youtube-session:auto-recovery mode=${mode} browser=${session.browser}`);
    const refreshed = await refreshYouTubeSessionFromBrowser(event, {
      browser: session.browser,
      url: normalized.url
    });
    if (refreshed.ok) {
      normalized = withPersistentYouTubeSession(payload);
      result = await runWorker(mode, normalized, event);
      if (result?.type === "done") mainLog(`youtube-session:auto-resume mode=${mode} status=success`);
    }
  }
  recordYouTubeSessionResult(result);
  return result;
}

function getWorkerPayloadDirectory() {
  return path.join(app.getPath("userData"), "worker-payloads");
}

function removeWorkerPayload(payloadPath) {
  try {
    fs.unlinkSync(payloadPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      mainLog(`worker:payload-cleanup code=${error?.code || "UNKNOWN"}`);
    }
  }
}

function cleanupStaleWorkerPayloads() {
  const candidates = [];
  const userDataPath = app.getPath("userData");
  const collectIfStale = (payloadPath) => {
    try {
      const ageMs = Date.now() - fs.statSync(payloadPath).mtimeMs;
      if (ageMs >= STALE_WORKER_PAYLOAD_AGE_MS) candidates.push(payloadPath);
    } catch {}
  };
  try {
    for (const name of fs.readdirSync(userDataPath)) {
      if (LEGACY_WORKER_PAYLOAD_PATTERN.test(name)) {
        collectIfStale(path.join(userDataPath, name));
      }
    }
  } catch {}
  try {
    const payloadDirectory = getWorkerPayloadDirectory();
    for (const name of fs.readdirSync(payloadDirectory)) {
      if (/^cliper-worker-[0-9a-f-]+\.json$/i.test(name)) {
        collectIfStale(path.join(payloadDirectory, name));
      }
    }
  } catch {}
  for (const payloadPath of candidates) removeWorkerPayload(payloadPath);
  if (candidates.length) mainLog(`worker:stale-payload-cleanup count=${candidates.length}`);
}

function workerPayloadAndEnvironment(payload) {
  const workerPayload = { ...(payload || {}) };
  const secretEnvironment = {};
  for (const [field, environmentName] of Object.entries(WORKER_SECRET_ENV)) {
    const value = String(workerPayload[field] || "").trim();
    delete workerPayload[field];
    if (value) secretEnvironment[environmentName] = value;
  }
  return { workerPayload, secretEnvironment };
}

function stopActiveWorkers(modes = null) {
  let stopped = 0;
  for (const { worker, mode } of activeWorkers.values()) {
    if (modes && !modes.has(mode)) continue;
    if (!worker.killed) {
      worker.kill();
      stopped += 1;
    }
  }
  return stopped;
}

function defaultCloudBaseUrl() {
  return normalizeProviderApiRoot(
    process.env.CLIPER_CLOUD_URL
    || (app.isPackaged ? "https://api.cliperaicloud.online/v1" : "http://127.0.0.1:4100/v1")
  );
}

const MODEL_PROVIDER_DEFAULTS = {
  cloud: { baseUrl: defaultCloudBaseUrl(), modelsPath: "/models", auth: "bearer" }
};

function getConfigPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function readConfig() {
  try {
    const configPath = getConfigPath();
    const stored = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : {};
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
    // Cloud keys are only valid through the Cliper gateway. Ignore legacy
    // direct-provider URLs left by older Electron builds.
    stored.providerType = "cloud";
    stored.baseUrl = defaultCloudBaseUrl();
    stored.cloudBaseUrl = stored.baseUrl;
    stored.model = "auto";
    stored.highlightModel = "auto";
    const youtubeSession = getYouTubeSessionManager().readMetadata();
    if (youtubeSession.present) {
      stored.cookies_path = youtubeSession.path;
      stored.cookiesPath = youtubeSession.path;
      stored.cookies_meta = youtubeSession;
    } else {
      delete stored.cookies_path;
      delete stored.cookiesPath;
      delete stored.cookies_meta;
    }
    return stored;
  } catch {
    return {};
  }
}

function writeConfig(config) {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const stored = { ...(config || {}) };
  stored.providerType = "cloud";
  stored.baseUrl = defaultCloudBaseUrl();
  stored.cloudBaseUrl = stored.baseUrl;
  stored.model = "auto";
  stored.highlightModel = "auto";
  const apiKey = String(stored.apiKey || "").trim();
  delete stored.apiKey;
  delete stored.apiKeyEncrypted;
  if (apiKey) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Penyimpanan aman OS tidak tersedia. API key tidak disimpan ke disk.");
    }
    stored.apiKeyEncrypted = safeStorage.encryptString(apiKey).toString("base64");
  }
  const youtubeSession = getYouTubeSessionManager().readMetadata();
  stored.cookies_path = youtubeSession.present ? youtubeSession.path : "";
  stored.cookiesPath = stored.cookies_path;
  stored.cookies_meta = youtubeSession.present ? youtubeSession : null;
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

function readSettingsContract() {
  const contractPath = path.join(
    getUnpackedAppPath(),
    "worker",
    "settings-contract.json"
  );
  const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  if (
    !Number.isSafeInteger(contract?.version)
    || !contract.defaults
    || !Array.isArray(contract.booleanSettings)
  ) {
    throw new Error("Settings contract tidak valid.");
  }
  return contract;
}

function getUserGuidePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "docs", "PANDUAN_PENGGUNA.md");
  }
  return path.join(app.getAppPath(), "docs", "PANDUAN_PENGGUNA.md");
}

function getRuntimeInstallerPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "runtime", "install-runtime.ps1");
  }
  return path.join(app.getAppPath(), "scripts", "install-runtime.ps1");
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

function asUsd(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatUsd(value) {
  return `US$${asUsd(value).toFixed(2)}`;
}

function cloudWalletUsd(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const wallet = source.wallet && typeof source.wallet === "object" ? source.wallet : source;
    const explicit = wallet.availableUsd;
    if (explicit !== undefined) return asUsd(explicit);
    const micro = wallet.availableMicroUsd;
    if (micro !== undefined) return asUsd(Number(micro) / 1_000_000);
  }
  return 0;
}

function cloudSpendableUsd(wallet, fallback = 0) {
  if (!wallet || typeof wallet !== "object") return asUsd(fallback);
  const explicit = wallet.spendableUsd;
  if (explicit !== undefined) return asUsd(explicit);
  const micro = wallet.spendableMicroUsd;
  if (micro !== undefined) return asUsd(Number(micro) / 1_000_000);
  return cloudWalletUsd(wallet);
}

async function cloudJson(endpoint, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(timeoutMs || 15000));
  try {
    const response = await fetch(endpoint, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.message || body.reason || `Cliper Cloud HTTP ${response.status}`);
      error.statusCode = response.status;
      error.details = body;
      throw error;
    }
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
  // Never send a clip_sk key to DeepSeek/OpenAI directly. The gateway URL is
  // selected by the Electron runtime and cannot be overridden by the renderer.
  const baseUrl = MODEL_PROVIDER_DEFAULTS.cloud.baseUrl;
  if (!baseUrl || !apiKey) return { ok: false, status: "Cliper Cloud URL atau API key kosong" };
  const deviceFingerprint = desktopDeviceFingerprint();
  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
  let compatible = cloudDesktopSession
    && cloudDesktopSession.baseUrl === baseUrl
    && cloudDesktopSession.keyHash === keyHash
    && cloudDesktopSession.deviceFingerprint === deviceFingerprint;
  if (!forceActivation && compatible && Date.parse(cloudDesktopSession.accessExpiresAt || 0) > Date.now() + 60_000) {
    try {
      await heartbeatCliperCloud();
      return { ok: true, session: cloudDesktopSession };
    } catch (error) {
      mainLog(`cloud:session-recovery ${error.message}`);
      cloudDesktopSession = null;
      compatible = false;
    }
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
  // Keep the refresh credential in Electron and rotate the short-lived work
  // lease before it expires. The Worker only receives the current access
  // token plus signing secret for a single job, never the refresh token.
  if (Date.parse(cloudDesktopSession.accessExpiresAt || 0) <= Date.now() + 5 * 60_000) {
    cloudDesktopSession = await refreshCliperCloudSession(cloudDesktopSession, 15000);
  }
  const body = {};
  const pathName = "/api/auth/desktop/heartbeat";
  const endpoint = cliperCloudEndpoint(cloudDesktopSession.baseUrl, pathName);
  return cloudJson(endpoint, {
    method: "POST",
    headers: signedCloudHeaders(cloudDesktopSession, "POST", pathName, body),
    body: JSON.stringify(body)
  }, 15000);
}

async function signedCliperCloudJson(session, method, pathName, body = {}, timeoutMs = 15000) {
  const endpoint = cliperCloudEndpoint(session.baseUrl, pathName);
  const options = {
    method,
    headers: signedCloudHeaders(session, method, pathName, body)
  };
  if (method.toUpperCase() !== "GET") options.body = JSON.stringify(body);
  return cloudJson(endpoint, options, timeoutMs);
}

function startCloudHeartbeat() {
  if (cloudHeartbeatTimer) clearInterval(cloudHeartbeatTimer);
  cloudHeartbeatTimer = setInterval(() => {
    heartbeatCliperCloud().catch((error) => {
      mainLog(`cloud:heartbeat ${error.message}`);
      if (/unauthorized|401|token.*(?:tidak valid|berakhir)|session.*(?:tidak valid|expired)/i.test(String(error.message || ""))) {
        cloudDesktopSession = null;
      }
    });
  }, 5 * 60_000);
  cloudHeartbeatTimer.unref?.();
}

async function verifyCliperCloud(payload = {}) {
  const ready = await ensureCliperCloudSession(payload, true);
  if (!ready.ok) return ready;
  try {
    const heartbeat = await heartbeatCliperCloud();
    const wallet = await signedCliperCloudJson(
      ready.session,
      "GET",
      "/v1/wallet/summary",
      {},
      payload.timeoutMs || 15000,
    );
    const license = ready.session.license || {};
    const unlimited = Boolean(wallet?.unlimited || heartbeat?.wallet?.unlimited || license.wallet?.unlimited || license.unlimited);
    const availableUsd = cloudWalletUsd(wallet, heartbeat, license);
    const spendableUsd = unlimited ? availableUsd : cloudSpendableUsd(wallet, availableUsd);
    // Authentication and device activation never depend on wallet balance.
    // The API evaluates the reservation for the specific paid job later.
    const walletReady = true;
    const creditLabel = unlimited ? "Unlimited" : formatUsd(availableUsd);
    return {
      ok: true,
      routerReady: true,
      walletReady,
      status: unlimited
        ? `Cloud terhubung · saldo ${creditLabel}`
        : spendableUsd > 0
          ? `Cloud terhubung · saldo ${creditLabel}`
          : "Cloud terhubung · isi saldo sebelum pekerjaan AI berbayar",
      response: "CLOUD_SESSION_AND_WALLET_OK",
      usage: {},
      route: { provider: "cliper-cloud", model: "auto" },
      license: {
        valid: true,
        status: "active",
        billingMode: "wallet",
        walletCurrency: "USD",
        wallet: {
          currency: "USD",
          availableUsd,
          reservedUsd: asUsd(wallet?.reservedUsd),
          spendableUsd,
          availableMicroUsd: Math.round(availableUsd * 1_000_000),
          reservedMicroUsd: Math.round(asUsd(wallet?.reservedUsd) * 1_000_000),
          spendableMicroUsd: Math.round(spendableUsd * 1_000_000),
          unlimited
        },
        availableUsd,
        availableMicroUsd: Math.round(availableUsd * 1_000_000),
        spendableUsd,
        spendableMicroUsd: Math.round(spendableUsd * 1_000_000),
        keyType: license.keyType || (unlimited ? "internal" : "user"),
        cloudConnected: true,
        billingEligible: unlimited || spendableUsd > 0,
        unlimited,
        deviceSlots: license.deviceSlots,
        expiresAt: license.expiresAt
      }
    };
  } catch (error) {
    const license = ready.session.license || {};
    const providerUnavailable = Number(error.statusCode || 0) === 503
      || /provider.*(?:belum|tidak).*(?:aktif|siap|tersedia)|router.*(?:belum|tidak).*(?:siap|tersedia)/i.test(String(error.message || ""));
    if (providerUnavailable) {
      return {
        ok: true,
        routerReady: false,
        status: "Cloud terhubung · AI provider belum disiapkan admin",
        response: "CLOUD_CONNECTED",
        usage: {},
        route: { provider: "cliper-cloud", model: "auto" },
        license: {
          valid: true,
          status: "active",
          billingMode: "wallet",
          wallet: license.wallet || {
            currency: "USD",
            availableUsd: 0,
            reservedUsd: 0,
            spendableUsd: 0,
            availableMicroUsd: 0,
            reservedMicroUsd: 0,
            spendableMicroUsd: 0,
            unlimited: Boolean(license.unlimited)
          },
          keyType: license.keyType || (license.unlimited ? "internal" : "user"),
          cloudConnected: true,
          billingEligible: license.billingEligible === true,
          unlimited: Boolean(license.unlimited),
          deviceSlots: license.deviceSlots,
          expiresAt: license.expiresAt
        }
      };
    }
    return {
      ok: false,
      code: Number(error.statusCode || 0) === 401 ? "INVALID_OR_EXPIRED_SESSION" : "CLOUD_TEST_FAILED",
      status: error.message
    };
  }
}

async function fetchCloudCostEstimate(payload = {}) {
  const ready = await ensureCliperCloudSession(payload, false);
  const requestedCount = Math.max(1, Math.min(10, Number(payload.requestedClipCount || payload.clipCount || 4)));
  const duration = Math.max(0, Number(payload.sourceDurationSeconds || 0));
  if (!ready.ok) {
    const aiMin = Math.round((0.008 + requestedCount * 0.0035) * 1000) / 1000;
    const aiMax = Math.round((0.016 + requestedCount * 0.007) * 1000) / 1000;
    const platformFee = 0.01;
    return {
      ok: true,
      fallback: true,
      estimate: {
        currency: "USD",
        requestedClipCount: requestedCount,
        sourceDurationSeconds: duration,
        aiCostMin: aiMin,
        aiCostMax: aiMax,
        platformFee,
        estimatedMin: Math.round((platformFee + aiMin) * 1000) / 1000,
        estimatedMax: Math.round((platformFee + aiMax) * 1000) / 1000,
        note: "Estimasi biaya dihitung dari profil standar."
      }
    };
  }
  try {
    const response = await signedCliperCloudJson(
      ready.session,
      "POST",
      "/v1/pricing/estimate",
      {
        sourceDurationSeconds: duration,
        requestedClipCount: requestedCount
      },
      payload.timeoutMs || 8000
    );
    if (response?.estimate) {
      return { ok: true, estimate: response.estimate };
    }
    return { ok: true, estimate: response };
  } catch (error) {
    mainLog(`fetchCloudCostEstimate:error ${error?.message || error}`);
    const aiMin = Math.round((0.008 + requestedCount * 0.0035) * 1000) / 1000;
    const aiMax = Math.round((0.016 + requestedCount * 0.007) * 1000) / 1000;
    const platformFee = 0.01;
    return {
      ok: true,
      fallback: true,
      estimate: {
        currency: "USD",
        requestedClipCount: requestedCount,
        sourceDurationSeconds: duration,
        aiCostMin: aiMin,
        aiCostMax: aiMax,
        platformFee,
        estimatedMin: Math.round((platformFee + aiMin) * 1000) / 1000,
        estimatedMax: Math.round((platformFee + aiMax) * 1000) / 1000,
        note: "Estimasi biaya cadangan saat Cloud timeout."
      }
    };
  }
}

function sendRuntimeInstallEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("cliper:runtime-install-event", payload);
}

function installRuntime() {
  if (runtimeInstallerProcess) {
    return Promise.resolve({ ok: false, status: "Runtime installer sedang berjalan." });
  }
  const scriptPath = getRuntimeInstallerPath();
  if (!fs.existsSync(scriptPath)) {
    return Promise.resolve({ ok: false, status: "Runtime installer tidak ditemukan.", path: scriptPath });
  }
  return new Promise((resolve) => {
    const output = [];
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-InstallPython",
        "-InstallFFmpeg",
        "-InstallNode"
      ],
      {
        cwd: path.dirname(scriptPath),
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" }
      }
    );
    runtimeInstallerProcess = child;
    const collect = (chunk, stream) => {
      const message = String(chunk || "").replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (!message) return;
      output.push(message);
      if (output.length > 120) output.shift();
      sendRuntimeInstallEvent({ type: "output", stream, message });
    };
    child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
    child.on("error", (error) => {
      runtimeInstallerProcess = null;
      sendRuntimeInstallEvent({ type: "error", message: error.message });
      resolve({ ok: false, status: error.message });
    });
    child.on("close", (code) => {
      runtimeInstallerProcess = null;
      const ok = Number(code) === 0;
      const status = ok
        ? "Runtime utama berhasil dipasang. Periksa ulang dependency."
        : `Runtime installer berhenti dengan kode ${code}.`;
      sendRuntimeInstallEvent({ type: ok ? "done" : "error", message: status, code });
      resolve({ ok, status, code, output: output.slice(-30) });
    });
  });
}

async function runWorker(mode, payload, event) {
  let securedPayload = { ...(payload || {}) };
  if (securedPayload.providerType === "cloud") {
    const ready = await ensureCliperCloudSession(securedPayload);
    if (!ready.ok) return { type: "error", message: ready.status || "Sesi Cliper Cloud gagal dibuat." };
    securedPayload.baseUrl = ready.session.baseUrl;
    securedPayload.cloudBaseUrl = ready.session.baseUrl;
    securedPayload.cloudAccessToken = ready.session.accessToken;
    securedPayload.cloudSigningSecret = ready.session.signingSecret;
    if (mode === "analyze" && !securedPayload.metadataOnly) {
      const wallet = await signedCliperCloudJson(ready.session, "GET", "/v1/wallet/summary", {}, securedPayload.timeoutMs);
      const availableUsd = cloudWalletUsd(wallet);
      const spendableUsd = cloudSpendableUsd(wallet, availableUsd);
      mainLog(`cloud:wallet-preflight available_usd=${availableUsd.toFixed(6)} spendable_usd=${spendableUsd.toFixed(6)} paid_job_eligible=${wallet.billingEligible === true}`);
      // Do not reject locally. The API creates an atomic reservation using the
      // actual job estimate and returns a precise PAYMENT_REQUIRED response if
      // this particular job cannot be covered.
      securedPayload.analysisRequestId = String(securedPayload.analysisRequestId || `analysis-${crypto.randomUUID()}`);
      securedPayload.cloudWalletSummary = wallet;
    }
    delete securedPayload.apiKey;
  }
  return new Promise((resolve) => {
    const prepared = workerPayloadAndEnvironment({
      ...securedPayload,
      // The packaged Electron runtime is the source of truth for artifact
      // provenance. Keep the Python worker from carrying a stale UI version.
      appVersion: app.getVersion(),
      cacheRoot: getLocalCachePath(),
      appRoot: getRuntimeAppPath(),
      unpackedAppRoot: getUnpackedAppPath(),
      defaultLogoPath: ensureRuntimeLogo(),
      logoPath: resolveWorkerLogoPath(securedPayload?.logoPath)
    });
    const payloadDirectory = getWorkerPayloadDirectory();
    const payloadPath = path.join(payloadDirectory, `cliper-worker-${crypto.randomUUID()}.json`);
    fs.mkdirSync(payloadDirectory, { recursive: true });
    fs.writeFileSync(payloadPath, JSON.stringify(prepared.workerPayload, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });

    const args = [getWorkerPath(), "--mode", mode, "--payload", payloadPath];
    const workerEnvironment = {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1"
    };
    for (const environmentName of Object.values(WORKER_SECRET_ENV)) {
      delete workerEnvironment[environmentName];
    }
    Object.assign(workerEnvironment, prepared.secretEnvironment);

    let worker;
    try {
      worker = spawn(getPythonCommand(), args, {
        cwd: app.getPath("documents"),
        windowsHide: true,
        env: workerEnvironment
      });
    } catch (error) {
      removeWorkerPayload(payloadPath);
      resolve({ type: "error", message: error.message });
      return;
    }

    const workerId = crypto.randomUUID();
    activeWorkers.set(workerId, { worker, mode, payloadPath });
    let finalResult = null;
    let stderr = "";
    let buffer = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      activeWorkers.delete(workerId);
      removeWorkerPayload(payloadPath);
      resolve(result);
    };

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
      finish({ type: "error", message: error.message });
    });

    worker.on("close", (code) => {
      if (finalResult) {
        finish(finalResult);
      } else if (code === 0) {
        finish({ type: "done", result: null });
      } else {
        finish({
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
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f3f8f8",
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
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
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

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  mainLog("app:ready");
  cleanupStaleWorkerPayloads();
  ipcMain.handle("cliper:check-dependencies", (event) => runWorker("check", {}, event));
  ipcMain.handle("cliper:install-runtime", () => installRuntime());
  ipcMain.handle("cliper:get-config", () => readConfig());
  ipcMain.handle("cliper:get-settings-contract", () => readSettingsContract());
  ipcMain.handle("cliper:get-runtime-defaults", () => ({
    cloudBaseUrl: defaultCloudBaseUrl(),
    packaged: app.isPackaged,
    appVersion: app.getVersion()
  }));
  ipcMain.handle("cliper:save-config", (_event, config) => writeConfig(config));
  ipcMain.handle("cliper:read-clipboard", () => clipboard.readText());
  ipcMain.handle("cliper:load-models", (_event, payload) => loadProviderModels(payload));
  ipcMain.handle("cliper:get-cost-estimate", (_event, payload) => fetchCloudCostEstimate(payload));
  ipcMain.handle("cliper:test-provider", async (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      return { ok: false, status: "Payload test API invalid" };
    }
    return verifyCliperCloud({ ...payload, providerType: "cloud" });
  });
  ipcMain.handle("cliper:get-youtube-session", () => getYouTubeSessionManager().readMetadata());
  ipcMain.handle("cliper:remove-youtube-session", () => getYouTubeSessionManager().remove());
  ipcMain.handle("cliper:update-youtube-session", async (event, payload) => {
    return refreshYouTubeSessionFromBrowser(event, payload || {});
  });
  ipcMain.handle("cliper:validate-cookies", async (event, payload) => {
    const result = await runWorker("validate-cookies", payload, event);
    if (result?.type === "done" && result.result?.ok) {
      const session = getYouTubeSessionManager().importFile(payload?.cookiesPath, result.result);
      result.result = { ...result.result, path: session.path, session };
    }
    return result;
  });
  ipcMain.handle("cliper:test-cookies", async (event, payload) => {
    const normalized = withPersistentYouTubeSession(payload);
    const result = await runWorker("test-cookies", normalized, event);
    if (getYouTubeSessionManager().readMetadata().present) {
      const session = getYouTubeSessionManager().recordCheck(result?.result || {
        ok: false,
        reason: result?.message,
        errorClass: "UNKNOWN"
      });
      if (result?.result) result.result.session = session;
    }
    return result;
  });
  ipcMain.handle("cliper:analyze", async (event, payload) => {
    const result = await runWorkerWithYouTubeRecovery("analyze", payload, event);
    if (result?.result?.video?.used_cookies) getYouTubeSessionManager().recordUse(true);
    return result;
  });
  ipcMain.handle("cliper:render", async (event, payload) => {
    const result = await runWorkerWithYouTubeRecovery("render", payload, event);
    if (result?.result?.manifest?.used_cookies) getYouTubeSessionManager().recordUse(true);
    return result;
  });
  ipcMain.handle("cliper:cancel", () => {
    const stopped = stopActiveWorkers(new Set(["analyze", "render"]));
    return { ok: stopped > 0, stopped };
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
  stopActiveWorkers();
  if (runtimeInstallerProcess && !runtimeInstallerProcess.killed) {
    runtimeInstallerProcess.kill();
  }
  activeWorkers.clear();
  runtimeInstallerProcess = null;
});
