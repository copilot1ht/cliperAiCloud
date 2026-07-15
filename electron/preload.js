const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cliper", {
  getConfig: () => ipcRenderer.invoke("cliper:get-config"),
  saveConfig: (config) => ipcRenderer.invoke("cliper:save-config", config),
  readClipboard: () => ipcRenderer.invoke("cliper:read-clipboard"),
  loadModels: (payload) => ipcRenderer.invoke("cliper:load-models", payload),
  checkDependencies: () => ipcRenderer.invoke("cliper:check-dependencies"),
  validateCookies: (payload) => ipcRenderer.invoke("cliper:validate-cookies", payload),
  testCookies: (payload) => ipcRenderer.invoke("cliper:test-cookies", payload),
  analyze: (payload) => ipcRenderer.invoke("cliper:analyze", payload),
  render: (payload) => ipcRenderer.invoke("cliper:render", payload),
  cancel: () => ipcRenderer.invoke("cliper:cancel"),
  selectCookieFile: () => ipcRenderer.invoke("cliper:select-cookie-file"),
  selectOutputFolder: () => ipcRenderer.invoke("cliper:select-output-folder"),
  selectLogoFile: () => ipcRenderer.invoke("cliper:select-logo-file"),
  selectFontFile: () => ipcRenderer.invoke("cliper:select-font-file"),
  openFolder: (folderPath) => ipcRenderer.invoke("cliper:open-folder", folderPath),
  testProvider: (payload) => ipcRenderer.invoke("cliper:test-provider", payload),
  openUserGuide: () => ipcRenderer.invoke("cliper:open-user-guide"),
  openExternal: (url) => ipcRenderer.invoke("cliper:open-external", url),
  onWorkerEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("cliper:worker-event", listener);
    return () => ipcRenderer.removeListener("cliper:worker-event", listener);
  }
});
