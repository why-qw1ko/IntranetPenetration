import { useState, useCallback, useEffect, useRef } from 'react'
import { ClipboardCopy, Globe, Square, Play, BookOpen, Lightbulb, Server, Link2 } from 'lucide-react'
import ConfirmModal from '../ConfirmModal'
import './index.css'

export default function ProxyDir ({ onToggleSidebar, showToast }) {
  const [mode, setMode] = useState('devtunnel') // 'devtunnel' | 'frp'
  const [dirPath, setDirPath] = useState('')
  const [port, setPort] = useState('3000')
  const [allowAnonymous, setAllowAnonymous] = useState(true)
  const [running, setRunning] = useState(false)
  const [loading, setLoading] = useState(false)
  const [tunnelUrl, setTunnelUrl] = useState('')
  const [error, setError] = useState('')
  const [serverInfo, setServerInfo] = useState(null)
  const tunnelIdRef = useRef(null)

  // 已有隧道确认弹窗
  const [existingTunnel, setExistingTunnel] = useState(null)
  const [matchType, setMatchType] = useState('') // 'same' | 'sameDir' | 'samePort'
  const [showConfirm, setShowConfirm] = useState(false)

  // frp 模式相关
  const [frpConfig, setFrpConfig] = useState(null)
  const [frpProxyType, setFrpProxyType] = useState('tcp') // 'tcp' | 'http'
  const [frpRemotePort, setFrpRemotePort] = useState('8080')
  const [frpDomain, setFrpDomain] = useState('')

  // 加载 frp 配置和代理目录 frp 设置
  useEffect(() => {
    const loadFrp = async () => {
      try {
        const saved = await window.services?.getFrpConfig?.()
        if (saved?.server?.serverAddr) {
          setFrpConfig(saved.server)
        }
      } catch (e) {}
    }
    // 加载代理目录 frp 模式的设置（本地存储）
    try {
      const frpSettings = window.services?.getProxyDirFrpSettings?.()
      if (frpSettings) {
        if (frpSettings.proxyType) setFrpProxyType(frpSettings.proxyType)
        if (frpSettings.remotePort) setFrpRemotePort(frpSettings.remotePort)
        if (frpSettings.domain) setFrpDomain(frpSettings.domain)
      }
    } catch (e) {}
    loadFrp()
  }, [])

  // 保存代理目录 frp 模式的设置（含当前 URL，本地存储）
  const frpSettingsRef = useRef(null)
  useEffect(() => {
    // 跳过首次渲染
    if (frpSettingsRef.current === null) {
      frpSettingsRef.current = true
      return
    }
    const timer = setTimeout(() => {
      try {
        const existing = window.services?.getProxyDirFrpSettings?.()
        const existingUrl = existing?.url || ''
        window.services?.saveProxyDirFrpSettings?.({
          proxyType: frpProxyType,
          remotePort: frpRemotePort,
          domain: frpDomain,
          url: tunnelUrl || existingUrl
        })
      } catch (e) {}
    }, 500)
    return () => clearTimeout(timer)
  }, [frpProxyType, frpRemotePort, frpDomain, tunnelUrl])

  // 恢复运行状态和保存的目录
  useEffect(() => {
    // 恢复保存的目录和设置（本地存储）
    let savedDirPath = ''
    try {
      const savedDir = window.services?.getProxyDirSettings?.()
      if (savedDir?.dirPath) {
        savedDirPath = savedDir.dirPath
        setDirPath(savedDir.dirPath)
      }
      if (savedDir?.port) setPort(savedDir.port)
      if (savedDir?.mode) setMode(savedDir.mode)
      if (savedDir?.allowAnonymous !== undefined) setAllowAnonymous(savedDir.allowAnonymous)
    } catch (e) {}

    // 恢复运行状态
    const fsStatus = window.services?.getFileServerStatus()
    const hostStatus = window.services?.getHostStatus()
    const frpcStatus = window.services?.getFrpcStatus?.()

    if (frpcStatus?.running) {
      // frpc 模式运行中：恢复 mode 和 tunnelUrl
      setRunning(true)
      setMode('frp')
      const dir = savedDirPath || '(已启动)'
      setServerInfo({ port: fsStatus?.port || port, dir })
      // 从保存的 frp 设置恢复 URL（本地存储）
      try {
        const frpSettings = window.services?.getProxyDirFrpSettings?.()
        if (frpSettings?.url) {
          setTunnelUrl(frpSettings.url)
        }
      } catch (e) {}
    } else if (fsStatus?.running) {
      // 文件服务器运行中（代理目录 devtunnel 模式）
      setRunning(true)
      setMode('devtunnel')
      setPort(String(fsStatus.port))
      setDirPath(fsStatus.dir)
      setServerInfo({ port: fsStatus.port, dir: fsStatus.dir })
      // 恢复 tunnel URL：先从缓存获取，如果没有则从日志中提取
      if (hostStatus?.running && window.__runningTunnelId) {
        let cachedUrl = window.services?.getTunnelUrl(window.__runningTunnelId)
        // 缓存没有时，从日志中提取
        if (!cachedUrl) {
          const logs = window.services?.getLogBuffer?.() || []
          for (let i = logs.length - 1; i >= 0; i--) {
            const matches = logs[i].text?.match(/https:\/\/\S+\.devtunnels\.ms/g)
            if (matches?.length > 0) {
              cachedUrl = matches.length > 1 ? matches[1] : matches[0]
              break
            }
          }
        }
        if (cachedUrl) setTunnelUrl(cachedUrl)
      }
    }
  }, [])

  // 监听隧道 URL 和退出事件（devtunnel 模式）
  useEffect(() => {
    const onUrl = (e) => {
      if (mode !== 'devtunnel') return
      setTunnelUrl(e.detail.url)
      showToast('隧道已就绪')
    }
    const onExit = () => {
      setRunning(false)
      setLoading(false)
      setTunnelUrl('')
      setServerInfo(null)
      tunnelIdRef.current = null
    }
    const onError = (e) => {
      if (mode !== 'devtunnel') return
      showToast('隧道错误: ' + e.detail, 'error')
    }

    window.addEventListener('tunnel-url', onUrl)
    window.addEventListener('tunnel-exit', onExit)
    window.addEventListener('tunnel-error', onError)
    return () => {
      window.removeEventListener('tunnel-url', onUrl)
      window.removeEventListener('tunnel-exit', onExit)
      window.removeEventListener('tunnel-error', onError)
    }
  }, [showToast, mode])

  // 监听 frpc 事件（frp 模式，仅处理来自 proxydir 的）
  useEffect(() => {
    const onFrpcExit = (e) => {
      if (e.source && e.source !== 'proxydir') return
      setRunning(false)
      setLoading(false)
      setServerInfo(null)
    }
    const onFrpcError = (e) => {
      if (e.source && e.source !== 'proxydir') return
      const msg = e.detail || '未知错误'
      setError('frpc 错误: ' + msg)
      showToast('frpc 错误: ' + msg, 'error')
    }
    const onFrpcLog = (e) => {
      if (e.source && e.source !== 'proxydir') return
      // 从日志中提取访问地址
      const text = e.detail || ''
      const domainMatch = text.match(/custom domain \[(\S+)\]/i)
      if (domainMatch) {
        setTunnelUrl('http://' + domainMatch[1])
      }
    }

    window.addEventListener('frpc-exit', onFrpcExit)
    window.addEventListener('frpc-error', onFrpcError)
    window.addEventListener('frpc-log', onFrpcLog)
    return () => {
      window.removeEventListener('frpc-exit', onFrpcExit)
      window.removeEventListener('frpc-error', onFrpcError)
      window.removeEventListener('frpc-log', onFrpcLog)
    }
  }, [showToast, mode])

  // 保存代理目录设置到本地存储
  const saveProxyDirSettings = useCallback(() => {
    try {
      window.services?.saveProxyDirSettings?.({ dirPath, port, mode, allowAnonymous })
    } catch (e) {}
  }, [dirPath, port, mode, allowAnonymous])

  const handleSelectDir = useCallback(() => {
    const dir = window.services?.selectDirectory()
    if (dir) {
      setDirPath(dir)
      setError('')
      // 保存目录到本地存储
      try {
        window.services?.saveProxyDirSettings?.({ dirPath: dir, port, mode, allowAnonymous })
      } catch (e) {}
    }
  }, [port, mode, allowAnonymous])

  // 检查是否有已存在的隧道
  // 返回：{ tunnel, matchType } 或 null
  // matchType: 'same'(同目录+同端口) | 'sameDir'(同目录+不同端口) | 'samePort'(同端口+不同目录)
  const checkExistingTunnel = useCallback(async () => {
    try {
      const targetPort = parseInt(port)
      const dirDesc = '代理目录: ' + dirPath

      // 1. 先检查本地存储中保存的隧道（只查一次）
      const saved = window.services?.getProxyDirLastTunnel?.()
      if (saved?.tunnelId) {
        try {
          const tunnel = await window.services.getTunnelWithPorts(saved.tunnelId)
          if (tunnel?.tunnelId) {
            const hasSamePort = tunnel.ports?.some(p => p.portNumber === targetPort)
            const hasSameDir = tunnel.description === dirDesc

            if (hasSameDir && hasSamePort) return { tunnel, matchType: 'same' }
            if (hasSameDir && !hasSamePort) return { tunnel, matchType: 'sameDir' }
            if (!hasSameDir && hasSamePort) return { tunnel, matchType: 'samePort' }
          }
        } catch (e) {}
      }

      // 2. 查询所有隧道（listTunnels 已并行获取端口信息），直接在内存中匹配
      const tunnels = await window.services.listTunnels()

      // 优先级：同目录+同端口 > 同目录+不同端口 > 同端口+不同目录
      let sameMatch = null
      let sameDirMatch = null
      let samePortMatch = null

      for (const t of tunnels) {
        const hasSamePort = t.ports?.some(p => p.portNumber === targetPort)
        const hasSameDir = t.description === dirDesc

        if (hasSameDir && hasSamePort && !sameMatch) {
          sameMatch = t
        } else if (hasSameDir && !hasSamePort && !sameDirMatch) {
          sameDirMatch = t
        } else if (!hasSameDir && hasSamePort && !samePortMatch) {
          samePortMatch = t
        }
      }

      if (sameMatch) return { tunnel: sameMatch, matchType: 'same' }
      if (sameDirMatch) return { tunnel: sameDirMatch, matchType: 'sameDir' }
      if (samePortMatch) return { tunnel: samePortMatch, matchType: 'samePort' }
    } catch (e) {}
    return null
  }, [port, dirPath])

  // 启用已有隧道（处理 sameDir 和 samePort 两种情况）
  const handleUseExisting = useCallback(async () => {
    setShowConfirm(false)
    if (!existingTunnel) return

    setLoading(true)
    try {
      // 0. 先停止已有的隧道进程
      const hostStatus = window.services.getHostStatus()
      if (hostStatus.running) {
        window.services.stopHost()
      }

      // 1. 启动本地文件服务器
      const fsResult = await window.services.startFileServer(dirPath, parseInt(port))
      if (!fsResult.success) {
        setError(fsResult.message)
        setLoading(false)
        return
      }

      const tid = existingTunnel.tunnelId
      const targetPort = parseInt(port)

      // 2. sameDir：更新端口（删除旧端口，添加新端口）
      if (matchType === 'sameDir') {
        const oldPort = existingTunnel.ports?.[0]?.portNumber
        if (oldPort) {
          try { await window.services.deletePort(tid, oldPort) } catch (e) {}
        }
        try { await window.services.addPort(tid, targetPort, 'auto') } catch (e) {}
      }

      // 3. samePort：更新隧道描述为新目录
      if (matchType === 'samePort') {
        try {
          await window.services.updateTunnel(tid, { description: '代理目录: ' + dirPath })
        } catch (e) {}
      }

      // 4. 启动隧道
      const hostResult = window.services.startHost(tid, targetPort, allowAnonymous)
      if (!hostResult.success) {
        setError(hostResult.message)
        window.services.stopFileServer()
        setLoading(false)
        return
      }

      // 5. 保存 tunnelId 到本地存储
      try {
        window.services?.saveProxyDirLastTunnel?.({ port: targetPort, tunnelId: tid })
      } catch (e) {}

      window.__runningTunnelId = tid
      tunnelIdRef.current = tid
      setRunning(true)
      setServerInfo({ port: targetPort, dir: dirPath })
      window.services?.addProxyDirLog?.('system', '[代理目录] devtunnel 模式启动: ' + dirPath + ' -> 端口 ' + port, 'devtunnel')
      showToast('正在启动...')
    } catch (err) {
      setError(err.message || '启动失败')
      window.services.stopFileServer()
    }
    setLoading(false)
    setExistingTunnel(null)
    setMatchType('')
  }, [existingTunnel, matchType, dirPath, port, allowAnonymous, showToast])

  // 实际创建隧道的逻辑
  const doStartDevtunnel = useCallback(async () => {
    setLoading(true)
    try {
      // 0. 先停止已有的隧道进程
      const hostStatus = window.services.getHostStatus()
      if (hostStatus.running) {
        window.services.stopHost()
      }

      // 1. 启动本地文件服务器（等待端口真正监听）
      const fsResult = await window.services.startFileServer(dirPath, parseInt(port))
      if (!fsResult.success) {
        setError(fsResult.message)
        setLoading(false)
        return
      }

      // 2. 创建 devtunnel
      const tunnel = await window.services.createTunnel({
        port: parseInt(port),
        protocol: 'auto',
        anonymous: allowAnonymous,
        description: '代理目录: ' + dirPath
      })

      const tid = tunnel.tunnelId || tunnel.tunnel_id || tunnel.id
      tunnelIdRef.current = tid

      // 3. 启动隧道
      const hostResult = window.services.startHost(tid, parseInt(port), allowAnonymous)
      if (!hostResult.success) {
        setError(hostResult.message)
        window.services.stopFileServer()
        setLoading(false)
        return
      }

      // 4. 保存 tunnelId 到本地存储
      try {
        window.services?.saveProxyDirLastTunnel?.({ port: parseInt(port), tunnelId: tid })
      } catch (e) {}

      window.__runningTunnelId = tid
      setRunning(true)
      setServerInfo({ port: parseInt(port), dir: dirPath })
      window.services?.addProxyDirLog?.('system', '[代理目录] devtunnel 模式启动: ' + dirPath + ' -> 端口 ' + port, 'devtunnel')
      showToast('正在启动...')
    } catch (err) {
      setError(err.message || '启动失败')
      window.services.stopFileServer()
    }
    setLoading(false)
  }, [dirPath, port, allowAnonymous, showToast])

  // 创建新隧道
  const handleCreateNew = useCallback(async () => {
    setShowConfirm(false)
    setExistingTunnel(null)
    setMatchType('')
    await doStartDevtunnel()
  }, [doStartDevtunnel])

  // 同目录+同端口：直接复用，不弹窗
  const handleDirectReuse = useCallback(async (tunnel) => {
    setLoading(true)
    try {
      const hostStatus = window.services.getHostStatus()
      if (hostStatus.running) {
        window.services.stopHost()
      }

      const fsResult = await window.services.startFileServer(dirPath, parseInt(port))
      if (!fsResult.success) {
        setError(fsResult.message)
        setLoading(false)
        return
      }

      const tid = tunnel.tunnelId
      const hostResult = window.services.startHost(tid, parseInt(port), allowAnonymous)
      if (!hostResult.success) {
        setError(hostResult.message)
        window.services.stopFileServer()
        setLoading(false)
        return
      }

      try {
        window.services?.saveProxyDirLastTunnel?.({ port: parseInt(port), tunnelId: tid })
      } catch (e) {}

      window.__runningTunnelId = tid
      tunnelIdRef.current = tid
      setRunning(true)
      setServerInfo({ port: parseInt(port), dir: dirPath })
      window.services?.addProxyDirLog?.('system', '[代理目录] devtunnel 模式启动: ' + dirPath + ' -> 端口 ' + port, 'devtunnel')
      showToast('正在启动...')
    } catch (err) {
      setError(err.message || '启动失败')
      window.services.stopFileServer()
    }
    setLoading(false)
  }, [dirPath, port, allowAnonymous, showToast])

  const handleStartDevtunnel = useCallback(async () => {
    setLoading(true)
    showToast('正在检查隧道配置，请耐心等待...')
    try {
      // 先检查是否有已存在的隧道
      const result = await checkExistingTunnel()
      if (result) {
        setLoading(false)
        // 同目录+同端口：直接复用，不弹窗
        if (result.matchType === 'same') {
          await handleDirectReuse(result.tunnel)
          return
        }
        // 同目录+不同端口 或 同端口+不同目录：弹窗确认
        setExistingTunnel(result.tunnel)
        setMatchType(result.matchType)
        setShowConfirm(true)
        return
      }
      // 无匹配：创建新隧道
      await doStartDevtunnel()
    } catch (err) {
      setLoading(false)
      setError(err.message || '检查隧道失败')
    }
  }, [checkExistingTunnel, doStartDevtunnel, handleDirectReuse, showToast])

  const handleStartFrp = useCallback(async () => {
    if (!frpConfig?.serverAddr) {
      setError('请先在 Frp 内网穿透页面配置服务器')
      return
    }
    if (frpProxyType === 'http' && !frpDomain) {
      setError('请输入自定义域名')
      return
    }
    if (frpProxyType === 'tcp' && (!frpRemotePort || parseInt(frpRemotePort) < 1)) {
      setError('请输入有效的远程端口')
      return
    }

    setLoading(true)
    try {
      // 1. 启动本地文件服务器（等待端口真正监听）
      const fsResult = await window.services.startFileServer(dirPath, parseInt(port), 'frp')
      if (!fsResult.success) {
        setError(fsResult.message)
        setLoading(false)
        return
      }

      // 2. 启动 frpc
      const proxyConfig = {
        name: 'proxydir-' + Date.now(),
        type: frpProxyType,
        localPort: parseInt(port),
        remotePort: frpProxyType === 'tcp' ? parseInt(frpRemotePort) : undefined,
        customDomain: frpProxyType === 'http' ? frpDomain : undefined
      }
      const result = window.services.startFrpc(frpConfig, [proxyConfig], 'proxydir')
      if (!result.success) {
        setError(result.message)
        window.services.stopFileServer('frp')
        setLoading(false)
        return
      }

      setRunning(true)
      setServerInfo({ port: parseInt(port), dir: dirPath })
      let url = ''
      if (frpProxyType === 'tcp') {
        url = frpConfig.serverAddr + ':' + frpRemotePort
      } else {
        url = 'http://' + frpDomain
      }
      setTunnelUrl(url)

      // 主动保存 frp 设置（确保重启后能恢复 URL，本地存储）
      try {
        window.services?.saveProxyDirFrpSettings?.({
          proxyType: frpProxyType,
          remotePort: frpRemotePort,
          domain: frpDomain,
          url
        })
      } catch (e) {}

      window.services?.addProxyDirLog?.('system', '[代理目录] frp 模式启动: ' + dirPath + ' -> 端口 ' + port, 'frp')
      showToast('正在启动 frpc...')
    } catch (err) {
      setError(err.message || '启动失败')
      window.services.stopFileServer('frp')
    }
    setLoading(false)
  }, [dirPath, port, frpConfig, frpProxyType, frpRemotePort, frpDomain, showToast])

  const handleCancelConfirm = useCallback(() => {
    setShowConfirm(false)
    setExistingTunnel(null)
    setMatchType('')
  }, [])

  const handleStart = useCallback(async () => {
    setError('')
    if (!dirPath) { setError('请选择要代理的目录'); return }
    if (!port || parseInt(port) < 1 || parseInt(port) > 65535) { setError('请输入有效端口号 (1-65535)'); return }

    if (mode === 'frp') {
      await handleStartFrp()
    } else {
      await handleStartDevtunnel()
    }
  }, [dirPath, port, allowAnonymous, mode, frpConfig, frpDomain, handleStartFrp, handleStartDevtunnel, showToast])

  const handleStop = useCallback(() => {
    window.services?.addProxyDirLog?.('system', '[代理目录] 停止代理 (' + mode + ' 模式)', mode)
    if (mode === 'frp') {
      window.services.stopFrpc()
    } else {
      window.services.stopHost()
      window.__runningTunnelId = null
    }
    window.services.stopFileServer(mode)
    setRunning(false)
    setTunnelUrl('')
    setServerInfo(null)
    tunnelIdRef.current = null
    showToast('已停止', 'success')
  }, [mode, showToast])

  const handleCopyUrl = useCallback(() => {
    if (tunnelUrl) {
      window.utools?.copyText(tunnelUrl)
      showToast('URL 已复制', 'success')
    }
  }, [tunnelUrl, showToast])

  const handleOpenBrowser = useCallback(() => {
    if (tunnelUrl) {
      try { window.utools.shellOpenExternal(tunnelUrl) } catch (e) {
        try { require('electron').shell.openExternal(tunnelUrl) } catch (e2) {}
      }
    }
  }, [tunnelUrl])

  return (
    <>
      <div className='topbar'>
        <div className='topbar-left'>
          <button className='topbar-menu-btn' onClick={onToggleSidebar} title='菜单'>
            <svg width='18' height='18' viewBox='0 0 18 18' fill='none'>
              <path d='M3 5H15M3 9H15M3 13H15' stroke='currentColor' strokeWidth='1.5' strokeLinecap='round'/>
            </svg>
          </button>
          <span className='topbar-title'>代理目录</span>
          {running && <span className='badge badge-success'>运行中</span>}
        </div>
      </div>

      <div className='page'>
        {/* 模式选择（未运行时显示） */}
        {!running && (
          <div className='card mode-card'>
            <div className='card-header'>
              <span className='card-title'>穿透方式</span>
            </div>
            <div className='mode-options'>
              <button
                className={`mode-option ${mode === 'devtunnel' ? 'active' : ''}`}
                onClick={() => setMode('devtunnel')}
              >
                <span className='mode-option-icon'><Globe size={18} /></span>
                <div>
                  <div className='mode-option-title'>DevTunnel（免费）</div>
                  <div className='mode-option-desc'>微软免费隧道服务，无需服务器</div>
                </div>
              </button>
              <button
                className={`mode-option ${mode === 'frp' ? 'active' : ''}`}
                onClick={() => setMode('frp')}
              >
                <span className='mode-option-icon'><Link2 size={18} /></span>
                <div>
                  <div className='mode-option-title'>Frp（自建服务器）</div>
                  <div className='mode-option-desc'>通过你的 frps 服务器穿透</div>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* 运行状态（启动后显示） */}
        {running && serverInfo && (
          <div className='card status-card'>
            <div className='status-header'>
              <span className='status-dot'>运行中</span>
              <span className='badge badge-blue'>{mode === 'frp' ? 'Frp' : 'DevTunnel'}</span>
            </div>
            <div className='status-info'>
              <span className='status-info-label'>目录</span>
              <span className='status-info-value'>{serverInfo.dir}</span>
            </div>
            <div className='status-info'>
              <span className='status-info-label'>端口</span>
              <span className='status-info-value'>{serverInfo.port}</span>
            </div>
            {tunnelUrl && (
              <div className='status-url' onClick={handleCopyUrl} title='点击复制'>
                <span className='status-url-text'>{tunnelUrl}</span>
                <span className='status-url-hint'><ClipboardCopy size={13} /> 点击复制</span>
              </div>
            )}
            <div className='status-actions'>
              {tunnelUrl && (
                <>
                  <button className='btn btn-ghost btn-sm' onClick={handleCopyUrl}><ClipboardCopy size={13} /> 复制 URL</button>
                  <button className='btn btn-ghost btn-sm' onClick={handleOpenBrowser}><Globe size={13} /> 浏览器打开</button>
                </>
              )}
              <button className='btn btn-warning btn-sm' onClick={handleStop}><Square size={13} /> 停止代理</button>
            </div>
          </div>
        )}

        {/* 配置表单（未运行时显示） */}
        {!running && (
          <>
            <div className='card'>
              <div className='card-header'>
                <span className='card-title'>基本配置</span>
              </div>

              <div className='form-group'>
                <label className='form-label'>本地目录 *</label>
                <div className='dir-row'>
                  <input
                    className='form-input dir-input'
                    type='text'
                    value={dirPath}
                    onChange={(e) => { setDirPath(e.target.value); setError('') }}
                    placeholder='选择或输入要分享的本地目录路径'
                  />
                  <button className='btn btn-ghost' onClick={handleSelectDir}>浏览</button>
                </div>
                <div className='form-hint'>选择要通过隧道暴露的本地文件夹</div>
              </div>

              <div className='form-group'>
                <label className='form-label'>端口号 *</label>
                <input
                  className='form-input port-input'
                  type='number'
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder='3000'
                  min='1'
                  max='65535'
                />
                <div className='form-hint'>本地 HTTP 服务器监听端口，默认 3000</div>
              </div>

              {mode === 'devtunnel' && (
                <>
                  <label className='form-checkbox'>
                    <input type='checkbox' checked={allowAnonymous} onChange={(e) => setAllowAnonymous(e.target.checked)} />
                    允许匿名访问
                  </label>
                  <div className='form-hint' style={{ marginLeft: 26 }}>开启后任何人可通过 URL 访问文件</div>
                </>
              )}

              {mode === 'frp' && (
                <>
                  {!frpConfig?.serverAddr ? (
                    <div className='frp-hint-box'>
                      <Server size={14} />
                      <span>请先到「Frp 内网穿透」页面配置服务器</span>
                    </div>
                  ) : (
                    <div className='frp-server-summary'>
                      <div className='status-info'>
                        <span className='status-info-label'>服务器</span>
                        <span className='status-info-value'>{frpConfig.serverAddr}:{frpConfig.serverPort || 7000}</span>
                      </div>
                    </div>
                  )}

                  <div className='form-group' style={{ marginTop: 12 }}>
                    <label className='form-label'>代理类型</label>
                    <div className='frp-type-options'>
                      <button
                        className={`frp-type-btn ${frpProxyType === 'tcp' ? 'active' : ''}`}
                        onClick={() => setFrpProxyType('tcp')}
                      >
                        TCP 端口
                      </button>
                      <button
                        className={`frp-type-btn ${frpProxyType === 'http' ? 'active' : ''}`}
                        onClick={() => setFrpProxyType('http')}
                      >
                        HTTP 域名
                      </button>
                    </div>
                  </div>

                  {frpProxyType === 'tcp' && (
                    <div className='form-group'>
                      <label className='form-label'>远程端口 *</label>
                      <input
                        className='form-input port-input'
                        type='number'
                        value={frpRemotePort}
                        onChange={(e) => setFrpRemotePort(e.target.value)}
                        placeholder='8080'
                        min='1'
                        max='65535'
                      />
                      <div className='form-hint'>通过 服务器IP:远程端口 访问</div>
                    </div>
                  )}

                  {frpProxyType === 'http' && (
                    <div className='form-group'>
                      <label className='form-label'>自定义域名 *</label>
                      <input
                        className='form-input'
                        type='text'
                        value={frpDomain}
                        onChange={(e) => setFrpDomain(e.target.value)}
                        placeholder='files.your-server.com'
                      />
                      <div className='form-hint'>需要在 frps 配置泛域名解析，通过此域名访问文件</div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* 教程 */}
            <div className='tutorial-card'>
              <div className='tutorial-title'><BookOpen size={15} /> 快速上手</div>
              <ol className='tutorial-steps'>
                <li>
                  <span className='step-num'>1</span>
                  <span>选择穿透方式{mode === 'devtunnel' ? '（免费，无需服务器）' : '（需要 frps 服务器）'}</span>
                </li>
                <li>
                  <span className='step-num'>2</span>
                  <span>点击「浏览」选择要分享的本地文件夹</span>
                </li>
                <li>
                  <span className='step-num'>3</span>
                  <span>
                    {mode === 'devtunnel'
                      ? '设置端口号（默认 3000，如果被占用请更换）'
                      : '填写自定义域名（需在 frps 配置泛域名解析）'}
                  </span>
                </li>
                <li>
                  <span className='step-num'>4</span>
                  <span>点击「启动代理」按钮</span>
                </li>
              </ol>

              <div className='tutorial-faq'>
                <div className='tutorial-faq-title'><Lightbulb size={14} /> 常见问题</div>
                <div className='faq-item'>
                  <div className='faq-q'>Q: 两种方式有什么区别？</div>
                  <div className='faq-a'>A: DevTunnel 免费但需要微软账号登录；Frp 需要自建服务器但速度更快、更灵活。</div>
                </div>
                <div className='faq-item'>
                  <div className='faq-q'>Q: 支持哪些文件类型？</div>
                  <div className='faq-a'>A: 支持所有文件类型。HTML/CSS/JS/图片等常见格式会直接在浏览器中预览，其他文件会触发下载。</div>
                </div>
                <div className='faq-item'>
                  <div className='faq-q'>Q: 端口被占用怎么办？</div>
                  <div className='faq-a'>A: 更换一个未被使用的端口号即可，如 3001、8080 等。</div>
                </div>
              </div>
            </div>

            {/* 错误提示 */}
            {error && (
              <div className='card' style={{ borderLeft: '3px solid var(--red)', color: 'var(--red)', fontSize: 13 }}>
                {error}
              </div>
            )}

            {/* 启动按钮 */}
            <button className='btn btn-brand btn-block' onClick={handleStart} disabled={loading}>
              {loading ? <><span className='spinner' /> 启动中...</> : <><Play size={14} /> 启动代理</>}
            </button>
          </>
        )}
      </div>

      {/* 已有隧道确认弹窗 */}
      {showConfirm && existingTunnel && (
        <ConfirmModal
          title={matchType === 'sameDir' ? '端口已变更' : '端口已被占用'}
          message={matchType === 'sameDir'
            ? `该目录已有隧道，但端口不同。是否将端口更新为 ${port}？`
            : `端口 ${port} 已被其他目录占用。是否替换为当前目录「${dirPath}」？`
          }
          confirmText={matchType === 'sameDir' ? '更新端口' : '替换'}
          cancelText='取消'
          onConfirm={handleUseExisting}
          onCancel={handleCancelConfirm}
        />
      )}
    </>
  )
}
