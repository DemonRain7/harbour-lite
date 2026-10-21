"use strict";
const { contextBridge, ipcRenderer } = require("electron");
// A purpose-built shell bridge: no token, paths, arbitrary HTTP, shell or raw IPC.
if (process.isMainFrame) contextBridge.exposeInMainWorld("harbourOrb", {
  getVisualPolicy: () => ipcRenderer.invoke("desktop:visual-policy"),
  onVisualPolicy: fn => {
    const listener = (_event, state) => fn(state); ipcRenderer.on("desktop:visual-policy", listener);
    return () => ipcRenderer.removeListener("desktop:visual-policy", listener);
  },
  invoke: (input) => ipcRenderer.invoke("desktop:orb-action", input),
  onState: (fn) => {
    const listener = (_event, state) => fn(state); ipcRenderer.on("orb:state", listener);
    return () => ipcRenderer.removeListener("orb:state", listener);
  },
  onMusic: (fn) => {
    const listener = (_event, state) => fn(state); ipcRenderer.on("orb:music", listener);
    return () => ipcRenderer.removeListener("orb:music", listener);
  },
  onNotice: (fn) => {
    const listener = (_event, text) => fn(text); ipcRenderer.on("orb:notice", listener);
    return () => ipcRenderer.removeListener("orb:notice", listener);
  },
  onLayout: (fn) => {
    const listener = (_event, layout) => fn(layout); ipcRenderer.on("orb:layout", listener);
    return () => ipcRenderer.removeListener("orb:layout", listener);
  },
});
