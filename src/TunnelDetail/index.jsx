import { useState, useEffect, useRef, useCallback } from 'react'
import { ClipboardCopy, Play, Square, FolderOpen } from 'lucide-react'
import './index.css'

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

  const syncHostStatus = useCallback(() => {
    try {
      const status = window.services?.getHostStatus()
      setRunning(Boolean(status?.running && window.__runningTunnelId === tunnelId))
    } catch (e) { setRunning(false) }
  }, [tunnelId])

  // 从缓存获取URL
  useEffect(() => {
    const url = window.services?.getTunnelUrl(tunnelId)
    if (url) setTunnelUrl(url)
  }, [tunnelId, logs])

  // 日志监听 + 隧道退出事件
  useEffect(() => {
    const history = window.services?.getLogBuffer() || []
    setLogs(history.map(h => ({ ...h, time: new Date(h.time) })))

    const onLogEntry = (e) => setLogs(prev => [...prev, { ...e.detail, time: new Date(e.detail.time) }])
    const onExit = () => {
      syncHostStatus()
      setTunnelUrl(window.services?.getTunnelUrl(tunnelId) || '')
    }
    const onUrl = (e) => {
      syncHostStatus()
      if (e.detail.tunnelId === tunnelId) setTunnelUrl(e.detail.url)
    }
    window.addEventListener('tunnel-log-entry', onLogEntry)
    window.addEventListener('tunnel-exit', onExit)
    window.addEventListener('tunnel-url', onUrl)
    window.addEventListener('tunnel-host-status', syncHostStatus)
    syncHostStatus()
    return () => {
      window.removeEventListener('tunnel-log-entry', onLogEntry)
      window.removeEventListener('tunnel-exit', onExit)
      window.removeEventListener('tunnel-url', onUrl)
      window.removeEventListener('tunnel-host-status', syncHostStatus)
    }
  }, [tunnelId, syncHostStatus])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  // 异步加载完整数据（含端口）
  useEffect(() => {
    let cancelled = false
    const loadFull = async () => {
      setLoading(true)
      try {
        if (window.services && tunnelId) {
          const full = await window.services.getTunnelWithPorts(tunnelId)
          if (full && !cancelled) {
            setTunnel(full)
            setPort(full.ports?.[0]?.portNumber?.toString() || '')
            setProtocol(full.ports?.[0]?.protocol || 'auto')
            setDescription(full.description || '')
          }
        }
      } catch (e) {}
      if (!cancelled) setLoading(false)
    }
    loadFull()
    return () => { cancelled = true }
  }, [tunnelId])

  const handleCancelEdit = useCallback(() => {
    setPort(tunnel.ports?.[0]?.portNumber?.toString() || '')
    setProtocol(tunnel.ports?.[0]?.protocol || 'auto')
    setDescription(tunnel.description || '')
    setEditing(false)
  }, [tunnel])

  const handleSave = useCallback(async () => {
    if (saving || loading) return
    const newPort = Number(port)
    if (!/^\d+$/.test(port) || !Number.isInteger(newPort) || newPort < 1 || newPort > 65535) {
      showToast('端口号必须是 1-65535 之间的整数', 'error')
      return
    }
    setSaving(true)
    try {
      const current = await window.services.getTunnelWithPorts(tunnelId)
      if (!current) throw new Error('无法读取当前隧道配置，请稍后重试')
      const oldPort = current.ports?.[0]?.portNumber
      const oldProtocol = current.ports?.[0]?.protocol || 'auto'

      if (newPort !== Number(oldPort)) {
        // 先确认新端口可用，再删除旧端口；删除失败时撤回新增端口。
        await window.services.addPort(tunnelId, newPort, protocol)
        if (oldPort) {
          try {
            await window.services.deletePort(tunnelId, oldPort)
          } catch (error) {
            try { await window.services.deletePort(tunnelId, newPort) } catch (rollbackError) {
              throw new Error(error.message + '；新端口回滚失败：' + rollbackError.message)
            }
            throw error
          }
        }
      } else if (protocol !== oldProtocol) {
        // 相同端口无法并存，重建失败时尽力恢复原协议。
        await window.services.deletePort(tunnelId, oldPort)
        try {
          await window.services.addPort(tunnelId, newPort, protocol)
        } catch (error) {
          try { await window.services.addPort(tunnelId, oldPort, oldProtocol) } catch (rollbackError) {
            throw new Error(error.message + '；原端口恢复失败：' + rollbackError.message)
          }
          throw error
        }
      }

      await window.services.updateTunnel(tunnelId, { description })
      const full = await window.services.getTunnelWithPorts(tunnelId)
      if (!full) throw new Error('配置可能已保存，但读取最新详情失败，请刷新后确认')
      setTunnel(full)
      setPort(full.ports?.[0]?.portNumber?.toString() || '')
      setProtocol(full.ports?.[0]?.protocol || 'auto')
      setDescription(full.description || '')
      setEditing(false)
      showToast('已保存', 'success')
    } catch (err) {
      showToast('保存失败: ' + err.message, 'error')
    }
    setSaving(false)
  }, [tunnelId, description, port, protocol, saving, loading, showToast])

  const handleCopyUrl = useCallback(() => {
    if (!tunnelUrl) {
      showToast('请先启动隧道', 'error')
      return
    }
    window.utools?.copyText(tunnelUrl)
    showToast('URL 已复制', 'success')
  }, [tunnelUrl, showToast])

  const handleStart = useCallback(async () => {
    let portNum = tunnel.ports?.[0]?.portNumber
    if (!portNum) {
      try {
        const full = await window.services.getTunnelWithPorts(tunnelId)
        portNum = full?.ports?.[0]?.portNumber
      } catch (err) {}
    }
    if (!portNum) { showToast('请先配置端口', 'error'); return }

    // 代理目录隧道：先启动本地文件服务器
    if (dirProxyPath) {
      const fsResult = await window.services.startFileServer(dirProxyPath, portNum)
      if (!fsResult.success) {
        showToast('文件服务器启动失败: ' + fsResult.message, 'error')
        return
      }
    }

    const result = await window.services.startHost(tunnelId, portNum)
    if (result.success) {
      syncHostStatus()
      showToast('启动中...')
    } else {
      // 启动失败时回滚文件服务器
      if (dirProxyPath) window.services.stopFileServer()
      showToast('启动失败: ' + result.message, 'error')
    }
  }, [tunnelId, tunnel, dirProxyPath, syncHostStatus, showToast])

  const handleStop = useCallback(async () => {
    const result = await window.services.stopHost()
    if (result.success) {
      syncHostStatus()
      showToast('已停止', 'success')
    } else {
      showToast('停止失败: ' + result.message, 'error')
    }
  }, [syncHostStatus, showToast])

  const formatTime = (d) => d instanceof Date ? d.toLocaleTimeString('zh-CN', { hour12: false }) : ''

  return (
    <>
      <div className='topbar'>
        <div className='topbar-left'>
          <button className='back-btn' onClick={onBack} title='返回'>
            <svg width='16' height='16' viewBox='0 0 16 16' fill='none'>
              <path d='M10 12L6 8L10 4' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'/>
            </svg>
          </button>
          <span className='topbar-title'>
            {dirProxyPath ? <><FolderOpen size={16} style={{ marginRight: 4, verticalAlign: 'middle' }} />代理目录详情</> : '隧道详情'}
          </span>
          {running && <span className='badge badge-success'>运行中</span>}
          {loading && <span className='spinner' />}
        </div>
        <div className='topbar-right'>
          {editing ? (
            <>
              <button className='btn btn-ghost btn-sm' onClick={handleCancelEdit} disabled={saving}>取消</button>
              <button className='btn btn-brand btn-sm' onClick={handleSave} disabled={saving || loading}>
                {saving ? '保存中...' : '保存'}
              </button>
            </>
          ) : (
            <>
              {running ? (
                <button className='btn btn-warning btn-sm' onClick={handleStop}>
                  <Square size={13} /> 停止
                </button>
              ) : (
                <button className='btn btn-brand btn-sm' onClick={handleStart}>
                  <Play size={13} /> 启动
                </button>
              )}
              <button className='btn btn-ghost btn-sm' onClick={() => setEditing(true)} disabled={loading}>编辑</button>
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

            {editing ? (
              <>
                <div className='info-item'>
                  <span className='info-label'>端口号</span>
                  <input className='form-input' type='number' value={port} disabled={saving} onChange={(e) => setPort(e.target.value)} placeholder='80、3000、8080...' min='1' max='65535' />
                </div>
                <div className='info-item'>
                  <span className='info-label'>协议</span>
                  <select className='form-select' value={protocol} disabled={saving} onChange={(e) => setProtocol(e.target.value)}>
                    <option value='auto'>自动 (auto)</option>
                    <option value='http'>HTTP</option>
                    <option value='https'>HTTPS</option>
                  </select>
                </div>
                <div className='info-item'>
                  <span className='info-label'>描述</span>
                  <input className='form-input' type='text' value={description} disabled={saving} onChange={(e) => setDescription(e.target.value)} placeholder='隧道用途说明' />
                </div>
              </>
            ) : (
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
                  {tunnelUrl ? (
                    <span className='info-val url' onClick={handleCopyUrl} title='点击复制'>{tunnelUrl} <ClipboardCopy size={13} /></span>
                  ) : (
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
              <button className='btn btn-ghost btn-sm' onClick={() => {
                const text = logs.map(l => `[${formatTime(l.time)}] [${l.type}] ${l.text}`).join('\n')
                window.utools?.copyText(text)
                showToast('日志已复制', 'success')
              }}>复制</button>
              <button className='btn btn-ghost btn-sm' onClick={() => { window.services?.clearLogs(); setLogs([]) }}>清空</button>
            </div>
          </div>
          <div className='log-content'>
            {logs.length === 0 ? (
              <div className='log-empty'>暂无日志</div>
            ) : (
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
