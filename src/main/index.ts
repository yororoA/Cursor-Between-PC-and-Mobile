import { app, shell, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { createSocket, type Socket } from 'dgram'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { existsSync } from 'fs'
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

type WireMessage =
  | { type: 'announce'; payload: DeviceRecord }
  | { type: 'query-info'; payload: { requesterId: string; targetId: string; requestId: string } }
  | {
      type: 'info-response'
      payload: { requestId: string; targetId: string; device: DeviceRecord }
    }
  | { type: 'discover-request'; payload: { requestId: string } }
  | { type: 'discover-response'; payload: { requestId: string; device: DeviceRecord } }

const DISCOVERY_PORT = 42425
const WEB_PAIR_PORT = 42426
const BROADCAST_ADDRESS = '255.255.255.255'
const ADB_SCAN_INTERVAL_MS = 3_000
const ADB_CONNECT_COOLDOWN_MS = 12_000
const ADB_DEFAULT_TCP_PORT = 5555
const ANNOUNCE_INTERVAL_MS = 3_000
const DISCOVERY_SWEEP_INTERVAL_MS = 12_000
const PEER_TTL_MS = 10_000
const WEB_PEER_PREFIX = 'web:'
const WEB_PEER_TTL_MS = 20_000

const localDeviceId = randomUUID()
const localDeviceName = os.hostname()

let mainWindowRef: BrowserWindow | null = null
let discoverySocket: Socket | null = null
let webPairServer: Server | null = null
let adbScanTimer: NodeJS.Timeout | null = null
let announceTimer: NodeJS.Timeout | null = null
let discoverySweepTimer: NodeJS.Timeout | null = null
let pruneTimer: NodeJS.Timeout | null = null

const udpPeers = new Map<string, DeviceRecord>()
const adbPeers = new Map<string, DeviceRecord>()
const webPeers = new Map<string, DeviceRecord>()
const pendingRequests = new Map<string, (device: DeviceRecord) => void>()
const adbConnectCooldown = new Map<string, number>()

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

function getAllPeers(): DeviceRecord[] {
  const merged = new Map<string, DeviceRecord>()
  for (const [id, item] of udpPeers.entries()) merged.set(id, item)
  for (const [id, item] of adbPeers.entries()) merged.set(id, item)
  for (const [id, item] of webPeers.entries()) merged.set(id, item)
  return Array.from(merged.values())
}

function emitDevicesUpdated(): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('lan:devices-updated', getAllPeers())
  }
}

function getDiscoveryDebugSnapshot(): DiscoveryDebugSnapshot {
  return {
    ...debugState,
    lastArpNeighbors: [...debugState.lastArpNeighbors],
    broadcastAddresses: [...debugState.broadcastAddresses],
    localAddresses: [...debugState.localAddresses]
  }
}

function createLocalDeviceRecord(): DeviceRecord {
  const display = screen.getPrimaryDisplay()
  const scaleFactor = display.scaleFactor > 0 ? display.scaleFactor : 1
  // Electron reports `display.size` in DIP, convert to real pixels for accurate comparison.
  const width = Math.max(1, Math.round(display.size.width * scaleFactor))
  const height = Math.max(1, Math.round(display.size.height * scaleFactor))
  const dpi = Math.max(96, Math.round(96 * scaleFactor))
  return {
    id: localDeviceId,
    name: localDeviceName,
    address: '',
    resolution: { width, height },
    dpi,
    lastSeen: Date.now()
  }
}

function getLocalIPv4Addresses(): string[] {
  const localAddresses = new Set<string>()
  const interfaces = os.networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue
    for (const item of entries) {
      if (item.family === 'IPv4' && item.address) localAddresses.add(item.address)
    }
  }
  return Array.from(localAddresses)
}

function getBroadcastAddressesFromInterfaces(): string[] {
  const networks = os.networkInterfaces()
  const addresses = new Set<string>([BROADCAST_ADDRESS])
  for (const entries of Object.values(networks)) {
    if (!entries) continue
    for (const item of entries) {
      if (item.family !== 'IPv4' || item.internal || !item.address || !item.netmask) continue
      const ipParts = item.address.split('.').map((part) => Number(part))
      const maskParts = item.netmask.split('.').map((part) => Number(part))
      if (ipParts.length !== 4 || maskParts.length !== 4) continue
      const broadcast = ipParts.map(
        (value, index) => (value & maskParts[index]) | (255 ^ maskParts[index])
      )
      addresses.add(broadcast.join('.'))
    }
  }
  return Array.from(addresses)
}

function normalizeRemoteAddress(address: string | undefined): string {
  if (!address) return ''
  if (address.startsWith('::ffff:')) return address.slice(7)
  if (address === '::1') return '127.0.0.1'
  return address
}

function getPairingInfo(): PairingInfo {
  const localAddresses = getLocalIPv4Addresses().filter((ip) => !ip.startsWith('169.254.'))
  return {
    port: WEB_PAIR_PORT,
    urls: localAddresses.map((ip) => `http://${ip}:${WEB_PAIR_PORT}/pair`)
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

function mergeWebPeer(nextPeer: DeviceRecord): void {
  if (!nextPeer.id) return
  webPeers.set(nextPeer.id, {
    ...nextPeer,
    lastSeen: Date.now()
  })
  emitDevicesUpdated()
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

      mergeWebPeer({
        id: `${WEB_PEER_PREFIX}${clientId}`,
        name: parsed.name?.trim() || 'Mobile Browser',
        address: remoteAddress,
        resolution: {
          width: Math.round(cssWidth * dpr),
          height: Math.round(cssHeight * dpr)
        },
        dpi: Math.round(160 * dpr),
        lastSeen: Date.now()
      })

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

function execPromise(command: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(command, { windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

function getAdbCandidates(): string[] {
  const candidates = ['adb']
  const resourceCandidates = [
    join(process.cwd(), 'resources', 'Android-platform-tools', 'adb.exe'),
    join(process.cwd(), 'resources', 'Android-platform-tools', 'platform-tools', 'adb.exe'),
    join(app.getAppPath(), 'resources', 'Android-platform-tools', 'adb.exe'),
    join(app.getAppPath(), 'resources', 'Android-platform-tools', 'platform-tools', 'adb.exe'),
    join(process.resourcesPath, 'Android-platform-tools', 'adb.exe'),
    join(process.resourcesPath, 'Android-platform-tools', 'platform-tools', 'adb.exe')
  ].filter((item) => existsSync(item))

  const windowsCandidates = [
    process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}\\platform-tools\\adb.exe` : '',
    process.env.ANDROID_SDK_ROOT ? `${process.env.ANDROID_SDK_ROOT}\\platform-tools\\adb.exe` : '',
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`
      : ''
  ].filter(Boolean)

  return process.platform === 'win32'
    ? [...new Set([...candidates, ...resourceCandidates, ...windowsCandidates])]
    : [...new Set([...candidates, ...resourceCandidates])]
}

async function resolveAdbCommand(): Promise<string | null> {
  for (const candidate of getAdbCandidates()) {
    const probe = await execPromise(`"${candidate}" version`)
    if (probe.ok) return candidate
  }
  return null
}

function parseAdbSerials(output: string): string[] {
  const serials: string[] = []
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (const line of lines) {
    if (line.startsWith('List of devices attached')) continue
    const segments = line.split(/\s+/)
    const serial = segments[0]
    const state = segments[1]
    if (!serial || state !== 'device') continue
    if (serial) serials.push(serial)
  }
  return serials
}

function isIPv4Address(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false
    const num = Number(part)
    return num >= 0 && num <= 255
  })
}

function normalizeAdbConnectTarget(raw: string): string | null {
  const text = raw.trim().replace(/^adb:/, '')
  if (!text) return null

  if (text.includes(':')) {
    const [host, portRaw] = text.split(':')
    const port = Number(portRaw)
    if (!host || !isIPv4Address(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      return null
    }
    return `${host}:${port}`
  }

  if (!isIPv4Address(text)) return null
  return `${text}:${ADB_DEFAULT_TCP_PORT}`
}

function collectLanAdbConnectTargets(currentSerials: Set<string>): string[] {
  const targets = new Set<string>()
  const allPeers = [...udpPeers.values(), ...webPeers.values()]

  for (const peer of allPeers) {
    const normalized = normalizeAdbConnectTarget(peer.address)
    if (!normalized) continue
    if (currentSerials.has(normalized)) continue
    targets.add(normalized)
  }

  return Array.from(targets)
}

function shouldTryAdbConnect(target: string): boolean {
  const now = Date.now()
  const previous = adbConnectCooldown.get(target) || 0
  if (now - previous < ADB_CONNECT_COOLDOWN_MS) return false
  adbConnectCooldown.set(target, now)
  return true
}

async function connectAdbTarget(
  adb: string,
  targetRaw: string
): Promise<{ ok: boolean; target: string; message: string }> {
  const target = normalizeAdbConnectTarget(targetRaw)
  if (!target) {
    return {
      ok: false,
      target: targetRaw,
      message: '目标地址无效，请使用 IPv4 或 IPv4:端口，例如 192.168.1.22:5555'
    }
  }

  const result = await execPromise(`"${adb}" connect "${target}"`)
  const output = `${result.stdout}\n${result.stderr}`.trim()
  const ok = /connected to|already connected to/i.test(output)
  return {
    ok,
    target,
    message: output || (ok ? `connected to ${target}` : `failed to connect to ${target}`)
  }
}

async function connectLanPeersThroughAdb(
  adb: string,
  currentSerials: Set<string>
): Promise<number> {
  const candidates = collectLanAdbConnectTargets(currentSerials).filter((target) =>
    shouldTryAdbConnect(target)
  )
  if (candidates.length === 0) return 0

  const attempts = await Promise.all(candidates.map((target) => connectAdbTarget(adb, target)))
  const failed = attempts.filter((item) => !item.ok)
  if (failed.length > 0) {
    debugState.lastError = failed[failed.length - 1].message
  }
  return attempts.filter((item) => item.ok).length
}

function parseResolution(raw: string): { width: number; height: number } {
  const match = raw.match(/(\d+)x(\d+)/)
  if (!match) return { width: 1080, height: 1920 }
  return { width: Number(match[1] || 1080), height: Number(match[2] || 1920) }
}

function parseDpi(raw: string): number {
  const match = raw.match(/(\d{2,4})/)
  if (!match) return 420
  return Number(match[1] || 420)
}

async function readAdbDevice(adb: string, serial: string): Promise<DeviceRecord> {
  const [model, size, density] = await Promise.all([
    execPromise(`"${adb}" -s "${serial}" shell getprop ro.product.model`),
    execPromise(`"${adb}" -s "${serial}" shell wm size`),
    execPromise(`"${adb}" -s "${serial}" shell wm density`)
  ])

  const resolution = parseResolution(size.stdout)
  const dpi = parseDpi(density.stdout)

  return {
    id: serial,
    name: model.stdout.trim() || `Android (${serial})`,
    address: `adb:${serial}`,
    resolution,
    dpi,
    lastSeen: Date.now()
  }
}

async function refreshAdbDevices(): Promise<void> {
  debugState.lastSweepAt = Date.now()
  debugState.discoverRequestSentCount += 1

  const adb = await resolveAdbCommand()
  if (!adb) {
    adbPeers.clear()
    debugState.lastError = 'adb not found in PATH or Android SDK platform-tools'
    emitDevicesUpdated()
    return
  }

  await execPromise(`"${adb}" start-server`)
  let result = await execPromise(`"${adb}" devices -l`)
  debugState.lastArpReadAt = Date.now()
  debugState.lastError = result.ok ? '' : result.stderr || 'adb devices failed'

  let serials = parseAdbSerials(result.stdout)
  const connectedCount = await connectLanPeersThroughAdb(adb, new Set(serials))
  if (connectedCount > 0) {
    const refreshedResult = await execPromise(`"${adb}" devices -l`)
    if (refreshedResult.ok || !result.ok) {
      result = refreshedResult
      debugState.lastError = result.ok ? '' : result.stderr || 'adb devices failed'
      serials = parseAdbSerials(result.stdout)
    }
  }

  debugState.lastArpNeighborCount = serials.length
  debugState.lastArpNeighbors = serials
  if (serials.length > 0) {
    debugState.lastIncomingAt = Date.now()
    debugState.lastIncomingFrom = serials[0]
    debugState.discoverResponseReceivedCount += 1
  }

  const nextMap = new Map<string, DeviceRecord>()
  const deviceResults = await Promise.all(serials.map((serial) => readAdbDevice(adb, serial)))
  for (const item of deviceResults) nextMap.set(item.id, item)

  let changed = adbPeers.size !== nextMap.size
  if (!changed) {
    for (const [id, value] of nextMap.entries()) {
      const current = adbPeers.get(id)
      if (!current) {
        changed = true
        break
      }
      if (
        current.name !== value.name ||
        current.address !== value.address ||
        current.dpi !== value.dpi ||
        current.resolution.width !== value.resolution.width ||
        current.resolution.height !== value.resolution.height
      ) {
        changed = true
        break
      }
    }
  }

  adbPeers.clear()
  for (const [id, value] of nextMap.entries()) adbPeers.set(id, value)
  if (changed) emitDevicesUpdated()
}

function mergeUdpPeer(nextPeer: DeviceRecord): void {
  if (!nextPeer.id || nextPeer.id === localDeviceId) return
  udpPeers.set(nextPeer.id, { ...nextPeer, lastSeen: Date.now() })
  emitDevicesUpdated()
}

function sendWireMessage(message: WireMessage, address = BROADCAST_ADDRESS): void {
  if (!discoverySocket) return
  const content = Buffer.from(JSON.stringify(message), 'utf-8')
  discoverySocket.send(content, DISCOVERY_PORT, address)
  if (message.type === 'announce') debugState.announceSentCount += 1
  if (message.type === 'discover-request') debugState.discoverRequestSentCount += 1
  if (message.type === 'discover-response') debugState.discoverResponseSentCount += 1
}

function announceSelf(): void {
  debugState.lastAnnounceAt = Date.now()
  debugState.localAddresses = getLocalIPv4Addresses()
  const announceMessage: WireMessage = { type: 'announce', payload: createLocalDeviceRecord() }
  const broadcastAddresses = getBroadcastAddressesFromInterfaces()
  debugState.broadcastAddresses = broadcastAddresses
  for (const address of broadcastAddresses) sendWireMessage(announceMessage, address)
}

async function triggerActiveDiscovery(): Promise<void> {
  if (!discoverySocket) return
  debugState.lastSweepAt = Date.now()
  const requestId = randomUUID()
  const probe: WireMessage = { type: 'discover-request', payload: { requestId } }
  const broadcastAddresses = getBroadcastAddressesFromInterfaces()
  debugState.broadcastAddresses = broadcastAddresses
  for (const address of broadcastAddresses) sendWireMessage(probe, address)
}

function handleWireMessage(raw: Buffer, remoteAddressRaw: string): void {
  let parsed: WireMessage | null = null
  try {
    parsed = JSON.parse(raw.toString('utf-8')) as WireMessage
  } catch {
    return
  }
  if (!parsed) return

  const remoteAddress = normalizeRemoteAddress(remoteAddressRaw)
  debugState.lastIncomingAt = Date.now()
  debugState.lastIncomingFrom = remoteAddress

  if (parsed.type === 'announce') {
    debugState.announceReceivedCount += 1
    mergeUdpPeer({ ...parsed.payload, address: remoteAddress, lastSeen: Date.now() })
    return
  }

  if (parsed.type === 'discover-request') {
    debugState.discoverRequestReceivedCount += 1
    sendWireMessage(
      {
        type: 'discover-response',
        payload: { requestId: parsed.payload.requestId, device: createLocalDeviceRecord() }
      },
      remoteAddress
    )
    return
  }

  if (parsed.type === 'discover-response') {
    debugState.discoverResponseReceivedCount += 1
    mergeUdpPeer({ ...parsed.payload.device, address: remoteAddress, lastSeen: Date.now() })
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

  if (parsed.type === 'info-response') {
    if (parsed.payload.targetId !== localDeviceId) return
    debugState.infoResponseReceivedCount += 1
    const remoteDevice = { ...parsed.payload.device, address: remoteAddress, lastSeen: Date.now() }
    mergeUdpPeer(remoteDevice)
    const resolve = pendingRequests.get(parsed.payload.requestId)
    if (resolve) {
      pendingRequests.delete(parsed.payload.requestId)
      resolve(remoteDevice)
    }
  }
}

function pruneUdpPeers(): void {
  const now = Date.now()
  let changed = false
  for (const [id, peer] of udpPeers.entries()) {
    if (now - peer.lastSeen > PEER_TTL_MS) {
      udpPeers.delete(id)
      changed = true
    }
  }
  if (changed) emitDevicesUpdated()
}

function pruneWebPeers(): void {
  const now = Date.now()
  let changed = false
  for (const [id, peer] of webPeers.entries()) {
    if (now - peer.lastSeen > WEB_PEER_TTL_MS) {
      webPeers.delete(id)
      changed = true
    }
  }
  if (changed) emitDevicesUpdated()
}

function startUdpDiscovery(): void {
  const socket = createSocket({ type: 'udp4', reuseAddr: true })
  discoverySocket = socket
  socket.on('message', (msg, remote) => handleWireMessage(msg, remote.address))
  socket.on('error', (error) => {
    debugState.lastError = String(error)
  })
  socket.bind(DISCOVERY_PORT, () => {
    socket.setBroadcast(true)
    announceSelf()
    void triggerActiveDiscovery()
  })

  announceTimer = setInterval(announceSelf, ANNOUNCE_INTERVAL_MS)
  discoverySweepTimer = setInterval(() => {
    void triggerActiveDiscovery()
  }, DISCOVERY_SWEEP_INTERVAL_MS)
  pruneTimer = setInterval(() => {
    pruneUdpPeers()
    pruneWebPeers()
  }, 1_500)
}

function stopUdpDiscovery(): void {
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
  udpPeers.clear()
}

function startAdbDiscovery(): void {
  void refreshAdbDevices().catch((error) => {
    debugState.lastError = String(error)
  })
  adbScanTimer = setInterval(() => {
    void refreshAdbDevices().catch((error) => {
      debugState.lastError = String(error)
    })
  }, ADB_SCAN_INTERVAL_MS)
}

function stopAdbDiscovery(): void {
  if (adbScanTimer) {
    clearInterval(adbScanTimer)
    adbScanTimer = null
  }
  adbPeers.clear()
}

async function requestPeerInfo(deviceId: string): Promise<DeviceRecord | null> {
  const adb = adbPeers.get(deviceId)
  if (adb) return adb

  const web = webPeers.get(deviceId)
  if (web) return web

  const knownUdp = udpPeers.get(deviceId)
  if (!knownUdp) return null

  const requestId = randomUUID()
  const responsePromise = new Promise<DeviceRecord | null>((resolve) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId)
      resolve(udpPeers.get(deviceId) ?? null)
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
    knownUdp.address || BROADCAST_ADDRESS
  )

  return responsePromise
}

function createWindow(): void {
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

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('lan:get-devices', () => {
    return getAllPeers().sort((a, b) => a.name.localeCompare(b.name))
  })

  ipcMain.handle('lan:get-local-device', () => createLocalDeviceRecord())

  ipcMain.handle('lan:request-device-info', async (_event, deviceId: string) => {
    return requestPeerInfo(deviceId)
  })

  ipcMain.handle('lan:refresh-discovery', async () => {
    announceSelf()
    await Promise.allSettled([triggerActiveDiscovery(), refreshAdbDevices()])
    return true
  })

  ipcMain.handle('lan:get-discovery-debug', () => {
    return getDiscoveryDebugSnapshot()
  })

  ipcMain.handle('lan:get-pairing-info', () => {
    return getPairingInfo()
  })

  ipcMain.handle('lan:adb-connect', async (_event, target: string) => {
    const adb = await resolveAdbCommand()
    if (!adb) {
      return {
        ok: false,
        target,
        message: 'adb 不可用，请先安装 Android Platform Tools 或将 adb 加入 PATH'
      }
    }
    await execPromise(`"${adb}" start-server`)
    const result = await connectAdbTarget(adb, target)
    await refreshAdbDevices()
    return result
  })

  startUdpDiscovery()
  startAdbDiscovery()
  startWebPairService()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopUdpDiscovery()
  stopAdbDiscovery()
  stopWebPairService()
})
