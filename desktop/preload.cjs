'use strict';
const {contextBridge, ipcRenderer} = require('electron');
const subscribe = (channel, listener) => {
  if (typeof listener !== 'function') throw new TypeError('listener must be a function');
  const handler = (_event, value) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
const automaticListeners = new Set(), automaticPending = new Map();
ipcRenderer.on('yixu:auto-reading-request', (_event, request) => {
  automaticPending.set(request.id, request);
  for (const listener of automaticListeners) listener(request);
});
contextBridge.exposeInMainWorld('yixuDesktop', Object.freeze({
  getLanguage: () => ipcRenderer.invoke('yixu:get-language'),
  setLanguage: language => ipcRenderer.invoke('yixu:set-language', language),
  getWindowState: () => ipcRenderer.invoke('yixu:window-state'),
  chooseProjectDirectory: current => ipcRenderer.invoke('yixu:choose-project-directory',current),
  openProjectDirectory: directory => ipcRenderer.invoke('yixu:open-project-directory',directory),
  onWindowStateChanged: listener => subscribe('yixu:window-state-changed', listener),
  onAutoReadingRequested: listener => {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    automaticListeners.add(listener);
    ipcRenderer.invoke('yixu:auto-reader-ready', true).catch(() => {});
    for (const request of automaticPending.values()) listener(request);
    return () => { automaticListeners.delete(listener); if (!automaticListeners.size) ipcRenderer.invoke('yixu:auto-reader-ready', false).catch(() => {}); };
  },
  respondAutoReading: (id, result) => { automaticPending.delete(id); return ipcRenderer.invoke('yixu:auto-reading-result', id, result); },
  onLifecycleStatus: listener => subscribe('yixu:lifecycle-status', listener),
}));
