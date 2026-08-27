const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cliper", {
  getConfig: () => ipcRenderer.invoke("cliper:get-config"),
  getSettingsContract: () => ipcRenderer.invoke("cliper:get-settings-contract"),
  getRuntimeDefaults: () => ipcRenderer.invoke("cliper:get-runtime-defaults"),
  saveConfig: (config) => ipcRenderer.invoke("cliper:save-config", config),
  readClipboard: () => ipcRenderer.invoke("cliper:read-clipboard"),
  loadModels: (payload) => ipcRenderer.invoke("cliper:load-models", payload),
  checkDependencies: () => ipcRenderer.invoke("cliper:check-dependencies"),
  installRuntime: () => ipcRenderer.invoke("cliper:install-runtime"),
  validateCookies: (payload) => ipcRenderer.invoke("cliper:validate-cookies", payload),
  testCookies: (payload) => ipcRenderer.invoke("cliper:test-cookies", payload),
  getYouTubeSession: () => ipcRenderer.invoke("cliper:get-youtube-session"),
  updateYouTubeSession: (payload) => ipcRenderer.invoke("cliper:update-youtube-session", payload),
  removeYouTubeSession: () => ipcRenderer.invoke("cliper:remove-youtube-session"),
  analyze: (payload) => ipcRenderer.invoke("cliper:analyze", payload),
  render: (payload) => ipcRenderer.invoke("cliper:render", payload),
  cancel: () => ipcRenderer.invoke("cliper:cancel"),
  selectCookieFile: () => ipcRenderer.invoke("cliper:select-cookie-file"),
  selectOutputFolder: () => ipcRenderer.invoke("cliper:select-output-folder"),
  selectLogoFile: () => ipcRenderer.invoke("cliper:select-logo-file"),
  selectFontFile: () => ipcRenderer.invoke("cliper:select-font-file"),
  openFolder: (folderPath) => ipcRenderer.invoke("cliper:open-folder", folderPath),
  testProvider: (payload) => ipcRenderer.invoke("cliper:test-provider", payload),
  getCostEstimate: (payload) => ipcRenderer.invoke("cliper:get-cost-estimate", payload),
  openUserGuide: () => ipcRenderer.invoke("cliper:open-user-guide"),
  openExternal: (url) => ipcRenderer.invoke("cliper:open-external", url),
  onWorkerEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("cliper:worker-event", listener);
    return () => ipcRenderer.removeListener("cliper:worker-event", listener);
  },
  onRuntimeInstallEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("cliper:runtime-install-event", listener);
    return () => ipcRenderer.removeListener("cliper:runtime-install-event", listener);
  }
});
