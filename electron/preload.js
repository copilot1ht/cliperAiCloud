const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cliper", {
  getConfig: () => ipcRenderer.invoke("cliper:get-config"),
  saveConfig: (config) => ipcRenderer.invoke("cliper:save-config", config),
  checkDependencies: () => ipcRenderer.invoke("cliper:check-dependencies"),
  validateCookies: (payload) => ipcRenderer.invoke("cliper:validate-cookies", payload),
  testCookies: (payload) => ipcRenderer.invoke("cliper:test-cookies", payload),
  analyze: (payload) => ipcRenderer.invoke("cliper:analyze", payload),
  render: (payload) => ipcRenderer.invoke("cliper:render", payload),
  cancel: () => ipcRenderer.invoke("cliper:cancel"),
  selectCookieFile: () => ipcRenderer.invoke("cliper:select-cookie-file"),
  selectOutputFolder: () => ipcRenderer.invoke("cliper:select-output-folder"),
  openExternal: (url) => ipcRenderer.invoke("cliper:open-external", url),
  onWorkerEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("cliper:worker-event", listener);
    return () => ipcRenderer.removeListener("cliper:worker-event", listener);
  }
});
