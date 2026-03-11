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

type PairingInfo = {
  port: number
  urls: string[]
}

type AdbConnectResult = {
  ok: boolean
  target: string
  message: string
}

type ProjectionStartResult = {
  ok: boolean
  sessionId: string
  targetDeviceId: string
  message: string
}

type ProjectionPushPayload = {
  imageDataUrl: string
  overlap: {
    width: number
    height: number
    left: number
    top: number
  }
}

type ProjectionPushResult = {
  ok: boolean
  sessionId: string
  frameId: number
  message: string
}

type ProjectionStatus = {
  sessionId: string
  targetDeviceId: string
  targetClientId: string
  active: boolean
  streamOnline: boolean
  lastFrameId: number
  lastSentAt: number
  lastAckFrameId: number
  lastAckAt: number
  waitingAck: boolean
  status: 'idle' | 'waiting-ack' | 'receiving' | 'ack-timeout' | 'offline' | 'stopped'
  lastMessage: string
}

type AppApi = {
  getDevices: () => Promise<DeviceInfo[]>
  getLocalDevice: () => Promise<DeviceInfo>
  requestDeviceInfo: (deviceId: string) => Promise<DeviceInfo | null>
  refreshDiscovery: () => Promise<boolean>
  getDiscoveryDebug: () => Promise<DiscoveryDebugInfo>
  getPairingInfo: () => Promise<PairingInfo>
  adbConnect: (target: string) => Promise<AdbConnectResult>
  projectionStart: (targetDeviceId: string) => Promise<ProjectionStartResult>
  projectionPush: (sessionId: string, payload: ProjectionPushPayload) => Promise<ProjectionPushResult>
  projectionStop: (sessionId: string) => Promise<boolean>
  projectionStatus: (sessionId: string) => Promise<ProjectionStatus | null>
  setOverlayMode: (enabled: boolean) => Promise<boolean>
  onDevicesUpdated: (callback: (devices: DeviceInfo[]) => void) => () => void
  onProjectionStatus: (callback: (payload: ProjectionStatus) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: AppApi
  }
}
