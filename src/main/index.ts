import { app, shell, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { createSocket, type Socket } from 'dgram'
import os from 'os'
import { randomUUID } from 'crypto'
import { exec } from 'child_process'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

type DeviceRecord = {
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

type DiscoveryDebugSnapshot = {
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

type WireMessage =
  | {
      type: 'announce'
      payload: DeviceRecord
    }
  | {
      type: 'query-info'
      payload: {
        requesterId: string
        targetId: string
        requestId: string
      }
    }
  | {
      type: 'info-response'
      payload: {
        requestId: string
        targetId: string
        device: DeviceRecord
      }
    }
  | {
      type: 'discover-request'
      payload: {
        requestId: string
      }
    }
  | {
      type: 'discover-response'
      payload: {
        requestId: string
        device: DeviceRecord
      }
    }

const DISCOVERY_PORT = 42425
const BROADCAST_ADDRESS = '255.255.255.255'
const ANNOUNCE_INTERVAL_MS = 3_000
const DISCOVERY_SWEEP_INTERVAL_MS = 12_000
const PEER_TTL_MS = 10_000

const localDeviceId = randomUUID()
const localDeviceName = os.hostname()

let mainWindowRef: BrowserWindow | null = null
let discoverySocket: Socket | null = null
let announceTimer: NodeJS.Timeout | null = null
let discoverySweepTimer: NodeJS.Timeout | null = null
let pruneTimer: NodeJS.Timeout | null = null

const peers = new Map<string, DeviceRecord>()
const pendingRequests = new Map<string, (device: DeviceRecord) => void>()
const debugState: DiscoveryDebugSnapshot = {
  startedAt: Date.now(),
  lastAnnounceAt: 0,
  lastSweepAt: 0,
  lastArpReadAt: 0,
  lastArpNeighborCount: 0,
  lastArpNeighbors: [],
  broadcastAddresses: [],
  localAddresses: [],
  announceSentCount: 0,
  discoverRequestSentCount: 0,
  discoverResponseSentCount: 0,
  announceReceivedCount: 0,
  discoverRequestReceivedCount: 0,
  discoverResponseReceivedCount: 0,
  infoResponseReceivedCount: 0,
  lastIncomingAt: 0,
  lastIncomingFrom: '',
  lastError: ''
}

function getLocalIPv4Addresses(): string[] {
  const localAddresses = new Set<string>()
  const interfaces = os.networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue
    for (const item of entries) {
      if (item.family === 'IPv4' && item.address) {
        localAddresses.add(item.address)
      }
    }
  }
  return Array.from(localAddresses)
}

function getDiscoveryDebugSnapshot(): DiscoveryDebugSnapshot {
  return {
    ...debugState,
    lastArpNeighbors: [...debugState.lastArpNeighbors],
    broadcastAddresses: [...debugState.broadcastAddresses]
  }
}

function createLocalDeviceRecord(): DeviceRecord {
  const display = screen.getPrimaryDisplay()
  const bounds = display.size
  const dpi = Math.max(72, Math.round(96 * (display.scaleFactor || 1)))

  return {
    id: localDeviceId,
    name: localDeviceName,
    address: '',
    resolution: {
      width: bounds.width,
      height: bounds.height
    },
    dpi,
    lastSeen: Date.now()
  }
}

function emitDevicesUpdated(): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('lan:devices-updated', Array.from(peers.values()))
  }
}

function mergePeer(nextPeer: DeviceRecord): void {
  if (!nextPeer.id || nextPeer.id === localDeviceId) return

  peers.set(nextPeer.id, {
    ...nextPeer,
    lastSeen: Date.now()
  })
  emitDevicesUpdated()
}

function sendWireMessage(message: WireMessage, address = BROADCAST_ADDRESS): void {
  if (!discoverySocket) return
  const content = Buffer.from(JSON.stringify(message), 'utf-8')
  discoverySocket.send(content, DISCOVERY_PORT, address)

  if (message.type === 'announce') {
    debugState.announceSentCount += 1
  } else if (message.type === 'discover-request') {
    debugState.discoverRequestSentCount += 1
  } else if (message.type === 'discover-response') {
    debugState.discoverResponseSentCount += 1
  }
}

function getBroadcastAddressesFromInterfaces(): string[] {
  const networks = os.networkInterfaces()
  const addresses = new Set<string>()

  for (const entries of Object.values(networks)) {
    if (!entries) continue

    for (const item of entries) {
      if (item.family !== 'IPv4' || item.internal || !item.address || !item.netmask) continue
      const ipParts = item.address.split('.').map((part) => Number(part))
      const maskParts = item.netmask.split('.').map((part) => Number(part))
      if (ipParts.length !== 4 || maskParts.length !== 4) continue

      const broadcast = ipParts.map((value, index) => (value & maskParts[index]) | (255 ^ maskParts[index]))
      addresses.add(broadcast.join('.'))
    }
  }

  addresses.add(BROADCAST_ADDRESS)
  return Array.from(addresses)
}

function execPromise(command: string): Promise<string> {
  return new Promise((resolve) => {
    exec(command, { windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve('')
        return
      }
      resolve(stdout ?? '')
    })
  })
}

async function getArpNeighborAddresses(): Promise<string[]> {
  const output =
    process.platform === 'win32'
      ? await execPromise('arp -a')
      : process.platform === 'darwin'
        ? await execPromise('arp -an')
        : await execPromise('ip neigh')

  if (!output) return []

  const ipRegex = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/g
  const localIps = new Set<string>()
  const neighbors = new Set<string>()
  const interfaces = os.networkInterfaces()

  for (const entries of Object.values(interfaces)) {
    if (!entries) continue
    for (const item of entries) {
      if (item.family === 'IPv4' && item.address) {
        localIps.add(item.address)
      }
    }
  }

  for (const match of output.matchAll(ipRegex)) {
    const ip = match[1]
    if (!ip) continue
    const firstOctet = Number(ip.split('.')[0])
    if (firstOctet >= 224 || firstOctet === 0 || firstOctet === 127) continue
    if (ip === '255.255.255.255' || ip.endsWith('.255')) continue
    if (localIps.has(ip)) continue
    neighbors.add(ip)
  }

  return Array.from(neighbors)
}

async function triggerActiveDiscovery(): Promise<void> {
  if (!discoverySocket) return
  debugState.lastSweepAt = Date.now()
  debugState.localAddresses = getLocalIPv4Addresses()

  const requestId = randomUUID()
  const probe: WireMessage = {
    type: 'discover-request',
    payload: {
      requestId
    }
  }

  const broadcastAddresses = getBroadcastAddressesFromInterfaces()
  debugState.broadcastAddresses = broadcastAddresses

  for (const address of broadcastAddresses) {
    sendWireMessage(probe, address)
  }

  const arpNeighbors = await getArpNeighborAddresses()
  debugState.lastArpReadAt = Date.now()
  debugState.lastArpNeighborCount = arpNeighbors.length
  debugState.lastArpNeighbors = arpNeighbors.slice(0, 60)
  for (const address of arpNeighbors) {
    sendWireMessage(probe, address)
  }
}

function announceSelf(): void {
  debugState.lastAnnounceAt = Date.now()
  debugState.localAddresses = getLocalIPv4Addresses()
  const announceMessage: WireMessage = {
    type: 'announce',
    payload: createLocalDeviceRecord()
  }

  // Use subnet broadcast addresses to improve discovery on mobile hotspot networks.
  const broadcastAddresses = getBroadcastAddressesFromInterfaces()
  debugState.broadcastAddresses = broadcastAddresses
  for (const address of broadcastAddresses) {
    sendWireMessage(announceMessage, address)
  }
}

function handleWireMessage(raw: Buffer, remoteAddress: string): void {
  let parsed: WireMessage | null = null

  try {
    parsed = JSON.parse(raw.toString('utf-8')) as WireMessage
  } catch {
    return
  }

  if (!parsed) return

  debugState.lastIncomingAt = Date.now()
  debugState.lastIncomingFrom = remoteAddress

  if (parsed.type === 'announce') {
    debugState.announceReceivedCount += 1
    const peer = {
      ...parsed.payload,
      address: remoteAddress,
      lastSeen: Date.now()
    }
    mergePeer(peer)
    return
  }

  if (parsed.type === 'query-info') {
    if (parsed.payload.targetId !== localDeviceId) return

    sendWireMessage(
      {
        type: 'info-response',
        payload: {
          requestId: parsed.payload.requestId,
          targetId: parsed.payload.requesterId,
          device: createLocalDeviceRecord()
        }
      },
      remoteAddress
    )
    return
  }

  if (parsed.type === 'discover-request') {
    debugState.discoverRequestReceivedCount += 1
    sendWireMessage(
      {
        type: 'discover-response',
        payload: {
          requestId: parsed.payload.requestId,
          device: createLocalDeviceRecord()
        }
      },
      remoteAddress
    )
    return
  }

  if (parsed.type === 'discover-response') {
    debugState.discoverResponseReceivedCount += 1
    const remoteDevice = {
      ...parsed.payload.device,
      address: remoteAddress,
      lastSeen: Date.now()
    }
    mergePeer(remoteDevice)
    return
  }

  if (parsed.type === 'info-response') {
    if (parsed.payload.targetId !== localDeviceId) return
    debugState.infoResponseReceivedCount += 1

    const remoteDevice = {
      ...parsed.payload.device,
      address: remoteAddress,
      lastSeen: Date.now()
    }
    mergePeer(remoteDevice)

    const resolve = pendingRequests.get(parsed.payload.requestId)
    if (resolve) {
      pendingRequests.delete(parsed.payload.requestId)
      resolve(remoteDevice)
    }
  }
}

function prunePeers(): void {
  const now = Date.now()
  let changed = false

  for (const [id, peer] of peers.entries()) {
    if (now - peer.lastSeen > PEER_TTL_MS) {
      peers.delete(id)
      changed = true
    }
  }

  if (changed) emitDevicesUpdated()
}

function startDiscoveryService(): void {
  const socket = createSocket({ type: 'udp4', reuseAddr: true })
  discoverySocket = socket

  socket.on('message', (msg, remote) => {
    handleWireMessage(msg, remote.address)
  })

  socket.on('error', (error) => {
    debugState.lastError = String(error)
    console.error('LAN discovery socket error:', error)
  })

  socket.bind(DISCOVERY_PORT, () => {
    socket.setBroadcast(true)
    debugState.localAddresses = getLocalIPv4Addresses()
    announceSelf()
    void triggerActiveDiscovery()
  })

  announceTimer = setInterval(announceSelf, ANNOUNCE_INTERVAL_MS)
  discoverySweepTimer = setInterval(() => {
    void triggerActiveDiscovery()
  }, DISCOVERY_SWEEP_INTERVAL_MS)
  pruneTimer = setInterval(prunePeers, 1_500)
}

function stopDiscoveryService(): void {
  if (announceTimer) clearInterval(announceTimer)
  if (discoverySweepTimer) clearInterval(discoverySweepTimer)
  if (pruneTimer) clearInterval(pruneTimer)
  announceTimer = null
  discoverySweepTimer = null
  pruneTimer = null

  if (discoverySocket) {
    discoverySocket.close()
    discoverySocket = null
  }

  pendingRequests.clear()
  peers.clear()
}

async function requestPeerInfo(deviceId: string): Promise<DeviceRecord | null> {
  const known = peers.get(deviceId)
  if (!known) return null

  const requestId = randomUUID()
  const targetAddress = known.address || BROADCAST_ADDRESS

  const responsePromise = new Promise<DeviceRecord | null>((resolve) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId)
      resolve(peers.get(deviceId) ?? null)
    }, 2_000)

    pendingRequests.set(requestId, (device) => {
      clearTimeout(timeout)
      resolve(device)
    })
  })

  sendWireMessage(
    {
      type: 'query-info',
      payload: {
        requesterId: localDeviceId,
        targetId: deviceId,
        requestId
      }
    },
    targetAddress
  )

  return responsePromise
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindowRef = mainWindow

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('lan:get-devices', () => {
    return Array.from(peers.values()).sort((a, b) => a.name.localeCompare(b.name))
  })

  ipcMain.handle('lan:get-local-device', () => createLocalDeviceRecord())

  ipcMain.handle('lan:request-device-info', async (_event, deviceId: string) => {
    return requestPeerInfo(deviceId)
  })

  ipcMain.handle('lan:refresh-discovery', async () => {
    announceSelf()
    await triggerActiveDiscovery()
    return true
  })

  ipcMain.handle('lan:get-discovery-debug', () => {
    return getDiscoveryDebugSnapshot()
  })

  startDiscoveryService()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopDiscoveryService()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
