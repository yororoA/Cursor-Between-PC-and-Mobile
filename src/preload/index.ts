import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  getDevices: () => ipcRenderer.invoke('lan:get-devices'),
  getLocalDevice: () => ipcRenderer.invoke('lan:get-local-device'),
  requestDeviceInfo: (deviceId: string) => ipcRenderer.invoke('lan:request-device-info', deviceId),
  refreshDiscovery: () => ipcRenderer.invoke('lan:refresh-discovery'),
  onDevicesUpdated: (callback: (devices: unknown[]) => void) => {
    const listener = (_event: unknown, devices: unknown[]) => callback(devices)
    ipcRenderer.on('lan:devices-updated', listener)
    return () => {
      ipcRenderer.removeListener('lan:devices-updated', listener)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
