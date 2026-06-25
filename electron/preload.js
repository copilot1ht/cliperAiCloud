const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cliper", {
  checkDependencies: () => ipcRenderer.invoke("cliper:check-dependencies"),
  analyze: (payload) => ipcRenderer.invoke("cliper:analyze", payload),
  render: (payload) => ipcRenderer.invoke("cliper:render", payload),
  cancel: () => ipcRenderer.invoke("cliper:cancel"),
  selectCookieFile: () => ipcRenderer.invoke("cliper:select-cookie-file"),
  selectOutputFolder: () => ipcRenderer.invoke("cliper:select-output-folder"),
  onWorkerEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("cliper:worker-event", listener);
    return () => ipcRenderer.removeListener("cliper:worker-event", listener);
  }
});
