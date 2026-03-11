import { useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'

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

type ComparePayload = {
  local: DeviceInfo
  remote: DeviceInfo
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

type CompareLayout = {
  localPhysical: ReturnType<typeof toPhysical>
  remotePhysical: ReturnType<typeof toPhysical>
  localRect: { width: number; height: number }
  remoteRect: { width: number; height: number }
  pxPerMm: number
}

type RectByCenter = {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

type ConnectionSnapshot = {
  confirmedAt: number
  localOffset: { x: number; y: number }
  remoteOffset: { x: number; y: number }
  overlapAreaPx: number
}

type PixelCrop = {
  x: number
  y: number
  width: number
  height: number
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

const LIST_HEIGHT = 420
const ROW_HEIGHT = 62
const OVERSCAN = 6

function toTimeLabel(value: number): string {
  if (!value) return '--'
  return new Date(value).toLocaleTimeString()
}

function toPhysical(device: DeviceInfo): {
  widthMm: number
  heightMm: number
  diagonalInch: number
  dpiSource: 'reported' | 'estimated'
} {
  const dpi = device.dpi > 0 ? device.dpi : 96
  const dpiSource = device.dpi > 0 ? 'reported' : 'estimated'
  const widthInch = device.resolution.width / dpi
  const heightInch = device.resolution.height / dpi

  return {
    widthMm: widthInch * 25.4,
    heightMm: heightInch * 25.4,
    diagonalInch: Math.sqrt(widthInch * widthInch + heightInch * heightInch),
    dpiSource
  }
}

function buildCompareLayout(local: DeviceInfo, remote: DeviceInfo): CompareLayout {
  const localPhysical = toPhysical(local)
  const remotePhysical = toPhysical(remote)

  const basePxPerMm = 1.45
  const maxDisplaySide = 430

  const rawLocalW = localPhysical.widthMm * basePxPerMm
  const rawLocalH = localPhysical.heightMm * basePxPerMm
  const rawRemoteW = remotePhysical.widthMm * basePxPerMm
  const rawRemoteH = remotePhysical.heightMm * basePxPerMm

  const maxRawSide = Math.max(rawLocalW, rawLocalH, rawRemoteW, rawRemoteH, 1)
  const fitRatio = Math.min(1, maxDisplaySide / maxRawSide)
  const pxPerMm = basePxPerMm * fitRatio

  return {
    localPhysical,
    remotePhysical,
    localRect: {
      width: Math.max(70, Math.round(localPhysical.widthMm * pxPerMm)),
      height: Math.max(70, Math.round(localPhysical.heightMm * pxPerMm))
    },
    remoteRect: {
      width: Math.max(70, Math.round(remotePhysical.widthMm * pxPerMm)),
      height: Math.max(70, Math.round(remotePhysical.heightMm * pxPerMm))
    },
    pxPerMm
  }
}

function snapAxis(remoteCenter: number, remoteHalf: number, localHalf: number, threshold: number): { snapped: number; guide: number | null } {
  const remoteRefs = [
    { pos: remoteCenter - remoteHalf, centerDelta: remoteHalf },
    { pos: remoteCenter, centerDelta: 0 },
    { pos: remoteCenter + remoteHalf, centerDelta: -remoteHalf }
  ]
  const localRefs = [-localHalf, 0, localHalf]

  let bestDelta = 0
  let bestDistance = Number.POSITIVE_INFINITY
  let guide: number | null = null

  for (const remoteRef of remoteRefs) {
    for (const localRef of localRefs) {
      const distance = localRef - remoteRef.pos
      const absDistance = Math.abs(distance)
      if (absDistance <= threshold && absDistance < bestDistance) {
        bestDistance = absDistance
        bestDelta = distance
        guide = localRef
      }
    }
  }

  return {
    snapped: remoteCenter + bestDelta,
    guide
  }
}

function rectFromCenter(centerX: number, centerY: number, width: number, height: number): RectByCenter {
  const halfW = width / 2
  const halfH = height / 2
  return {
    left: centerX - halfW,
    right: centerX + halfW,
    top: centerY - halfH,
    bottom: centerY + halfH,
    width,
    height
  }
}

function getOverlapRect(a: RectByCenter, b: RectByCenter): RectByCenter | null {
  const left = Math.max(a.left, b.left)
  const right = Math.min(a.right, b.right)
  const top = Math.max(a.top, b.top)
  const bottom = Math.min(a.bottom, b.bottom)
  if (right <= left || bottom <= top) return null
  return {
    left,
    right,
    top,
    bottom,
    width: right - left,
    height: bottom - top
  }
}

function mapStageOverlapToLocalScreenPixels(
  overlapRect: RectByCenter,
  localBounds: RectByCenter,
  localResolution: { width: number; height: number }
): PixelCrop {
  const relLeft = (overlapRect.left - localBounds.left) / localBounds.width
  const relTop = (overlapRect.top - localBounds.top) / localBounds.height
  const relWidth = overlapRect.width / localBounds.width
  const relHeight = overlapRect.height / localBounds.height

  const pxLeft = Math.max(0, Math.round(relLeft * localResolution.width))
  const pxTop = Math.max(0, Math.round(relTop * localResolution.height))
  const pxWidth = Math.max(1, Math.round(relWidth * localResolution.width))
  const pxHeight = Math.max(1, Math.round(relHeight * localResolution.height))

  return {
    x: Math.min(localResolution.width - 1, pxLeft),
    y: Math.min(localResolution.height - 1, pxTop),
    width: Math.min(localResolution.width - pxLeft, pxWidth),
    height: Math.min(localResolution.height - pxTop, pxHeight)
  }
}

function App(): React.JSX.Element {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [query, setQuery] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [compare, setCompare] = useState<ComparePayload | null>(null)
  const [dragOffset, setDragOffset] = useState({ x: 260, y: 20 })
  const [refreshing, setRefreshing] = useState(false)
  const [debugInfo, setDebugInfo] = useState<DiscoveryDebugInfo | null>(null)
  const [pairingInfo, setPairingInfo] = useState<PairingInfo | null>(null)
  const [pairQrDataUrl, setPairQrDataUrl] = useState('')
  const [adbConnectTarget, setAdbConnectTarget] = useState('')
  const [adbConnectResult, setAdbConnectResult] = useState<AdbConnectResult | null>(null)
  const [adbConnecting, setAdbConnecting] = useState(false)
  const [connectionSnapshot, setConnectionSnapshot] = useState<ConnectionSnapshot | null>(null)
  const [projectionSessionId, setProjectionSessionId] = useState('')
  const [projectionStatus, setProjectionStatus] = useState<ProjectionStatus | null>(null)
  const [projectionStatusText, setProjectionStatusText] = useState('未建立投映会话')
  const [snapGuides, setSnapGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null })
  const [stageSize, setStageSize] = useState({ width: 900, height: 540 })
  const [screenCaptureReady, setScreenCaptureReady] = useState(false)
  const stageRef = useRef<HTMLElement | null>(null)
  const captureStreamRef = useRef<MediaStream | null>(null)
  const captureVideoRef = useRef<HTMLVideoElement | null>(null)
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragStateRef = useRef<{ active: boolean; startX: number; startY: number; x: number; y: number }>({
    active: false,
    startX: 0,
    startY: 0,
    x: 0,
    y: 0
  })

  useEffect(() => {
    let mounted = true

    window.api
      .getDevices()
      .then((initialDevices) => {
        if (mounted) setDevices(initialDevices)
      })
      .catch(() => {
        if (mounted) setError('无法获取设备列表')
      })

    const dispose = window.api.onDevicesUpdated((nextDevices) => {
      setDevices(nextDevices)
    })

    const updateDebug = (): void => {
      window.api
        .getDiscoveryDebug()
        .then((nextDebug) => {
          if (mounted) setDebugInfo(nextDebug)
        })
        .catch(() => {
          if (mounted) setDebugInfo(null)
        })
    }

    const updatePairing = (): void => {
      window.api
        .getPairingInfo()
        .then((info) => {
          if (mounted) setPairingInfo(info)
        })
        .catch(() => {
          if (mounted) setPairingInfo(null)
        })
    }

    updateDebug()
    updatePairing()
    const timer = window.setInterval(updateDebug, 2000)
    const pairingTimer = window.setInterval(updatePairing, 10_000)

    return () => {
      mounted = false
      window.clearInterval(timer)
      window.clearInterval(pairingTimer)
      dispose()
    }
  }, [])

  useEffect(() => {
    const dispose = window.api.onProjectionStatus((payload) => {
      setProjectionStatus(payload)
      setProjectionStatusText(payload.lastMessage || payload.status)
    })
    return () => {
      dispose()
    }
  }, [])

  useEffect(() => {
    return () => {
      if (projectionSessionId) {
        void window.api.projectionStop(projectionSessionId)
      }
      const stream = captureStreamRef.current
      if (stream) {
        for (const track of stream.getTracks()) {
          track.stop()
        }
      }
    }
  }, [projectionSessionId])

  async function ensureScreenCaptureReady(): Promise<boolean> {
    if (captureStreamRef.current && captureVideoRef.current?.readyState >= 2) {
      return true
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 12, max: 15 }
        },
        audio: false
      })

      const video = document.createElement('video')
      video.srcObject = stream
      video.muted = true
      video.playsInline = true
      await video.play()

      captureStreamRef.current = stream
      captureVideoRef.current = video
      setScreenCaptureReady(true)
      return true
    } catch {
      setScreenCaptureReady(false)
      setProjectionStatusText('未获得整屏采集权限，请在弹窗中选择“整个屏幕”')
      return false
    }
  }

  function captureCropFromFullScreen(
    crop: PixelCrop,
    localResolution: { width: number; height: number }
  ): string {
    const video = captureVideoRef.current
    if (!video || video.readyState < 2) return ''

    const sourceW = video.videoWidth
    const sourceH = video.videoHeight
    if (!sourceW || !sourceH) return ''

    const fullCanvas = captureCanvasRef.current || document.createElement('canvas')
    fullCanvas.width = sourceW
    fullCanvas.height = sourceH
    captureCanvasRef.current = fullCanvas

    const fullCtx = fullCanvas.getContext('2d')
    if (!fullCtx) return ''
    fullCtx.drawImage(video, 0, 0, sourceW, sourceH)

    const scaleX = sourceW / Math.max(1, localResolution.width)
    const scaleY = sourceH / Math.max(1, localResolution.height)

    const scaledX = Math.round(crop.x * scaleX)
    const scaledY = Math.round(crop.y * scaleY)
    const scaledWidth = Math.max(1, Math.round(crop.width * scaleX))
    const scaledHeight = Math.max(1, Math.round(crop.height * scaleY))

    const cropX = Math.max(0, Math.min(sourceW - 1, scaledX))
    const cropY = Math.max(0, Math.min(sourceH - 1, scaledY))
    const cropWidth = Math.max(1, Math.min(sourceW - cropX, scaledWidth))
    const cropHeight = Math.max(1, Math.min(sourceH - cropY, scaledHeight))

    const cropCanvas = cropCanvasRef.current || document.createElement('canvas')
    cropCanvas.width = cropWidth
    cropCanvas.height = cropHeight
    cropCanvasRef.current = cropCanvas

    const cropCtx = cropCanvas.getContext('2d')
    if (!cropCtx) return ''
    cropCtx.clearRect(0, 0, cropWidth, cropHeight)
    cropCtx.drawImage(fullCanvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)

    return cropCanvas.toDataURL('image/jpeg', 0.78)
  }

  useEffect(() => {
    const stage = stageRef.current
    if (!stage || !compare) return

    const refreshSize = (): void => {
      setStageSize({
        width: stage.clientWidth,
        height: stage.clientHeight
      })
    }

    refreshSize()
    const observer = new ResizeObserver(refreshSize)
    observer.observe(stage)

    return () => {
      observer.disconnect()
    }
  }, [compare])

  const compareLayout = useMemo(() => {
    if (!compare) return null
    return buildCompareLayout(compare.local, compare.remote)
  }, [compare])

  useEffect(() => {
    if (!compareLayout) return

    const onPointerMove = (event: PointerEvent): void => {
      const state = dragStateRef.current
      if (!state.active) return

      const nextX = state.x + (event.clientX - state.startX)
      const nextY = state.y + (event.clientY - state.startY)

      const localHalfW = compareLayout.localRect.width / 2
      const localHalfH = compareLayout.localRect.height / 2
      const remoteHalfW = compareLayout.remoteRect.width / 2
      const remoteHalfH = compareLayout.remoteRect.height / 2

      const snappedX = snapAxis(nextX, remoteHalfW, localHalfW, 12)
      const snappedY = snapAxis(nextY, remoteHalfH, localHalfH, 12)

      setDragOffset({
        x: snappedX.snapped,
        y: snappedY.snapped
      })
      setSnapGuides({ x: snappedX.guide, y: snappedY.guide })
    }

    const onPointerUp = (): void => {
      dragStateRef.current.active = false
      setSnapGuides({ x: null, y: null })
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)

    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [compareLayout])

  const filteredDevices = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return devices
    return devices.filter((device) => {
      return (
        device.name.toLowerCase().includes(term) ||
        device.address.toLowerCase().includes(term) ||
        `${device.resolution.width}x${device.resolution.height}`.includes(term)
      )
    })
  }, [devices, query])

  const diagnosis = useMemo(() => {
    if (!debugInfo) return ''
    if (!debugInfo.lastSweepAt) {
      return '正在等待首次设备扫描结果（ADB / UDP）。'
    }

    if (debugInfo.lastError) {
      return 'ADB 不可用。请确认已安装 Android Platform Tools；同时可继续使用 UDP 局域网发现。'
    }

    if (devices.length === 0) {
      return '未检测到设备。可尝试 USB 调试（ADB）或保持局域网 UDP 自动发现。'
    }

    return ''
  }, [debugInfo, devices.length])

  const primaryPairUrl = pairingInfo?.urls?.[0] || ''

  useEffect(() => {
    if (!primaryPairUrl) {
      setPairQrDataUrl('')
      return
    }

    let active = true
    QRCode.toDataURL(primaryPairUrl, {
      width: 220,
      margin: 2,
      color: {
        dark: '#0b1420',
        light: '#ffffff'
      }
    })
      .then((url) => {
        if (active) setPairQrDataUrl(url)
      })
      .catch(() => {
        if (active) setPairQrDataUrl('')
      })

    return () => {
      active = false
    }
  }, [primaryPairUrl])

  const totalCount = filteredDevices.length
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visibleCount = Math.ceil(LIST_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2
  const endIndex = Math.min(totalCount, startIndex + visibleCount)
  const topSpacerHeight = startIndex * ROW_HEIGHT
  const bottomSpacerHeight = Math.max(0, (totalCount - endIndex) * ROW_HEIGHT)
  const visibleRows = filteredDevices.slice(startIndex, endIndex)

  async function handleSelectDevice(device: DeviceInfo): Promise<void> {
    setError(null)
    setLoadingId(device.id)

    try {
      if (projectionSessionId) {
        await window.api.projectionStop(projectionSessionId)
      }
      const [local, remote] = await Promise.all([
        window.api.getLocalDevice(),
        window.api.requestDeviceInfo(device.id)
      ])

      if (!remote) {
        setError('设备信息请求超时，请确认目标设备在线')
        return
      }

      setCompare({ local, remote })
      setConnectionSnapshot(null)
      setDragOffset({ x: 260, y: 20 })
      setProjectionSessionId('')
      setProjectionStatus(null)
      setProjectionStatusText('未建立投映会话')
    } catch {
      setError('获取设备分辨率和 DPI 失败')
    } finally {
      setLoadingId(null)
    }
  }

  async function handleRefreshDiscovery(): Promise<void> {
    setRefreshing(true)
    setError(null)

    try {
      await window.api.refreshDiscovery()
      const latest = await window.api.getDevices()
      setDevices(latest)
    } catch {
      setError('刷新设备发现失败')
    } finally {
      setRefreshing(false)
    }
  }

  async function handleAdbConnect(): Promise<void> {
    if (!adbConnectTarget.trim()) {
      setAdbConnectResult({
        ok: false,
        target: '',
        message: '请输入手机的局域网地址，例如 192.168.1.23 或 192.168.1.23:5555'
      })
      return
    }

    setAdbConnecting(true)
    setAdbConnectResult(null)
    try {
      const result = await window.api.adbConnect(adbConnectTarget)
      setAdbConnectResult(result)
      const latest = await window.api.getDevices()
      setDevices(latest)
    } catch {
      setAdbConnectResult({ ok: false, target: adbConnectTarget, message: '执行 adb connect 失败' })
    } finally {
      setAdbConnecting(false)
    }
  }

  function startDrag(event: React.PointerEvent<HTMLDivElement>): void {
    if (connectionSnapshot) return
    dragStateRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      x: dragOffset.x,
      y: dragOffset.y
    }
    setSnapGuides({ x: null, y: null })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  async function handleConfirmConnection(overlapAreaPx: number): Promise<void> {
    if (!compare) return
    if (overlapAreaPx <= 0) {
      setProjectionStatusText('当前无重叠区域，无法建立遮挡投映')
      return
    }
    const captureReady = await ensureScreenCaptureReady()
    if (!captureReady) return

    if (!projectionSessionId) {
      const started = await window.api.projectionStart(compare.remote.id)
      if (!started.ok) {
        setProjectionStatusText(started.message)
        setError(started.message)
        return
      }
      setProjectionSessionId(started.sessionId)
      setProjectionStatusText(started.message)
    }

    setConnectionSnapshot({
      confirmedAt: Date.now(),
      localOffset: { x: 0, y: 0 },
      remoteOffset: { ...dragOffset },
      overlapAreaPx
    })
    setProjectionStatusText('已锁定快照坐标，开始整屏对齐投映')
  }

  async function handleExitCompare(): Promise<void> {
    if (projectionSessionId) {
      await window.api.projectionStop(projectionSessionId)
    }
    setCompare(null)
    setConnectionSnapshot(null)
    setProjectionSessionId('')
    setProjectionStatus(null)
    setProjectionStatusText('未建立投映会话')
  }

  useEffect(() => {
    if (!compare || !compareLayout || !connectionSnapshot || !projectionSessionId) return

    const timer = window.setInterval(() => {
      const localBounds = rectFromCenter(
        connectionSnapshot.localOffset.x,
        connectionSnapshot.localOffset.y,
        compareLayout.localRect.width,
        compareLayout.localRect.height
      )
      const remoteBounds = rectFromCenter(
        connectionSnapshot.remoteOffset.x,
        connectionSnapshot.remoteOffset.y,
        compareLayout.remoteRect.width,
        compareLayout.remoteRect.height
      )
      const overlapRect = getOverlapRect(localBounds, remoteBounds)
      if (!overlapRect) return

      const crop = mapStageOverlapToLocalScreenPixels(
        overlapRect,
        localBounds,
        compare.local.resolution
      )
      const imageDataUrl = captureCropFromFullScreen(crop, compare.local.resolution)
      if (!imageDataUrl) return

      void window.api.projectionPush(projectionSessionId, {
        imageDataUrl,
        overlap: {
          width: crop.width,
          height: crop.height,
          left: crop.x,
          top: crop.y
        }
      })
    }, 320)

    return () => {
      window.clearInterval(timer)
    }
  }, [compare, compareLayout, connectionSnapshot, projectionSessionId])

  if (compare) {
    if (!compareLayout) return <main className="app-shell" />

    const localPhysical = compareLayout.localPhysical
    const remotePhysical = compareLayout.remotePhysical
    const localRect = compareLayout.localRect
    const remoteRect = compareLayout.remoteRect
    const activeLocalOffset = connectionSnapshot?.localOffset || { x: 0, y: 0 }
    const activeRemoteOffset = connectionSnapshot?.remoteOffset || dragOffset
    const localBounds = rectFromCenter(
      activeLocalOffset.x,
      activeLocalOffset.y,
      localRect.width,
      localRect.height
    )
    const remoteBounds = rectFromCenter(
      activeRemoteOffset.x,
      activeRemoteOffset.y,
      remoteRect.width,
      remoteRect.height
    )
    const overlapRect = getOverlapRect(localBounds, remoteBounds)
    const sourceRect = localBounds
    const projectionEnabled = Boolean(connectionSnapshot && overlapRect)
    const overlapAreaPx = overlapRect ? Math.round(overlapRect.width * overlapRect.height) : 0
    const projectionStyle = projectionEnabled && overlapRect
      ? {
          left: `calc(50% + ${overlapRect.left}px)`,
          top: `calc(50% + ${overlapRect.top}px)`,
          width: `${overlapRect.width}px`,
          height: `${overlapRect.height}px`,
          backgroundSize: `${sourceRect.width}px ${sourceRect.height}px`,
          backgroundPosition: `${-(overlapRect.left - sourceRect.left)}px ${-(overlapRect.top - sourceRect.top)}px`
        }
      : null
    const rulerExtentX = Math.floor(stageSize.width / (2 * compareLayout.pxPerMm))
    const rulerExtentY = Math.floor(stageSize.height / (2 * compareLayout.pxPerMm))
    const rulerStepMm = 10
    const rulerMarksX: number[] = []
    const rulerMarksY: number[] = []

    for (let mm = -rulerExtentX; mm <= rulerExtentX; mm += rulerStepMm) {
      rulerMarksX.push(mm)
    }
    for (let mm = -rulerExtentY; mm <= rulerExtentY; mm += rulerStepMm) {
      rulerMarksY.push(mm)
    }

    return (
      <main className="app-shell compare-shell">
        <header className="topbar">
          <button className="secondary-btn" onClick={() => void handleExitCompare()}>
            返回设备列表
          </button>
          <div className="compare-actions">
            <button className="refresh-btn" type="button" onClick={() => void handleConfirmConnection(overlapAreaPx)}>
              确认连接
            </button>
            <p className="hint">拖拽右侧设备图进行位置微调</p>
          </div>
        </header>

        {connectionSnapshot ? (
          <p className="snapshot-line">
            快照时间: {toTimeLabel(connectionSnapshot.confirmedAt)} | 远端偏移: ({Math.round(connectionSnapshot.remoteOffset.x)},{' '}
            {Math.round(connectionSnapshot.remoteOffset.y)}) | 重叠面积: {overlapAreaPx}px^2
          </p>
        ) : null}

        <p className="snapshot-line">
          投映状态: {projectionStatusText} | 通道: {projectionStatus?.streamOnline ? '在线' : '离线'} | ACK: #
          {projectionStatus?.lastAckFrameId ?? 0}
        </p>

        <p className="snapshot-line">
          整屏采集: {screenCaptureReady ? '已就绪' : '未就绪（确认连接时会请求权限）'}
        </p>

        <section className="stage" ref={stageRef}>
          <div className="ruler ruler-x">
            {rulerMarksX.map((mm) => {
              const px = mm * compareLayout.pxPerMm
              const major = mm % 50 === 0
              return (
                <div key={`rx-${mm}`} className={`ruler-tick x ${major ? 'major' : ''}`} style={{ left: `calc(50% + ${px}px)` }}>
                  {major ? <span>{mm}mm</span> : null}
                </div>
              )
            })}
          </div>

          <div className="ruler ruler-y">
            {rulerMarksY.map((mm) => {
              const px = mm * compareLayout.pxPerMm
              const major = mm % 50 === 0
              return (
                <div key={`ry-${mm}`} className={`ruler-tick y ${major ? 'major' : ''}`} style={{ top: `calc(50% + ${px}px)` }}>
                  {major ? <span>{mm}mm</span> : null}
                </div>
              )
            })}
          </div>

          {snapGuides.x !== null ? <div className="snap-line vertical" style={{ left: `calc(50% + ${snapGuides.x}px)` }} /> : null}
          {snapGuides.y !== null ? <div className="snap-line horizontal" style={{ top: `calc(50% + ${snapGuides.y}px)` }} /> : null}

          {projectionStyle ? (
            <div className="projection-overlay" style={projectionStyle}>
              <span>实时投映</span>
            </div>
          ) : null}

          <div className="device-rect local" style={{ width: localRect.width, height: localRect.height }}>
            <h3>{compare.local.name} (本机)</h3>
            <p>
              {compare.local.resolution.width} x {compare.local.resolution.height} @ {compare.local.dpi} DPI
            </p>
            <p>
              估算: {localPhysical.widthMm.toFixed(1)}mm x {localPhysical.heightMm.toFixed(1)}mm /{' '}
              {localPhysical.diagonalInch.toFixed(1)}"
            </p>
          </div>

          <div
            className="device-rect remote"
            style={{
              width: remoteRect.width,
              height: remoteRect.height,
              left: `calc(50% + ${activeRemoteOffset.x}px)`,
              top: `calc(50% + ${activeRemoteOffset.y}px)`
            }}
            onPointerDown={startDrag}
          >
            <h3>{compare.remote.name}</h3>
            <p>
              {compare.remote.resolution.width} x {compare.remote.resolution.height} @ {compare.remote.dpi} DPI
            </p>
            <p>
              估算: {remotePhysical.widthMm.toFixed(1)}mm x {remotePhysical.heightMm.toFixed(1)}mm /{' '}
              {remotePhysical.diagonalInch.toFixed(1)}"
            </p>
            <p className="meta">DPI来源: {remotePhysical.dpiSource === 'reported' ? '设备上报' : '系统估算'}</p>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Device Bridge (ADB + UDP)</h1>
          <p>应用会同时进行 ADB 与局域网 UDP 设备发现</p>
        </div>
      </header>

      <section className="panel">
        <section className="pair-panel">
          <h2>手机接入（ADB / UDP）</h2>
          <p className="pair-line">也可使用 HTTP 配对：手机浏览器打开下列地址，或扫描二维码。</p>
          <p className="pair-line">配对端口: {pairingInfo?.port ?? '--'}</p>
          {primaryPairUrl && pairQrDataUrl ? (
            <div className="pair-qr-wrap">
              <img className="pair-qr" src={pairQrDataUrl} alt="手机接入二维码" />
              <p className="pair-line">扫码优先地址: {primaryPairUrl}</p>
            </div>
          ) : null}
          {pairingInfo?.urls?.length
            ? pairingInfo.urls.map((url) => (
                <p key={url} className="pair-url">
                  {url}
                </p>
              ))
            : null}
          <p className="pair-line">1) 手机开启开发者选项与 USB 调试。</p>
          <p className="pair-line">2) USB 连接后，在手机上点击“允许 USB 调试”。</p>
          <p className="pair-line">3) 如需无线调试，请先 USB 配对后执行 adb tcpip / adb connect。</p>
          <div className="adb-connect-row">
            <input
              className="search-input adb-connect-input"
              value={adbConnectTarget}
              onChange={(event) => setAdbConnectTarget(event.target.value)}
              placeholder="手动 adb connect (示例: 192.168.1.23:5555)"
            />
            <button
              type="button"
              className="refresh-btn"
              onClick={() => void handleAdbConnect()}
              disabled={adbConnecting}
            >
              {adbConnecting ? '连接中...' : 'ADB连接'}
            </button>
          </div>
          {adbConnectResult ? (
            <p className={adbConnectResult.ok ? 'debug-line' : 'debug-error'}>ADB连接结果: {adbConnectResult.message}</p>
          ) : null}
        </section>

        <div className="search-row">
          <input
            className="search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索设备名称、序列号或分辨率"
          />
          <button
            type="button"
            className="refresh-btn"
            onClick={() => void handleRefreshDiscovery()}
            disabled={refreshing}
          >
            {refreshing ? '刷新中...' : '刷新'}
          </button>
        </div>

        <div className="list-meta">
          <span>设备总数: {devices.length}</span>
          <span>匹配结果: {filteredDevices.length}</span>
        </div>

        <div className="virtual-list" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
          <div style={{ height: topSpacerHeight }} />

          {visibleRows.map((device) => {
            const busy = loadingId === device.id
            return (
              <button
                key={device.id}
                className="device-row"
                style={{ height: ROW_HEIGHT }}
                onClick={() => void handleSelectDevice(device)}
                disabled={busy}
              >
                <div>
                  <strong>{device.name}</strong>
                  <p>{device.address || 'unknown address'}</p>
                </div>
                <div>
                  <p>
                    {device.resolution.width} x {device.resolution.height}
                  </p>
                  <small>{busy ? '获取中...' : '选择并对比'}</small>
                </div>
              </button>
            )
          })}

          <div style={{ height: bottomSpacerHeight }} />
        </div>

        {totalCount === 0 ? <p className="empty">当前没有可用设备，请确认 adb 授权或局域网 UDP 可互通。</p> : null}
        {error ? <p className="error">{error}</p> : null}

        <section className="debug-panel">
          <h2>ADB 调试</h2>
          {!debugInfo ? (
            <p className="debug-line">调试信息暂不可用</p>
          ) : (
            <>
              <p className="debug-line">启动时间: {toTimeLabel(debugInfo.startedAt)}</p>
              <p className="debug-line">最近扫描: {toTimeLabel(debugInfo.lastSweepAt)}</p>
              <p className="debug-line">最近 adb 读取: {toTimeLabel(debugInfo.lastArpReadAt)}</p>
              <p className="debug-line">连接设备数: {debugInfo.lastArpNeighborCount}</p>
              <p className="debug-line">设备序列号: {debugInfo.lastArpNeighbors.join(', ') || '--'}</p>
              <p className="debug-line">
                扫描计数: {debugInfo.discoverRequestSentCount} / 响应计数: {debugInfo.discoverResponseReceivedCount}
              </p>
              {diagnosis ? <p className="debug-error">诊断: {diagnosis}</p> : null}
              {debugInfo.lastError ? <p className="debug-error">最近错误: {debugInfo.lastError}</p> : null}
            </>
          )}
        </section>
      </section>
    </main>
  )
}

export default App
