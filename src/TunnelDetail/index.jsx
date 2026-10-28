import { useState, useEffect, useRef, useCallback } from 'react'
import { ClipboardCopy, Play, Square, FolderOpen } from 'lucide-react'
import './index.css'

function parsePort (value) {
  if (!/^\d+$/.test(value)) return null
  const num = Number(value)
  return Number.isInteger(num) && num >= 1 && num <= 65535 ? num : null
}

async function checkWrite (operation) {
  const result = await operation
  if (result?.success === false) throw new Error(result.message || '操作失败')
  return result
}

export default function TunnelDetail ({ tunnel: initialTunnel, onBack, showToast }) {
  const [tunnel, setTunnel] = useState(initialTunnel)
  const [editing, setEditing] = useState(false)
  const [description, setDescription] = useState(initialTunnel.description || '')
  const [port, setPort] = useState(initialTunnel.ports?.[0]?.portNumber?.toString() || '')
  const [protocol, setProtocol] = useState(initialTunnel.ports?.[0]?.protocol || 'auto')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [logs, setLogs] = useState([])
  const logEndRef = useRef(null)
  const startPending = useRef(false)
  const [starting, setStarting] = useState(false)

  const tunnelId = tunnel.tunnelId || tunnel.tunnel_id || tunnel.id || ''
  // 判断是否为代理目录隧道
  const dirProxyPath = (tunnel.description || '').startsWith('代理目录: ')
    ? tunnel.description.replace('代理目录: ', '')
    : ''
  const [tunnelUrl, setTunnelUrl] = useState(() => window.services?.getTunnelUrl(tunnelId) || '')
  const [running, setRunning] = useState(() => {
    try {
      const status = window.services?.getHostStatus()
      return status?.running && window.__runningTunnelId === tunnelId
    } catch (e) { return false }
  })

  // 从缓存获取URL
  useEffect(() => {
    const url = window.services?.getTunnelUrl(tunnelId)
    if (url) setTunnelUrl(url)
  }, [tunnelId, logs])

  const syncHostStatus = useCallback(() => {
    try {
      const status = window.services?.getHostStatus()
      setRunning(Boolean(status?.running && window.__runningTunnelId === tunnelId))
      setTunnelUrl(window.services?.getTunnelUrl(tunnelId) || '')
    } catch (e) { setRunning(false) }
  }, [tunnelId])

  // 日志监听 + 隧道运行状态事件
  useEffect(() => {
    const history = window.services?.getLogBuffer() || []
    setLogs(history.slice(-500).map(h => ({ ...h, time: new Date(h.time) })))

    const onLogEntry = (e) => setLogs(prev => [...prev.slice(-499), { ...e.detail, time: new Date(e.detail.time) }])
    const onUrl = (e) => {
      if (e.detail.tunnelId === tunnelId) setTunnelUrl(e.detail.url)
    }
    window.addEventListener('tunnel-log-entry', onLogEntry)
    window.addEventListener('tunnel-exit', syncHostStatus)
    window.addEventListener('tunnel-host-status', syncHostStatus)
    window.addEventListener('tunnel-url', onUrl)
    syncHostStatus()
    return () => {
      window.removeEventListener('tunnel-log-entry', onLogEntry)
      window.removeEventListener('tunnel-exit', syncHostStatus)
      window.removeEventListener('tunnel-host-status', syncHostStatus)
      window.removeEventListener('tunnel-url', onUrl)
    }
  }, [tunnelId, syncHostStatus])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // 异步加载完整数据（含端口），卸载后不再覆盖草稿。
  useEffect(() => {
    let active = true
    setLoading(true)
    const loadFull = async () => {
      try {
        if (!window.services || !tunnelId) return
        const full = await window.services.getTunnelWithPorts(tunnelId)
        if (active && full) {
          setTunnel(full)
          setPort(full.ports?.[0]?.portNumber?.toString() || '')
          setProtocol(full.ports?.[0]?.protocol || 'auto')
          setDescription(full.description || '')
        }
      } catch (e) {
      } finally {
        if (active) setLoading(false)
      }
    }
    loadFull()
    return () => { active = false }
  }, [tunnelId])

  const handleCancel = useCallback(() => {
    if (loading || saving) return
    setDescription(tunnel.description || '')
    setPort(tunnel.ports?.[0]?.portNumber?.toString() || '')
    setProtocol(tunnel.ports?.[0]?.protocol || 'auto')
    setEditing(false)
  }, [tunnel, loading, saving])

  const handleSave = useCallback(async () => {
    if (loading || saving) return
    // 空端口仅保留原配置，不代表删除；非空端口必须在任何写入前校验。
    const newPort = port === '' ? null : parsePort(port)
    if (port !== '' && newPort === null) {
      showToast('端口号必须是 1-65535 之间的整数', 'error')
      return
    }
    setSaving(true)
    try {
      const current = await window.services.getTunnelWithPorts(tunnelId)
      if (!current) throw new Error('无法获取当前隧道配置，请重试')
      const oldPort = current.ports?.[0]?.portNumber ? Number(current.ports[0].portNumber) : undefined
      const oldProtocol = current.ports?.[0]?.protocol || 'auto'

      await checkWrite(window.services.updateTunnel(tunnelId, { description }))

      if (newPort && (newPort !== oldPort || protocol !== oldProtocol)) {
        if (newPort === oldPort) {
          // CLI 无端口更新接口；同端口改协议需重建，失败时恢复原协议。
          await checkWrite(window.services.deletePort(tunnelId, oldPort))
          try {
            await checkWrite(window.services.addPort(tunnelId, newPort, protocol))
          } catch (err) {
            try {
              await checkWrite(window.services.addPort(tunnelId, oldPort, oldProtocol))
            } catch (restoreError) {
              throw new Error(err.message + '；恢复原端口协议失败: ' + restoreError.message)
            }
            throw new Error(err.message + '；已恢复原端口协议')
          }
        } else {
          // 不同端口先新增，避免新增失败时丢失原端口。
          await checkWrite(window.services.addPort(tunnelId, newPort, protocol))
          if (oldPort) {
            try {
              await checkWrite(window.services.deletePort(tunnelId, oldPort))
            } catch (err) {
              try {
                await checkWrite(window.services.deletePort(tunnelId, newPort))
              } catch (rollbackError) {
                throw new Error(err.message + '；回滚新增端口失败: ' + rollbackError.message)
              }
              throw new Error(err.message + '；已撤回新增端口')
            }
          }
        }
      }

      const full = await window.services.getTunnelWithPorts(tunnelId)
      if (!full) throw new Error('配置可能已保存，但读取最新详情失败，请刷新确认')
      if (full) {
        setTunnel(full)
        setDescription(full.description || '')
        setPort(full.ports?.[0]?.portNumber?.toString() || '')
        setProtocol(full.ports?.[0]?.protocol || 'auto')
      }
      setEditing(false)
      showToast('已保存', 'success')
    } catch (err) {
      showToast('保存失败: ' + err.message, 'error')
    } finally {
      setSaving(false)
    }
  }, [tunnelId, description, port, protocol, loading, saving, showToast])

  const handleCopyUrl = useCallback(() => {
    if (!tunnelUrl) {
      showToast('请先启动隧道', 'error')
      return
    }
    window.utools?.copyText(tunnelUrl)
    showToast('URL 已复制', 'success')
  }, [tunnelUrl, showToast])

  const handleStart = useCallback(async () => {
    if (startPending.current) return
    startPending.current = true
    setStarting(true)
    try {
      const services = window.services
      const latest = await services.getTunnelWithPorts(tunnelId)
      if (!latest) throw new Error('读取最新隧道配置失败，请重试')
      const currentPort = latest.ports?.[0]?.portNumber
      if (!currentPort) throw new Error('请先配置端口')
      if (services.getHostStatus()?.running) throw new Error('已有隧道在运行，请先停止')
      const description = latest.description || ''
      if (description.startsWith('代理目录: ')) {
        const result = await services.startFileServer(description.slice('代理目录: '.length), currentPort)
        if (!result?.success) throw new Error('文件服务器启动失败: ' + (result?.message || '未知错误'))
      }
      const result = await services.startHost(latest.tunnelId, currentPort)
      syncHostStatus()
      if (!result?.success) throw new Error(result?.message || '进程未能启动')
      setTunnel(latest)
      showToast('启动中...')
    } catch (error) {
      showToast('启动失败: ' + error.message, 'error')
    } finally {
      startPending.current = false
      setStarting(false)
    }
  }, [tunnelId, showToast, syncHostStatus])

  const handleStop = useCallback(async () => {
    const result = await window.services.stopHost()
    syncHostStatus()
    if (result.success) {
      showToast('已停止', 'success')
    } else {
      showToast('停止失败: ' + result.message, 'error')
    }
  }, [showToast, syncHostStatus])

  const formatTime = (d) => d instanceof Date ? d.toLocaleTimeString('zh-CN', { hour12: false }) : ''

  return (
    <>
      <div className='topbar'>
        <div className='topbar-left'>
          <button className='back-btn' onClick={onBack} title='返回'>
            <svg width='16' height='16' viewBox='0 0 16 16' fill='none'>
              <path d='M10 12L6 8L10 4' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
            </svg>
          </button>
          <span className='topbar-title'>
            {dirProxyPath ? <><FolderOpen size={16} style={{ marginRight: 4, verticalAlign: 'middle' }} />代理目录详情</> : '隧道详情'}
          </span>
          {running && <span className='badge badge-success'>运行中</span>}
          {loading && <span className='spinner' />}
        </div>
        <div className='topbar-right'>
          {editing
            ? (
              <>
                <button className='btn btn-ghost btn-sm' onClick={handleCancel} disabled={loading || saving}>取消</button>
                <button className='btn btn-brand btn-sm' onClick={handleSave} disabled={loading || saving}>
                  {saving ? '保存中...' : '保存'}
                </button>
              </>
              )
            : (
              <>
                {running
                  ? (
                    <button className='btn btn-warning btn-sm' onClick={handleStop}>
                      <Square size={13} /> 停止
                    </button>
                    )
                  : (
                    <button className='btn btn-brand btn-sm' onClick={handleStart} disabled={loading || starting}>
                      <Play size={13} /> 启动
                    </button>
                    )}
                <button className='btn btn-ghost btn-sm' onClick={() => setEditing(true)} disabled={loading || saving}>编辑</button>
              </>
              )}
        </div>
      </div>

      <div className='page'>
        {/* 信息卡片 */}
        <div className='card'>
          <div className='info-grid'>
            <div className='info-item'>
              <span className='info-label'>隧道 ID</span>
              <span className='info-val mono'>{tunnelId || '-'}</span>
            </div>
            {dirProxyPath && (
              <div className='info-item'>
                <span className='info-label'>代理目录</span>
                <span className='info-val' style={{ color: 'var(--blue)' }}>{dirProxyPath}</span>
              </div>
            )}

            {editing
              ? (
                <>
                  <div className='info-item'>
                    <span className='info-label'>端口号</span>
                    <input className='form-input' type='number' disabled={loading || saving} value={port} onChange={(e) => setPort(e.target.value)} placeholder='80、3000、8080...' min='1' max='65535' />
                  </div>
                  <div className='info-item'>
                    <span className='info-label'>协议</span>
                    <select className='form-select' disabled={loading || saving} value={protocol} onChange={(e) => setProtocol(e.target.value)}>
                      <option value='auto'>自动 (auto)</option>
                      <option value='http'>HTTP</option>
                      <option value='https'>HTTPS</option>
                    </select>
                  </div>
                  <div className='info-item'>
                    <span className='info-label'>描述</span>
                    <input className='form-input' type='text' disabled={loading || saving} value={description} onChange={(e) => setDescription(e.target.value)} placeholder='隧道用途说明' />
                  </div>
                </>
                )
              : (
                <>
                  <div className='info-item'>
                    <span className='info-label'>端口</span>
                    <span className='info-val'>{tunnel.ports?.map(p => `${p.portNumber} (${p.protocol})`).join(', ') || '未配置'}</span>
                  </div>
                  {tunnel.description && (
                    <div className='info-item'>
                      <span className='info-label'>描述</span>
                      <span className='info-val'>{tunnel.description}</span>
                    </div>
                  )}
                  <div className='info-item'>
                    <span className='info-label'>访问 URL</span>
                    {tunnelUrl
                      ? (
                        <span className='info-val url' onClick={handleCopyUrl} title='点击复制'>{tunnelUrl} <ClipboardCopy size={13} /></span>
                        )
                      : (
                        <span className='info-val' style={{ color: 'var(--text-muted)' }}>启动后获取</span>
                        )}
                  </div>
                </>
                )}
          </div>
        </div>

        {/* 日志 */}
        <div className='log-panel'>
          <div className='log-header'>
            <span>运行日志 ({logs.length})</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className='btn btn-ghost btn-sm' onClick={() => {
                  const text = logs.map(l => `[${formatTime(l.time)}] [${l.type}] ${l.text}`).join('\n')
                  window.utools?.copyText(text)
                  showToast('日志已复制', 'success')
                }}
              >复制
              </button>
              <button className='btn btn-ghost btn-sm' onClick={() => { window.services?.clearLogs(); setLogs([]) }}>清空</button>
            </div>
          </div>
          <div className='log-content'>
            {logs.length === 0
              ? (
                <div className='log-empty'>暂无日志</div>
                )
              : (
                  logs.map((log, i) => (
                    <div key={i} className={`log-line log-${log.type}`}>
                      <span className='log-time'>{formatTime(log.time)}</span>
                      <span className='log-text'>{log.text}</span>
                    </div>
                  ))
                )}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </>
  )
}
