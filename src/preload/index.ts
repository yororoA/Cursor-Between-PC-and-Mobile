import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  getDevices: () => ipcRenderer.invoke('lan:get-devices'),
  getLocalDevice: () => ipcRenderer.invoke('lan:get-local-device'),
  requestDeviceInfo: (deviceId: string) => ipcRenderer.invoke('lan:request-device-info', deviceId),
  refreshDiscovery: () => ipcRenderer.invoke('lan:refresh-discovery'),
  getDiscoveryDebug: () => ipcRenderer.invoke('lan:get-discovery-debug'),
  getPairingInfo: () => ipcRenderer.invoke('lan:get-pairing-info'),
  adbConnect: (target: string) => ipcRenderer.invoke('lan:adb-connect', target),
  projectionStart: (targetDeviceId: string) =>
    ipcRenderer.invoke('lan:projection-start', targetDeviceId),
  projectionPush: (sessionId: string, payload: unknown) =>
    ipcRenderer.invoke('lan:projection-push', sessionId, payload),
  projectionStop: (sessionId: string) => ipcRenderer.invoke('lan:projection-stop', sessionId),
  projectionStatus: (sessionId: string) => ipcRenderer.invoke('lan:projection-status', sessionId),
  setOverlayMode: (enabled: boolean) => ipcRenderer.invoke('ui:set-overlay-mode', enabled),
  setClickThrough: (enabled: boolean) => ipcRenderer.invoke('ui:set-click-through', enabled),
  onDevicesUpdated: (callback: (devices: unknown[]) => void) => {
    const listener = (_event: unknown, devices: unknown[]): void => callback(devices)
    ipcRenderer.on('lan:devices-updated', listener)
    return () => {
      ipcRenderer.removeListener('lan:devices-updated', listener)
    }
  },
  onProjectionStatus: (callback: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown): void => callback(payload)
    ipcRenderer.on('lan:projection-status', listener)
    return () => {
      ipcRenderer.removeListener('lan:projection-status', listener)
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
