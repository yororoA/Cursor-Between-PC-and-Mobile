import { app, shell, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { createSocket, type Socket } from 'dgram'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
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

type PairingInfo = {
  port: number
  urls: string[]
}

type BrowserHelloPayload = {
  clientId?: string
  name?: string
  width?: number
  height?: number
  dpr?: number
  userAgent?: string
}

function isLikelyMobileUserAgent(userAgent: string): boolean {
  return /android|iphone|ipad|ipod|mobile/i.test(userAgent)
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
const WEB_PAIR_PORT = 42426
const BROADCAST_ADDRESS = '255.255.255.255'
const ANNOUNCE_INTERVAL_MS = 3_000
const DISCOVERY_SWEEP_INTERVAL_MS = 12_000
const PEER_TTL_MS = 10_000
const WEB_PEER_PREFIX = 'web:'

const localDeviceId = randomUUID()
const localDeviceName = os.hostname()

let mainWindowRef: BrowserWindow | null = null
let discoverySocket: Socket | null = null
let webPairServer: Server | null = null
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
    broadcastAddresses: [...debugState.broadcastAddresses],
    localAddresses: [...debugState.localAddresses]
  }
}

function normalizeRemoteAddress(address: string | undefined): string {
  if (!address) return ''
  if (address.startsWith('::ffff:')) return address.slice(7)
  if (address === '::1') return '127.0.0.1'
  return address
}

function getPairingInfo(): PairingInfo {
  const localAddresses = getLocalIPv4Addresses().filter((ip) => !ip.startsWith('169.254.'))
  const urls = localAddresses.map((ip) => `http://${ip}:${WEB_PAIR_PORT}/pair`)
  return {
    port: WEB_PAIR_PORT,
    urls
  }
}

function createPairPageHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Device Bridge Pair</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; margin: 0; padding: 20px; background: #0f1720; color: #f3f6fa; }
    .card { max-width: 560px; margin: 0 auto; border: 1px solid #2a3a4c; border-radius: 14px; padding: 16px; background: #152231; }
    h1 { margin: 0 0 10px; font-size: 22px; }
    p { margin: 8px 0; color: #d3deea; }
    .ok { color: #7ce0ab; }
    .meta { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: #9fc0dc; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Phone Connected</h1>
    <p>Keep this page open. This phone will appear in the desktop app device list.</p>
    <p id="status" class="ok">Connecting...</p>
    <p id="meta" class="meta"></p>
  </div>
  <script>
    const key = 'bridge-client-id';
    let clientId = localStorage.getItem(key);
    if (!clientId) {
      clientId = (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : String(Date.now()) + String(Math.random()).slice(2);
      localStorage.setItem(key, clientId);
    }

    const statusEl = document.getElementById('status');
    const metaEl = document.getElementById('meta');

    async function ping() {
      const payload = {
        clientId,
        name: navigator.userAgent.includes('iPhone') ? 'iPhone' : navigator.userAgent.includes('Android') ? 'Android Phone' : 'Mobile Browser',
        width: window.screen.width,
        height: window.screen.height,
        dpr: window.devicePixelRatio || 1,
        userAgent: navigator.userAgent
      };

      metaEl.textContent = JSON.stringify(payload);
      try {
        const response = await fetch('/api/hello', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        statusEl.textContent = response.ok ? 'Connected to desktop app' : 'Connection failed';
      } catch (error) {
        statusEl.textContent = 'Connection failed';
      }
    }

    ping();
    setInterval(ping, 3000);
  </script>
</body>
</html>`
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.end(JSON.stringify(payload))
}

function handlePairHello(req: IncomingMessage, res: ServerResponse): void {
  let raw = ''
  req.setEncoding('utf-8')

  req.on('data', (chunk) => {
    raw += chunk
    if (raw.length > 12_000) {
      raw = ''
      writeJson(res, 413, { ok: false })
      req.destroy()
    }
  })

  req.on('end', () => {
    try {
      const parsed = JSON.parse(raw) as BrowserHelloPayload
      const cssWidth = Math.max(1, Number(parsed.width) || 1)
      const cssHeight = Math.max(1, Number(parsed.height) || 1)
      const dpr = Math.max(0.75, Number(parsed.dpr) || 1)
      const clientId = (parsed.clientId || randomUUID()).replace(/[^a-zA-Z0-9-_]/g, '')
      const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress)
      const userAgent = String(parsed.userAgent || '')
      const mobileUA = isLikelyMobileUserAgent(userAgent)
      const resolutionWidth = Math.round(cssWidth * dpr)
      const resolutionHeight = Math.round(cssHeight * dpr)

      // Web APIs expose CSS pixels, so convert with DPR and use a mobile-friendly baseline PPI.
      const dpi = Math.round((mobileUA ? 160 : 96) * dpr)

      const peer: DeviceRecord = {
        id: `${WEB_PEER_PREFIX}${clientId}`,
        name: parsed.name?.trim() || 'Mobile Browser',
        address: remoteAddress,
        resolution: {
          width: resolutionWidth,
          height: resolutionHeight
        },
        dpi,
        lastSeen: Date.now()
      }

      mergePeer(peer)
      writeJson(res, 200, { ok: true })
    } catch {
      writeJson(res, 400, { ok: false })
    }
  })
}

function startWebPairService(): void {
  const server = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 404
      res.end('Not Found')
      return
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.end()
      return
    }

    if (req.method === 'GET' && req.url === '/pair') {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(createPairPageHtml())
      return
    }

    if (req.method === 'POST' && req.url === '/api/hello') {
      handlePairHello(req, res)
      return
    }

    res.statusCode = 404
    res.end('Not Found')
  })

  server.on('error', (error) => {
    debugState.lastError = String(error)
    console.error('Pair service error:', error)
  })

  server.listen(WEB_PAIR_PORT)
  webPairServer = server
}

function stopWebPairService(): void {
  if (webPairServer) {
    webPairServer.close()
    webPairServer = null
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
  if (deviceId.startsWith(WEB_PEER_PREFIX)) return known

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

  ipcMain.handle('lan:get-pairing-info', () => {
    return getPairingInfo()
  })

  startDiscoveryService()
  startWebPairService()

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
  stopWebPairService()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
