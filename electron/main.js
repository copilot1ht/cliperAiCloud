const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

let activeWorker = null;

const MODEL_PROVIDER_DEFAULTS = {
  ytclip: { baseUrl: "https://ai-api.ytclip.org/v1", modelsPath: "/models", auth: "bearer" },
  openai: { baseUrl: "https://api.openai.com/v1", modelsPath: "/models", auth: "bearer" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", modelsPath: "/models", auth: "query-key" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", modelsPath: "/models", auth: "bearer" },
  custom: { baseUrl: "", modelsPath: "/models", auth: "bearer" },
  local: { baseUrl: "", modelsPath: "", auth: "none" }
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
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config || {}, null, 2), "utf8");
  return { ok: true, path: configPath };
}

function getWorkerPath() {
  return path.join(app.getAppPath(), "worker", "cliper_worker.py");
}

function getPythonCommand() {
  return process.env.CLIPER_PYTHON || process.env.PYTHON || "python";
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function pickSuggestedModel(models, providerType) {
  const normalized = models.map((model) => String(model));
  const priority = {
    ytclip: ["ytclip-highlight-v1", "gpt-4.1-mini", "gpt-4o-mini"],
    openai: ["gpt-4.1-mini", "gpt-4o-mini", "gpt-4.1", "gpt-4o"],
    gemini: ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"],
    groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
    custom: ["gpt-4.1-mini", "gpt-4o-mini"],
    local: ["local-heuristic"]
  }[providerType] || [];
  return priority.find((item) => normalized.includes(item)) || normalized[0] || "";
}

async function loadProviderModels(payload = {}) {
  const providerType = payload.providerType || "openai";
  if (providerType === "local") {
    const models = ["local-heuristic", "local-transcript-score", "local-fast"];
    return { ok: true, providerType, models, suggestedModel: pickSuggestedModel(models, providerType), source: "local" };
  }

  const preset = MODEL_PROVIDER_DEFAULTS[providerType] || MODEL_PROVIDER_DEFAULTS.custom;
  const apiKey = String(payload.apiKey || "").trim();
  const baseUrl = normalizeBaseUrl(payload.baseUrl || preset.baseUrl);
  if (!baseUrl) {
    return { ok: false, status: "Base URL kosong", models: [] };
  }
  if (preset.auth !== "none" && !apiKey) {
    return { ok: false, status: "API key kosong", models: [] };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(payload.timeoutMs || 15000));
  try {
    const url = providerType === "gemini"
      ? `${baseUrl}${preset.modelsPath}?key=${encodeURIComponent(apiKey)}`
      : `${baseUrl}${preset.modelsPath}`;
    const headers = { "Accept": "application/json" };
    if (preset.auth === "bearer") {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      const message = body?.error?.message || body?.message || `HTTP ${response.status}`;
      return { ok: false, status: response.status === 401 ? "Invalid API Key" : message, models: [] };
    }

    let models = [];
    if (providerType === "gemini") {
      models = (body.models || [])
        .filter((item) => !item.supportedGenerationMethods || item.supportedGenerationMethods.includes("generateContent"))
        .map((item) => String(item.name || "").replace(/^models\//, ""))
        .filter(Boolean);
    } else {
      models = (body.data || body.models || [])
        .map((item) => (typeof item === "string" ? item : item.id || item.name))
        .filter(Boolean);
    }
    models = Array.from(new Set(models)).sort();
    return {
      ok: true,
      providerType,
      baseUrl,
      models,
      suggestedModel: pickSuggestedModel(models, providerType),
      status: models.length ? "Connected" : "Connected, model list kosong"
    };
  } catch (error) {
    return { ok: false, status: error.name === "AbortError" ? "Connection Timeout" : error.message, models: [] };
  } finally {
    clearTimeout(timeout);
  }
}

function runWorker(mode, payload, event) {
  return new Promise((resolve) => {
    const payloadPath = path.join(app.getPath("userData"), `cliper-${mode}-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
    fs.writeFileSync(payloadPath, JSON.stringify(payload || {}, null, 2), "utf8");

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
  const mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    title: "Cliper YouTube AI Studio",
    backgroundColor: "#eef2f5",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "..", "index.html"));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  ipcMain.handle("cliper:check-dependencies", (event) => runWorker("check", {}, event));
  ipcMain.handle("cliper:get-config", () => readConfig());
  ipcMain.handle("cliper:save-config", (_event, config) => writeConfig(config));
  ipcMain.handle("cliper:read-clipboard", () => clipboard.readText());
  ipcMain.handle("cliper:load-models", (_event, payload) => loadProviderModels(payload));
  ipcMain.handle("cliper:test-provider", async (_event, payload) => {
    if (!payload || typeof payload !== "object") {
      return { ok: false, status: "Payload test API invalid" };
    }
    const tempPath = path.join(app.getPath("userData"), `cliper-test-provider-${Date.now()}.json`);
    fs.writeFileSync(tempPath, JSON.stringify(payload || {}, null, 2), "utf8");
    try {
      const result = await runWorker("test-provider", payload, _event);
      return result?.result || result;
    } finally {
      try { fs.unlinkSync(tempPath); } catch {}
    }
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
  ipcMain.handle("cliper:open-external", async (_event, url) => {
    await shell.openExternal(url);
    return { ok: true };
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
