import { ElectronAPI } from '@electron-toolkit/preload'

type DeviceInfo = {
  id: string
  name: string
  address: string
  resolution: {
    width: number
    height: number
  }
  dpi: number
  lastSeen: number
}

type AppApi = {
  getDevices: () => Promise<DeviceInfo[]>
  getLocalDevice: () => Promise<DeviceInfo>
  requestDeviceInfo: (deviceId: string) => Promise<DeviceInfo | null>
  refreshDiscovery: () => Promise<boolean>
  onDevicesUpdated: (callback: (devices: DeviceInfo[]) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: AppApi
  }
}
