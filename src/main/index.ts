import { app, shell, BrowserWindow, ipcMain, screen, desktopCapturer, session } from 'electron'
import { join } from 'path'
import { createSocket, type Socket } from 'dgram'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'http'
import { existsSync, readFileSync, unlinkSync } from 'fs'
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

type ProjectionStartResult = {
  ok: boolean
  sessionId: string
  targetDeviceId: string
  message: string
}

type ProjectionPushResult = {
  ok: boolean
  sessionId: string
  frameId: number
  message: string
}

type ProjectionStatusSnapshot = {
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

type ProjectionPushPayload = {
  imageDataUrl: string
  overlap: {
    width: number
    height: number
    left: number
    top: number
  }
}

type ProjectionAckPayload = {
  clientId?: string
  sessionId?: string
  frameId?: number
  renderedAt?: number
}

type ProjectionSession = {
  sessionId: string
  targetDeviceId: string
  targetClientId: string
  transport: 'web-pull' | 'lan-push'
  targetAddress: string
  active: boolean
  lastFrameId: number
  lastSentAt: number
  lastAckFrameId: number
  lastAckAt: number
  waitingAckFrameId: number
  ackTimer: NodeJS.Timeout | null
  status: ProjectionStatusSnapshot['status']
  lastMessage: string
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

type IncomingProjectionFramePayload = {
  sessionId?: string
  frameId?: number
  imageDataUrl?: string
  overlap?: {
    width: number
    height: number
    left: number
    top: number
  }
  sentAt?: number
}

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
const PROJECTION_ACK_TIMEOUT_MS = 2_000

const localDeviceId = randomUUID()
const localDeviceName = os.hostname()

let mainWindowRef: BrowserWindow | null = null
let receiverWindowRef: BrowserWindow | null = null
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
const projectionStreams = new Map<string, ServerResponse>()
const projectionSessions = new Map<string, ProjectionSession>()
let receiverAutoCloseTimer: NodeJS.Timeout | null = null
let latestIncomingProjectionFrame: {
  sessionId: string
  frameId: number
  imageDataUrl: string
  overlap: {
    width: number
    height: number
    left: number
    top: number
  }
  sentAt: number
} | null = null

const RECEIVER_IDLE_CLOSE_MS = 6_000

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

async function capturePrimaryDisplayFrame(): Promise<{
  ok: boolean
  imageDataUrl: string
  width: number
  height: number
  message: string
}> {
  const windowsApiResult = await capturePrimaryDisplayFrameViaWindowsApi()
  if (windowsApiResult?.ok) return windowsApiResult

  try {
    const display = screen.getPrimaryDisplay()
    const scaleFactor = display.scaleFactor > 0 ? display.scaleFactor : 1
    const captureWidth = Math.max(320, Math.round(display.size.width * scaleFactor))
    const captureHeight = Math.max(200, Math.round(display.size.height * scaleFactor))

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: captureWidth,
        height: captureHeight
      }
    })

    const primaryDisplayId = String(display.id)
    const source =
      sources.find((item) => item.display_id === primaryDisplayId) ||
      sources.find((item) => Boolean(item.display_id)) ||
      sources[0]

    if (!source || source.thumbnail.isEmpty()) {
      return {
        ok: false,
        imageDataUrl: '',
        width: 0,
        height: 0,
        message: '主屏截图失败：未获取到可用屏幕源'
      }
    }

    const size = source.thumbnail.getSize()
    return {
      ok: true,
      imageDataUrl: source.thumbnail.toDataURL(),
      width: size.width,
      height: size.height,
      message: 'ok'
    }
  } catch (error) {
    return {
      ok: false,
      imageDataUrl: '',
      width: 0,
      height: 0,
      message: `主屏截图异常: ${String(error)}`
    }
  }
}

async function capturePrimaryDisplayFrameViaWindowsApi(): Promise<{
  ok: boolean
  imageDataUrl: string
  width: number
  height: number
  message: string
} | null> {
  if (process.platform !== 'win32') return null

  const tempPath = join(
    os.tmpdir(),
    `cursor-bridge-capture-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`
  )

  const escapedTempPath = tempPath.replace(/'/g, "''")
  const psScript = [
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class NativeCursor { [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; } [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; } public const int CURSOR_SHOWING = 0x00000001; public const uint DI_NORMAL = 0x0003; [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci); [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int xLeft, int yTop, IntPtr hIcon, int cxWidth, int cyWidth, int istepIfAniCur, IntPtr hbrFlickerFreeDraw, uint diFlags); }\'',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
    '$ci = New-Object NativeCursor+CURSORINFO',
    "$ci.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'NativeCursor+CURSORINFO')",
    'if ([NativeCursor]::GetCursorInfo([ref]$ci) -and (($ci.flags -band [NativeCursor]::CURSOR_SHOWING) -ne 0)) { $cx = $ci.ptScreenPos.X - $bounds.X; $cy = $ci.ptScreenPos.Y - $bounds.Y; if ($cx -ge 0 -and $cy -ge 0 -and $cx -lt $bounds.Width -and $cy -lt $bounds.Height) { $hdc = $g.GetHdc(); [NativeCursor]::DrawIconEx($hdc, $cx, $cy, $ci.hCursor, 0, 0, 0, [IntPtr]::Zero, [NativeCursor]::DI_NORMAL) | Out-Null; $g.ReleaseHdc($hdc) } }',
    `$bmp.Save('${escapedTempPath}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose()',
    '$bmp.Dispose()',
    'Write-Output ("{0},{1}" -f $bounds.Width, $bounds.Height)'
  ].join('; ')

  const command = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${psScript.replace(/"/g, '\\"')}"`
  const result = await execPromise(command)

  try {
    if (!existsSync(tempPath)) {
      return {
        ok: false,
        imageDataUrl: '',
        width: 0,
        height: 0,
        message: result.stderr || 'Windows 截图 API 未生成图像文件'
      }
    }

    const output = `${result.stdout}`.trim()
    const [wRaw, hRaw] = output.split(',')
    const width = Math.max(1, Number(wRaw) || 0)
    const height = Math.max(1, Number(hRaw) || 0)
    const imageDataUrl = `data:image/png;base64,${readFileSync(tempPath).toString('base64')}`

    return {
      ok: true,
      imageDataUrl,
      width,
      height,
      message: 'ok'
    }
  } catch (error) {
    return {
      ok: false,
      imageDataUrl: '',
      width: 0,
      height: 0,
      message: `Windows 截图 API 读取失败: ${String(error)}`
    }
  } finally {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath)
    } catch {
      // ignore cleanup error
    }
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
    html, body { width: 100%; height: 100%; }
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; margin: 0; background: #000; color: #f3f6fa; overflow: hidden; }
    #projection { position: fixed; inset: 0; width: 100vw; height: 100vh; object-fit: contain; background: #000; }
    .hud { position: fixed; left: 10px; right: 10px; top: 10px; z-index: 2; display: grid; gap: 8px; pointer-events: none; }
    .pill { width: fit-content; max-width: 96vw; padding: 8px 10px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.24); background: rgba(8, 18, 28, 0.72); backdrop-filter: blur(8px); font-size: 12px; }
    .ok { color: #7ce0ab; }
    .warn { color: #ffd17a; }
    .bad { color: #ff9a9a; }
    .meta { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #9fc0dc; word-break: break-all; }
    .caption { color: #b8d4ec; }
    .controls { display: flex; gap: 8px; pointer-events: auto; }
    .btn { border: 1px solid rgba(255,255,255,0.25); background: rgba(255,255,255,0.12); color: #fff; border-radius: 9px; padding: 8px 10px; font-size: 12px; }
    body.has-frame .meta { display: none; }
  </style>
</head>
<body>
  <img id="projection" alt="Projection Frame" />
  <div class="hud">
    <div id="status" class="pill ok">Connecting...</div>
    <div id="stream" class="pill warn">Projection stream: waiting...</div>
    <div id="caption" class="pill caption">No projection frame yet</div>
    <div id="meta" class="pill meta"></div>
    <div class="controls">
      <button id="fullscreenBtn" class="btn" type="button">进入全屏</button>
    </div>
  </div>
  <script>
    const key = 'bridge-client-id';
    let clientId = localStorage.getItem(key);
    if (!clientId) {
      clientId = (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : String(Date.now()) + String(Math.random()).slice(2);
      localStorage.setItem(key, clientId);
    }

    const statusEl = document.getElementById('status');
    const streamEl = document.getElementById('stream');
    const metaEl = document.getElementById('meta');
    const projectionEl = document.getElementById('projection');
    const captionEl = document.getElementById('caption');
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    let hasFrame = false;
    let source = null;

    function tryEnterFullscreen() {
      const el = document.documentElement;
      if (!el || document.fullscreenElement) return;
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(function () {});
      }
    }

    if (fullscreenBtn) {
      fullscreenBtn.addEventListener('click', function () {
        tryEnterFullscreen();
      });
    }

    projectionEl.addEventListener('dblclick', function () {
      tryEnterFullscreen();
    });

    function postAck(sessionId, frameId) {
      return fetch('/api/projection/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          sessionId,
          frameId,
          renderedAt: Date.now()
        })
      });
    }

    function openProjectionStream() {
      if (source) {
        source.close();
      }
      source = new EventSource('/api/projection/stream?clientId=' + encodeURIComponent(clientId));
      source.onopen = function () {
        streamEl.className = 'ok';
        streamEl.textContent = 'Projection stream: online';
      };
      source.onerror = function () {
        streamEl.className = 'bad';
        streamEl.textContent = 'Projection stream: disconnected, retrying...';
      };

      source.addEventListener('projection-frame', async function (event) {
        try {
          const data = JSON.parse(event.data || '{}');
          const sessionId = data.sessionId || '';
          const frameId = Number(data.frameId || 0);
          const imageDataUrl = data.imageDataUrl || '';

          if (imageDataUrl) {
            if (!hasFrame) {
              hasFrame = true;
              document.body.classList.add('has-frame');
            }
            projectionEl.src = imageDataUrl;
            captionEl.textContent = 'Session ' + sessionId.slice(0, 8) + ' frame #' + frameId;
          }
          await postAck(sessionId, frameId);
        } catch (error) {
          captionEl.textContent = 'Frame parse error';
        }
      });
    }

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
        if (response.ok) {
          openProjectionStream();
        }
      } catch (error) {
        statusEl.textContent = 'Connection failed';
      }
    }

    ping();
    setInterval(ping, 3000);
    window.addEventListener('beforeunload', function () {
      if (source) source.close();
    });
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

function toProjectionStatusSnapshot(session: ProjectionSession): ProjectionStatusSnapshot {
  const streamOnline =
    session.transport === 'web-pull'
      ? projectionStreams.has(session.targetClientId)
      : session.status !== 'offline'

  return {
    sessionId: session.sessionId,
    targetDeviceId: session.targetDeviceId,
    targetClientId: session.targetClientId,
    active: session.active,
    streamOnline,
    lastFrameId: session.lastFrameId,
    lastSentAt: session.lastSentAt,
    lastAckFrameId: session.lastAckFrameId,
    lastAckAt: session.lastAckAt,
    waitingAck: session.waitingAckFrameId > session.lastAckFrameId,
    status: session.status,
    lastMessage: session.lastMessage
  }
}

function emitProjectionStatus(session: ProjectionSession): void {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return
  mainWindowRef.webContents.send('lan:projection-status', toProjectionStatusSnapshot(session))
}

function ensureReceiverWindow(): void {
  if (receiverWindowRef && !receiverWindowRef.isDestroyed()) {
    if (!receiverWindowRef.isVisible()) receiverWindowRef.show()
    receiverWindowRef.focus()
    return
  }

  const receiverWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    fullscreen: true,
    frame: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      sandbox: false
    }
  })

  receiverWindowRef = receiverWindow
  receiverWindow.on('ready-to-show', () => {
    receiverWindow.show()
    receiverWindow.setFullScreen(true)
    receiverWindow.setContentProtection(true)
    receiverWindow.focus()
  })
  receiverWindow.on('closed', () => {
    if (receiverWindowRef === receiverWindow) receiverWindowRef = null
  })

  receiverWindow.loadURL(`http://127.0.0.1:${WEB_PAIR_PORT}/pair?receiver=1`)
}

function scheduleReceiverWindowAutoClose(): void {
  if (receiverAutoCloseTimer) {
    clearTimeout(receiverAutoCloseTimer)
    receiverAutoCloseTimer = null
  }

  receiverAutoCloseTimer = setTimeout(() => {
    if (receiverWindowRef && !receiverWindowRef.isDestroyed()) {
      receiverWindowRef.close()
    }
    receiverAutoCloseTimer = null
  }, RECEIVER_IDLE_CLOSE_MS)
}

function sendSseEvent(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function clearSessionAckTimer(session: ProjectionSession): void {
  if (session.ackTimer) {
    clearTimeout(session.ackTimer)
    session.ackTimer = null
  }
}

function stopProjectionSession(session: ProjectionSession, message: string): void {
  clearSessionAckTimer(session)
  session.active = false
  session.status = 'stopped'
  session.lastMessage = message
  emitProjectionStatus(session)

  if (session.transport === 'lan-push' && session.targetAddress) {
    void notifyLanReceiverStop(session.targetAddress, session.sessionId)
  }
}

function markProjectionStreamOffline(clientId: string): void {
  for (const session of projectionSessions.values()) {
    if (!session.active || session.transport !== 'web-pull') continue
    if (session.targetClientId !== clientId) continue
    session.status = 'offline'
    session.lastMessage = '目标设备投映通道已断开'
    clearSessionAckTimer(session)
    emitProjectionStatus(session)
  }
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

function startProjectionSession(targetDeviceId: string): ProjectionStartResult {
  const isWebTarget = targetDeviceId.startsWith(WEB_PEER_PREFIX)
  const udpTarget = udpPeers.get(targetDeviceId)

  if (!isWebTarget && !udpTarget) {
    return {
      ok: false,
      sessionId: '',
      targetDeviceId,
      message: '目标设备不可用，请确认局域网设备在线并已打开接收端'
    }
  }

  const targetClientId = isWebTarget ? targetDeviceId.slice(WEB_PEER_PREFIX.length) : targetDeviceId
  const targetAddress = isWebTarget ? '' : normalizeRemoteAddress(udpTarget?.address)
  if (!isWebTarget && !isIPv4Address(targetAddress)) {
    return {
      ok: false,
      sessionId: '',
      targetDeviceId,
      message: '目标设备地址无效，无法建立局域网投映'
    }
  }

  const sessionId = randomUUID()
  const online = isWebTarget ? projectionStreams.has(targetClientId) : true
  const session: ProjectionSession = {
    sessionId,
    targetDeviceId,
    targetClientId,
    transport: isWebTarget ? 'web-pull' : 'lan-push',
    targetAddress,
    active: true,
    lastFrameId: 0,
    lastSentAt: 0,
    lastAckFrameId: 0,
    lastAckAt: 0,
    waitingAckFrameId: 0,
    ackTimer: null,
    status: online ? 'idle' : 'offline',
    lastMessage: isWebTarget
      ? online
        ? '投映会话已建立，等待发送帧'
        : '目标设备未打开投映通道，请保持 /pair 页面前台'
      : '局域网投映会话已建立，发送端将直接推送到目标设备'
  }

  projectionSessions.set(sessionId, session)
  emitProjectionStatus(session)

  return {
    ok: true,
    sessionId,
    targetDeviceId,
    message: session.lastMessage
  }
}

function postProjectionFrameToLanReceiver(
  targetAddress: string,
  payload: {
    sessionId: string
    frameId: number
    imageDataUrl: string
    overlap: { width: number; height: number; left: number; top: number }
    sentAt: number
  }
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload)
    const req = httpRequest(
      {
        host: targetAddress,
        port: WEB_PAIR_PORT,
        path: '/api/projection/push',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 1800
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf-8')
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => {
          const statusOk = (res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300
          resolve({
            ok: statusOk,
            message: statusOk ? '局域网投映已送达' : raw || `HTTP ${res.statusCode || 500}`
          })
        })
      }
    )

    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })

    req.on('error', (error) => {
      resolve({ ok: false, message: `局域网投映失败: ${String(error)}` })
    })

    req.write(body)
    req.end()
  })
}

function notifyLanReceiverStop(targetAddress: string, sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ sessionId })
    const req = httpRequest({
      host: targetAddress,
      port: WEB_PAIR_PORT,
      path: '/api/projection/stop',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 1200
    })

    req.on('timeout', () => {
      req.destroy()
      resolve()
    })
    req.on('error', () => {
      resolve()
    })
    req.on('response', () => {
      resolve()
    })
    req.write(body)
    req.end()
  })
}

async function pushProjectionFrame(
  sessionId: string,
  payload: ProjectionPushPayload
): Promise<ProjectionPushResult> {
  const session = projectionSessions.get(sessionId)
  if (!session || !session.active) {
    return {
      ok: false,
      sessionId,
      frameId: 0,
      message: '投映会话不存在或已关闭'
    }
  }

  clearSessionAckTimer(session)
  const nextFrameId = session.lastFrameId + 1
  session.lastFrameId = nextFrameId
  session.lastSentAt = Date.now()
  session.waitingAckFrameId = nextFrameId
  if (session.transport === 'web-pull') {
    session.status = 'waiting-ack'
    session.lastMessage = `已发送帧 #${nextFrameId}，等待目标设备 ACK`
  }

  if (session.transport === 'lan-push') {
    const result = await postProjectionFrameToLanReceiver(session.targetAddress, {
      sessionId: session.sessionId,
      frameId: nextFrameId,
      imageDataUrl: payload.imageDataUrl,
      overlap: payload.overlap,
      sentAt: session.lastSentAt
    })

    if (result.ok) {
      session.lastAckFrameId = nextFrameId
      session.lastAckAt = Date.now()
      session.status = 'receiving'
      session.lastMessage = `目标设备已接收帧 #${nextFrameId}`
      emitProjectionStatus(session)
      return {
        ok: true,
        sessionId,
        frameId: nextFrameId,
        message: `frame #${nextFrameId} sent`
      }
    }

    session.status = 'offline'
    session.lastMessage = result.message
    emitProjectionStatus(session)
    return {
      ok: false,
      sessionId,
      frameId: session.lastFrameId,
      message: result.message
    }
  }

  const stream = projectionStreams.get(session.targetClientId)
  if (!stream) {
    session.status = 'offline'
    session.lastMessage = '目标设备离线，无法发送投映帧'
    emitProjectionStatus(session)
    return {
      ok: false,
      sessionId,
      frameId: session.lastFrameId,
      message: session.lastMessage
    }
  }

  sendSseEvent(stream, 'projection-frame', {
    sessionId: session.sessionId,
    frameId: nextFrameId,
    imageDataUrl: payload.imageDataUrl,
    overlap: payload.overlap,
    sentAt: session.lastSentAt
  })
  emitProjectionStatus(session)

  session.ackTimer = setTimeout(() => {
    if (!session.active) return
    if (session.lastAckFrameId >= nextFrameId) return
    session.status = 'ack-timeout'
    session.lastMessage = `帧 #${nextFrameId} ACK 超时`
    emitProjectionStatus(session)
  }, PROJECTION_ACK_TIMEOUT_MS)

  return {
    ok: true,
    sessionId,
    frameId: nextFrameId,
    message: `frame #${nextFrameId} sent`
  }
}

function handleProjectionAck(req: IncomingMessage, res: ServerResponse): void {
  let raw = ''
  req.setEncoding('utf-8')

  req.on('data', (chunk) => {
    raw += chunk
    if (raw.length > 20_000) {
      raw = ''
      writeJson(res, 413, { ok: false })
      req.destroy()
    }
  })

  req.on('end', () => {
    try {
      const parsed = JSON.parse(raw) as ProjectionAckPayload
      const clientId = (parsed.clientId || '').trim()
      const sessionId = (parsed.sessionId || '').trim()
      const frameId = Math.max(0, Number(parsed.frameId) || 0)

      const session = projectionSessions.get(sessionId)
      if (!session || !session.active) {
        writeJson(res, 404, { ok: false, message: 'session not found' })
        return
      }

      if (!clientId || clientId !== session.targetClientId) {
        writeJson(res, 403, { ok: false, message: 'client mismatch' })
        return
      }

      if (frameId > session.lastAckFrameId) {
        session.lastAckFrameId = frameId
        session.lastAckAt = Math.max(Date.now(), Number(parsed.renderedAt) || Date.now())
        session.status = 'receiving'
        session.lastMessage = `目标设备已渲染帧 #${frameId}`
        if (frameId >= session.waitingAckFrameId) {
          clearSessionAckTimer(session)
        }
        emitProjectionStatus(session)
      }

      writeJson(res, 200, { ok: true })
    } catch {
      writeJson(res, 400, { ok: false })
    }
  })
}

function handleIncomingProjectionPush(req: IncomingMessage, res: ServerResponse): void {
  let raw = ''
  req.setEncoding('utf-8')

  req.on('data', (chunk) => {
    raw += chunk
    if (raw.length > 10_000_000) {
      raw = ''
      writeJson(res, 413, { ok: false, message: 'frame too large' })
      req.destroy()
    }
  })

  req.on('end', () => {
    try {
      const parsed = JSON.parse(raw) as IncomingProjectionFramePayload
      const imageDataUrl = String(parsed.imageDataUrl || '')
      const sessionId = String(parsed.sessionId || '')
      const frameId = Math.max(0, Number(parsed.frameId) || 0)
      const overlap = parsed.overlap || { width: 0, height: 0, left: 0, top: 0 }
      if (!imageDataUrl) {
        writeJson(res, 400, { ok: false, message: 'imageDataUrl required' })
        return
      }

      latestIncomingProjectionFrame = {
        sessionId,
        frameId,
        imageDataUrl,
        overlap,
        sentAt: Math.max(Date.now(), Number(parsed.sentAt) || Date.now())
      }

      ensureReceiverWindow()
      scheduleReceiverWindowAutoClose()
      let sentCount = 0
      for (const stream of projectionStreams.values()) {
        sendSseEvent(stream, 'projection-frame', latestIncomingProjectionFrame)
        sentCount += 1
      }

      writeJson(res, 200, { ok: true, rendered: sentCount > 0, streams: sentCount })
    } catch {
      writeJson(res, 400, { ok: false })
    }
  })
}

function handleIncomingProjectionStop(req: IncomingMessage, res: ServerResponse): void {
  let raw = ''
  req.setEncoding('utf-8')

  req.on('data', (chunk) => {
    raw += chunk
    if (raw.length > 10_000) {
      raw = ''
      writeJson(res, 413, { ok: false })
      req.destroy()
    }
  })

  req.on('end', () => {
    if (receiverAutoCloseTimer) {
      clearTimeout(receiverAutoCloseTimer)
      receiverAutoCloseTimer = null
    }
    latestIncomingProjectionFrame = null
    if (receiverWindowRef && !receiverWindowRef.isDestroyed()) {
      receiverWindowRef.close()
    }
    writeJson(res, 200, { ok: true })
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

    if (req.method === 'GET' && req.url.startsWith('/pair')) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(createPairPageHtml())
      return
    }

    if (req.method === 'POST' && req.url === '/api/hello') {
      handlePairHello(req, res)
      return
    }

    if (req.method === 'GET' && req.url.startsWith('/api/projection/stream')) {
      const requestUrl = new URL(req.url, `http://127.0.0.1:${WEB_PAIR_PORT}`)
      const clientId = (requestUrl.searchParams.get('clientId') || '').replace(
        /[^a-zA-Z0-9-_]/g,
        ''
      )
      if (!clientId) {
        writeJson(res, 400, { ok: false, message: 'clientId required' })
        return
      }

      const previous = projectionStreams.get(clientId)
      if (previous) {
        previous.end()
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      })
      res.write(': connected\n\n')

      projectionStreams.set(clientId, res)
      if (latestIncomingProjectionFrame) {
        sendSseEvent(res, 'projection-frame', latestIncomingProjectionFrame)
      }
      for (const session of projectionSessions.values()) {
        if (session.targetClientId !== clientId || !session.active) continue
        if (session.status === 'offline') {
          session.status = 'idle'
          session.lastMessage = '目标设备投映通道已恢复'
          emitProjectionStatus(session)
        }
      }

      req.on('close', () => {
        const current = projectionStreams.get(clientId)
        if (current === res) {
          projectionStreams.delete(clientId)
          markProjectionStreamOffline(clientId)
        }
      })
      return
    }

    if (req.method === 'POST' && req.url === '/api/projection/ack') {
      handleProjectionAck(req, res)
      return
    }

    if (req.method === 'POST' && req.url === '/api/projection/push') {
      handleIncomingProjectionPush(req, res)
      return
    }

    if (req.method === 'POST' && req.url === '/api/projection/stop') {
      handleIncomingProjectionStop(req, res)
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
  for (const response of projectionStreams.values()) {
    response.end()
  }
  projectionStreams.clear()

  for (const session of projectionSessions.values()) {
    stopProjectionSession(session, '应用停止投映会话')
  }
  projectionSessions.clear()

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

function parseXdpiYdpi(raw: string): number {
  const fullMatch = raw.match(/xDpi\s*[=:]\s*([\d.]+)[\s\S]*?yDpi\s*[=:]\s*([\d.]+)/i)
  if (fullMatch) {
    const x = Number(fullMatch[1])
    const y = Number(fullMatch[2])
    if (Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0) {
      return Math.round((x + y) / 2)
    }
  }

  const xOnly = raw.match(/xDpi\s*[=:]\s*([\d.]+)/i)
  const yOnly = raw.match(/yDpi\s*[=:]\s*([\d.]+)/i)
  const x = xOnly ? Number(xOnly[1]) : NaN
  const y = yOnly ? Number(yOnly[1]) : NaN
  if (Number.isFinite(x) && x > 0 && Number.isFinite(y) && y > 0) {
    return Math.round((x + y) / 2)
  }
  if (Number.isFinite(x) && x > 0) return Math.round(x)
  if (Number.isFinite(y) && y > 0) return Math.round(y)

  return 0
}

async function readAdbDevice(adb: string, serial: string): Promise<DeviceRecord> {
  const [model, size, displayDump, density] = await Promise.all([
    execPromise(`"${adb}" -s "${serial}" shell getprop ro.product.model`),
    execPromise(`"${adb}" -s "${serial}" shell wm size`),
    execPromise(`"${adb}" -s "${serial}" shell dumpsys display`),
    execPromise(`"${adb}" -s "${serial}" shell wm density`)
  ])

  const resolution = parseResolution(size.stdout)
  const dpi = parseXdpiYdpi(displayDump.stdout) || parseDpi(density.stdout)

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
    fullscreen: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
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
    mainWindow.setFullScreen(true)
    mainWindow.setContentProtection(true)
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

  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 }
        })
        const primaryDisplayId = String(screen.getPrimaryDisplay().id)
        const preferredSource =
          sources.find((source) => source.display_id === primaryDisplayId) ||
          sources.find((source) => Boolean(source.display_id)) ||
          sources[0]
        if (!preferredSource) {
          callback({})
          return
        }
        callback({ video: preferredSource })
      } catch {
        callback({})
      }
    },
    {
      useSystemPicker: false
    }
  )

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

  ipcMain.handle('lan:capture-primary-frame', async () => {
    return capturePrimaryDisplayFrame()
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

  ipcMain.handle('lan:projection-start', (_event, targetDeviceId: string) => {
    return startProjectionSession(targetDeviceId)
  })

  ipcMain.handle(
    'lan:projection-push',
    (_event, sessionId: string, payload: ProjectionPushPayload) => {
      return pushProjectionFrame(sessionId, payload)
    }
  )

  ipcMain.handle('lan:projection-stop', (_event, sessionId: string) => {
    const session = projectionSessions.get(sessionId)
    if (!session) return false
    stopProjectionSession(session, '桌面端手动停止投映')
    projectionSessions.delete(sessionId)
    return true
  })

  ipcMain.handle('lan:projection-status', (_event, sessionId: string) => {
    const session = projectionSessions.get(sessionId)
    if (!session) return null
    return toProjectionStatusSnapshot(session)
  })

  ipcMain.handle('ui:set-overlay-mode', (_event, enabled: boolean) => {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return false
    mainWindowRef.setAlwaysOnTop(Boolean(enabled), 'screen-saver')
    mainWindowRef.setFullScreen(Boolean(enabled))
    mainWindowRef.setVisibleOnAllWorkspaces(Boolean(enabled), {
      visibleOnFullScreen: true
    })
    return true
  })

  ipcMain.handle('ui:set-click-through', (_event, enabled: boolean) => {
    if (!mainWindowRef || mainWindowRef.isDestroyed()) return false
    mainWindowRef.setIgnoreMouseEvents(Boolean(enabled), { forward: true })
    mainWindowRef.setFocusable(!enabled)
    if (enabled) mainWindowRef.blur()
    return true
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
