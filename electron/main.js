const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

let activeWorker = null;

function getWorkerPath() {
  return path.join(app.getAppPath(), "worker", "cliper_worker.py");
}

function getPythonCommand() {
  return process.env.CLIPER_PYTHON || process.env.PYTHON || "python";
}

function runWorker(mode, payload, event) {
  return new Promise((resolve) => {
    const payloadPath = path.join(app.getPath("userData"), `cliper-${mode}-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(payloadPath), { recursive: true });
    fs.writeFileSync(payloadPath, JSON.stringify(payload || {}, null, 2), "utf8");

    const args = [getWorkerPath(), "--mode", mode, "--payload", payloadPath];
    const worker = spawn(getPythonCommand(), args, {
      cwd: app.getPath("documents"),
      windowsHide: true
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
