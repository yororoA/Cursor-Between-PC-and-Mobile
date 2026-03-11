import { useEffect, useMemo, useRef, useState } from 'react'

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

const LIST_HEIGHT = 420
const ROW_HEIGHT = 62
const OVERSCAN = 6

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

function clampRectSize(widthMm: number, heightMm: number): { width: number; height: number } {
  const pxPerMm = 1.45
  const width = Math.max(70, Math.round(widthMm * pxPerMm))
  const height = Math.max(70, Math.round(heightMm * pxPerMm))
  const maxSide = 380
  const ratio = Math.min(1, maxSide / Math.max(width, height))

  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio)
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

    return () => {
      mounted = false
      dispose()
    }
  }, [])

  useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      const state = dragStateRef.current
      if (!state.active) return
      setDragOffset({
        x: state.x + (event.clientX - state.startX),
        y: state.y + (event.clientY - state.startY)
      })
    }

    const onPointerUp = (): void => {
      dragStateRef.current.active = false
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)

    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [])

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
      const [local, remote] = await Promise.all([
        window.api.getLocalDevice(),
        window.api.requestDeviceInfo(device.id)
      ])

      if (!remote) {
        setError('设备信息请求超时，请确认目标设备在线')
        return
      }

      setCompare({ local, remote })
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

  function startDrag(event: React.PointerEvent<HTMLDivElement>): void {
    dragStateRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      x: dragOffset.x,
      y: dragOffset.y
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  if (compare) {
    const localPhysical = toPhysical(compare.local)
    const remotePhysical = toPhysical(compare.remote)
    const localRect = clampRectSize(localPhysical.widthMm, localPhysical.heightMm)
    const remoteRect = clampRectSize(remotePhysical.widthMm, remotePhysical.heightMm)

    return (
      <main className="app-shell compare-shell">
        <header className="topbar">
          <button className="secondary-btn" onClick={() => setCompare(null)}>
            返回设备列表
          </button>
          <p className="hint">拖拽右侧设备图进行位置微调</p>
        </header>

        <section className="stage">
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
            style={{ width: remoteRect.width, height: remoteRect.height, left: `calc(50% + ${dragOffset.x}px)`, top: `calc(50% + ${dragOffset.y}px)` }}
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
          <h1>LAN Device Bridge</h1>
          <p>应用启动后自动扫描同一局域网设备</p>
        </div>
      </header>

      <section className="panel">
        <div className="search-row">
          <input
            className="search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索设备名称、IP 或分辨率"
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

        {totalCount === 0 ? <p className="empty">当前没有可用设备，请确认其他设备已启动应用且处于同一局域网。</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  )
}

export default App
