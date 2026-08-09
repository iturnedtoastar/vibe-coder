const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between the page and the OS. Everything else the IDE needs
 * (files, terminal, agent) goes over the local HTTP/WS server, so this surface
 * stays tiny on purpose.
 */
contextBridge.exposeInMainWorld('vibeDesktop', {
  isDesktop: true,
  platform: process.platform,
  // Must match TITLEBAR_HEIGHT in main.js and --titlebar-height in the CSS.
  titleBarHeight: 52,
  openFolder: () => ipcRenderer.invoke('vibe:open-folder'),
  getFolder: () => ipcRenderer.invoke('vibe:get-folder'),
  lastFolder: () => ipcRenderer.invoke('vibe:last-folder'),
  rememberFolder: (dir) => ipcRenderer.invoke('vibe:remember-folder', dir),
  revealFolder: () => ipcRenderer.invoke('vibe:reveal-folder'),
  resetApp: () => ipcRenderer.invoke('vibe:reset-app'),
  capture: (rect) => ipcRenderer.invoke('vibe:capture', rect),
});
