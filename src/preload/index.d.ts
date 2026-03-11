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

type DiscoveryDebugInfo = {
  startedAt: number
  lastAnnounceAt: number
  lastSweepAt: number
  lastArpReadAt: number
  lastArpNeighborCount: number
  lastArpNeighbors: string[]
  broadcastAddresses: string[]
  localAddresses: string[]
  announceSentCount: number
  discoverRequestSentCount: number
  discoverResponseSentCount: number
  announceReceivedCount: number
  discoverRequestReceivedCount: number
  discoverResponseReceivedCount: number
  infoResponseReceivedCount: number
  lastIncomingAt: number
  lastIncomingFrom: string
  lastError: string
}

type AppApi = {
  getDevices: () => Promise<DeviceInfo[]>
  getLocalDevice: () => Promise<DeviceInfo>
  requestDeviceInfo: (deviceId: string) => Promise<DeviceInfo | null>
  refreshDiscovery: () => Promise<boolean>
  getDiscoveryDebug: () => Promise<DiscoveryDebugInfo>
  onDevicesUpdated: (callback: (devices: DeviceInfo[]) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: AppApi
  }
}
