const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kovalskyDesktop", {
  pickWorkspaceDirectory: async () => {
    const value = await ipcRenderer.invoke("kovalsky:pick-workspace-directory");
    return typeof value === "string" && value.trim() ? value : null;
  },
  openExternalUrl: async (url) => {
    return ipcRenderer.invoke("kovalsky:open-external-url", url);
  },
});
