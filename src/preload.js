'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Wrap a main->renderer event so callers get an unsubscribe function. */
function on(channel, fn) {
  const listener = (_event, ...args) => fn(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('terman', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  revealSettings: () => ipcRenderer.invoke('settings:reveal'),
  settingsPath: () => ipcRenderer.invoke('settings:path'),

  createPty: (spec) => ipcRenderer.invoke('pty:create', spec),
  writePty: (id, data) => ipcRenderer.send('pty:write', id, data),
  resizePty: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  killPty: (id) => ipcRenderer.send('pty:kill', id),

  pickExe: () => ipcRenderer.invoke('dialog:pick-exe'),
  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pick-folder', defaultPath),
  confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),
  hotkeyStatus: () => ipcRenderer.invoke('hotkey:status'),

  onPtyData: (fn) => on('pty:data', fn),
  onPtyExit: (fn) => on('pty:exit', fn),
  onNewDefault: (fn) => on('shortcut:new-default', fn),
  onPickExe: (fn) => on('shortcut:pick-exe', fn),
  onHotkeyStatus: (fn) => on('hotkey:status', fn),
});
