const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    saveConfig: (config) => ipcRenderer.invoke('save-config', config),
    loadConfig: () => ipcRenderer.invoke('load-config'),
    scanLocalFiles: (path) => ipcRenderer.invoke('scan-local-files', path),
    deleteFiles: (paths) => ipcRenderer.invoke('delete-files', paths),
    fetchSubscriptions: (apiKey, steamId) => ipcRenderer.invoke('fetch-subscriptions', apiKey, steamId),
    loginSteam: () => ipcRenderer.invoke('login-steam')
});
