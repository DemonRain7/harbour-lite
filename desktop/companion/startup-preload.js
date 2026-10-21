"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Deliberately separate from the authenticated Dashboard preload. This local
// animation gets only fixed messages, no filesystem, credentials or arbitrary IPC.
if (process.isMainFrame) contextBridge.exposeInMainWorld("harbourStartup", {
  skip: () => ipcRenderer.send("harbour:startup-skip"),
  details: () => ipcRenderer.send("harbour:startup-details"),
  onState: callback => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("harbour:startup-state", listener);
    return () => ipcRenderer.removeListener("harbour:startup-state", listener);
  },
});
