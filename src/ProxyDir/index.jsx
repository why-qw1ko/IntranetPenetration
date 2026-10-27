import { useState, useCallback, useEffect, useRef } from 'react'
import { ClipboardCopy, Globe, Square, Play, BookOpen, Lightbulb, Server, Link2 } from 'lucide-react'
import ConfirmModal from '../ConfirmModal'
import './index.css'

function parsePort (value) {
  if (!/^\d+$/.test(String(value))) return null
  const num = Number(value)
  return Number.isInteger(num) && num >= 1 && num <= 65535 ? num : null
}

export default function ProxyDir ({ onToggleSidebar, onOpenSettings, showToast }) {
  const [mode, setMode] = useState('devtunnel') // 'devtunnel' | 'frp'
  const [dirPath, setDirPath] = useState('')
  const [port, setPort] = useState('3000')
  const [allowAnonymous, setAllowAnonymous] = useState(true)
  const [running, setRunning] = useState(false)
  const [loading, setLoading] = useState(false)
  const [tunnelUrl, setTunnelUrl] = useState('')
  const [error, setError] = useState('')
  const [saveErrors, setSaveErrors] = useState({})
  const [serverInfo, setServerInfo] = useState(null)
  const tunnelIdRef = useRef(null)
  const operationRef = useRef(false)
  const awaitingConfirmRef = useRef(false)
  const activeTunnelRef = useRef(null)
  const activeFileModeRef = useRef(null)

  // 已有隧道确认弹窗
  const [existingTunnel, setExistingTunnel] = useState(null)
  const [matchType, setMatchType] = useState('') // 'same' | 'sameDir' | 'samePort'
  const [showConfirm, setShowConfirm] = useState(false)

  // frp 模式相关
  const [frpConfig, setFrpConfig] = useState(null)
  const [frpProxyType, setFrpProxyType] = useState('tcp') // 'tcp' | 'http'
  const [frpRemotePort, setFrpRemotePort] = useState('8080')
  const [frpDomain, setFrpDomain] = useState('')
  const [frpRuntime, setFrpRuntime] = useState(null)

  // 加载 frp 配置和代理目录 frp 设置
  useEffect(() => {
    let active = true
    const loadFrp = async () => {
      try {
        const saved = await window.services?.getFrpConfig?.()
        if (active) setFrpConfig(saved?.server || null)
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
    return () => { active = false }
  }, [])

  const saveSettings = useCallback((key, value, frp = false) => {
    try {
      if ((key === 'port' || key === 'remotePort') && !parsePort(value)) throw new Error('端口必须是 1-65535 之间的整数')
      const services = window.services
      const existing = frp ? services.getProxyDirFrpSettings() : services.getProxyDirSettings()
      const settings = { ...existing, [key]: value }
      const result = frp ? services.saveProxyDirFrpSettings(settings) : services.saveProxyDirSettings(settings)
      if (result?.success === false) throw new Error(result.message || '保存失败')
      setSaveErrors(prev => ({ ...prev, [key]: '' }))
    } catch (error) {
      setSaveErrors(prev => ({ ...prev, [key]: '设置未保存：' + error.message }))
      showToast('设置保存失败：' + error.message, 'error')
    }
  }, [showToast])

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
      if (savedDir?.port !== undefined) setPort(savedDir.port)
      if (savedDir?.mode) setMode(savedDir.mode)
      if (savedDir?.allowAnonymous !== undefined) setAllowAnonymous(savedDir.allowAnonymous)
    } catch (e) {}

    // 恢复运行状态
    const fsStatus = window.services?.getFileServerStatus()
    const hostStatus = window.services?.getHostStatus()
    const frpcStatus = window.services?.getFrpcStatus?.()

    if (frpcStatus?.running && frpcStatus.source === 'proxydir') {
      // frpc 模式运行中：恢复 mode 和 tunnelUrl
      setRunning(true)
      setMode('frp')
      activeFileModeRef.current = 'frp'
      setFrpRuntime(frpcStatus)
      const dir = fsStatus?.dir || savedDirPath || '(已启动)'
      setServerInfo({ port: fsStatus?.port || port, dir })
      const proxy = frpcStatus.proxies?.[0]
      if (proxy?.status === 'running') setTunnelUrl(proxy.type === 'tcp' ? frpcStatus.serverAddr + ':' + proxy.remotePort : 'http://' + proxy.customDomain)
    } else if (fsStatus?.running) {
      // 文件服务器运行中（代理目录 devtunnel 模式）
      setRunning(true)
      const activeMode = fsStatus.mode || 'devtunnel'
      setMode(activeMode)
      activeFileModeRef.current = activeMode
      setPort(String(fsStatus.port))
      setDirPath(fsStatus.dir)
      setServerInfo({ port: fsStatus.port, dir: fsStatus.dir })
      // 恢复当前 Host 所属隧道的 URL 缓存，不从历史日志猜测。
      if (activeMode === 'devtunnel' && hostStatus?.running && hostStatus.tunnelId) {
        activeTunnelRef.current = hostStatus.tunnelId
        activeFileModeRef.current = 'devtunnel'
        const cachedUrl = window.services?.getTunnelUrl(hostStatus.tunnelId)
        if (cachedUrl) setTunnelUrl(cachedUrl)
      }
    }
  }, [])

  // 监听隧道 URL 和退出事件（devtunnel 模式）
  useEffect(() => {
    const syncHostStatus = (e) => {
      const detail = e.detail || {}
      const status = detail.host || detail.running !== undefined ? (detail.host || detail) : (window.services?.getHostStatus?.() || {})
      const currentFile = detail.file || window.services?.getFileServerStatus?.()
      if (status.running && currentFile?.running && currentFile.mode === 'devtunnel' && (status.tunnelId || window.services?.getHostStatus?.()?.tunnelId)) {
        const tunnelId = status.tunnelId || window.services.getHostStatus().tunnelId
        activeTunnelRef.current = tunnelId
        tunnelIdRef.current = tunnelId
        activeFileModeRef.current = 'devtunnel'
        setMode('devtunnel')
        setRunning(true)
        if (currentFile?.running) {
          setServerInfo({ port: currentFile.port, dir: currentFile.dir })
        } else {
          setServerInfo({ port, dir: dirPath || '(已启动)' })
        }
        const url = window.services?.getTunnelUrl?.(tunnelId)
        setTunnelUrl(url || '')
      } else if (!status.running && activeFileModeRef.current === 'devtunnel') {
        setRunning(false)
        setTunnelUrl('')
        setServerInfo(null)
        activeTunnelRef.current = null
        activeFileModeRef.current = null
      }
    }
    const onUrl = (e) => {
      const detail = e.detail || {}
      if (!activeTunnelRef.current && detail.tunnelId === (window.services?.getHostStatus?.()?.tunnelId || window.__runningTunnelId)) {
        activeTunnelRef.current = detail.tunnelId
      }
      if (activeFileModeRef.current !== 'devtunnel' || !detail.tunnelId || detail.tunnelId !== activeTunnelRef.current) return
      setTunnelUrl(detail.url)
      showToast('隧道已就绪')
    }
    const onExit = (e) => {
      const detail = e.detail || {}
      if (activeFileModeRef.current !== 'devtunnel') return
      if (operationRef.current) return
      if (detail.tunnelId && detail.tunnelId !== activeTunnelRef.current) return
      setRunning(false)
      setLoading(false)
      setTunnelUrl('')
      setServerInfo(null)
      tunnelIdRef.current = null
      activeTunnelRef.current = null
      activeFileModeRef.current = null
    }
    const onError = (e) => {
      if (mode !== 'devtunnel') return
      showToast('隧道错误: ' + e.detail, 'error')
    }

    window.addEventListener('tunnel-url', onUrl)
    window.addEventListener('tunnel-host-status', syncHostStatus)
    window.addEventListener('tunnel-exit', onExit)
    window.addEventListener('tunnel-error', onError)
    return () => {
      window.removeEventListener('tunnel-url', onUrl)
      window.removeEventListener('tunnel-host-status', syncHostStatus)
      window.removeEventListener('tunnel-exit', onExit)
      window.removeEventListener('tunnel-error', onError)
    }
  }, [showToast, mode])

  // 监听 frpc 事件（frp 模式，仅处理来自 proxydir 的）
  useEffect(() => {
    const onFrpcStatus = (e) => {
      const detail = e.detail || {}
      if (detail.source !== 'proxydir') return
      setFrpRuntime(detail)
      if (detail.running) {
        activeFileModeRef.current = 'frp'
        setMode('frp')
        setRunning(true)
        const currentFile = detail.file || window.services?.getFileServerStatus?.()
        setServerInfo({
          port: currentFile?.port || port,
          dir: currentFile?.dir || dirPath || '(已启动)'
        })
        const proxy = detail.proxies?.[0]
        setTunnelUrl(proxy?.status === 'running' ? (proxy.type === 'tcp' ? detail.serverAddr + ':' + proxy.remotePort : 'http://' + proxy.customDomain) : '')
        if (proxy?.status === 'error') setError(proxy.message || '代理注册失败，请查看日志')
      } else if (activeFileModeRef.current === 'frp') {
        setRunning(false)
        setServerInfo(null)
        setTunnelUrl('')
        activeFileModeRef.current = null
      }
    }
    const onFrpcExit = (e) => {
      const detail = e.detail || {}
      const source = detail.source || e.source
      if (source !== 'proxydir' || operationRef.current) return
      setRunning(false)
      setLoading(false)
      setServerInfo(null)
      setTunnelUrl('')
      activeFileModeRef.current = null
    }
    const onFrpcError = (e) => {
      const detail = e.detail || {}
      const source = detail.source || e.source
      if (source !== 'proxydir') return
      const msg = detail.message || detail || '未知错误'
      setError('frpc 错误: ' + msg)
      setRunning(Boolean(window.services?.getFrpcStatus?.()?.running))
      showToast('frpc 错误: ' + msg, 'error')
    }
    window.addEventListener('frpc-status', onFrpcStatus)
    window.addEventListener('frpc-exit', onFrpcExit)
    window.addEventListener('frpc-error', onFrpcError)
    return () => {
      window.removeEventListener('frpc-status', onFrpcStatus)
      window.removeEventListener('frpc-exit', onFrpcExit)
      window.removeEventListener('frpc-error', onFrpcError)
    }
  }, [showToast, mode])

  const handleSelectDir = useCallback(() => {
    const dir = window.services?.selectDirectory()
    if (dir) {
      setDirPath(dir)
      setError('')
      saveSettings('dirPath', dir)
    }
  }, [saveSettings])

  const stopCurrentHost = () => {
    const status = window.services.getHostStatus()
    if (!status?.running) return null
    return window.services.stopHost().then(result => {
      if (!result?.success) throw new Error(result?.message || '停止现有隧道失败')
    })
  }

  // 检查是否有已存在的隧道
  // 返回：{ tunnel, matchType } 或 null
  // matchType: 'same'(同目录+同端口) | 'sameDir'(同目录+不同端口) | 'samePort'(同端口+不同目录)
  const checkExistingTunnel = useCallback(async () => {
    try {
      const targetPort = parsePort(port)
      if (!targetPort) return null
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
    if (operationRef.current && !awaitingConfirmRef.current) return
    operationRef.current = true
    setShowConfirm(false)
    awaitingConfirmRef.current = false
    if (!existingTunnel) { operationRef.current = false; return }

    setLoading(true)
    try {
      // 0. 先停止已有的隧道进程
      const stopPromise = stopCurrentHost()
      if (stopPromise) await stopPromise

      // 1. 启动本地文件服务器
      const targetPort = parsePort(port)
      if (!targetPort) {
        setError('请输入有效端口号 (1-65535)')
        setLoading(false)
        return
      }

      const fsResult = await window.services.startFileServer(dirPath, targetPort)
      if (!fsResult.success) {
        setError(fsResult.message)
        setLoading(false)
        return
      }
      activeFileModeRef.current = 'devtunnel'

      const tid = existingTunnel.tunnelId
      // 2. sameDir：先新增端口，删除旧端口失败时撤回新增端口。
      if (matchType === 'sameDir') {
        const oldPort = existingTunnel.ports?.[0]?.portNumber
        await window.services.addPort(tid, targetPort, 'auto')
        if (oldPort) {
          try {
            await window.services.deletePort(tid, oldPort)
          } catch (deleteError) {
            try { await window.services.deletePort(tid, targetPort) } catch (rollbackError) {
              throw new Error(deleteError.message + '；回滚新增端口失败: ' + rollbackError.message)
            }
            throw deleteError
          }
        }
      }

      // 3. 同步描述和匿名访问策略
      const updateOptions = { anonymous: allowAnonymous }
      if (matchType === 'samePort') updateOptions.description = '代理目录: ' + dirPath
      try {
        await window.services.updateTunnel(tid, updateOptions)
      } catch (e) {
        setError(e.message || '更新隧道访问策略失败')
        window.services.stopFileServer()
        setLoading(false)
        return
      }

      // 4. 启动隧道
      activeTunnelRef.current = tid
      const hostResult = await window.services.startHost(tid, targetPort)
      if (!hostResult?.success) {
        setError(hostResult.message)
        window.services.stopFileServer()
        setLoading(false)
        return
      }

      // 5. 保存 tunnelId 到本地存储
      try {
        window.services?.saveProxyDirLastTunnel?.({ port: targetPort, tunnelId: tid })
      } catch (e) {}

      tunnelIdRef.current = tid
      setRunning(true)
      activeFileModeRef.current = 'devtunnel'
      setServerInfo({ port: targetPort, dir: dirPath })
      window.services?.addProxyDirLog?.('system', '[代理目录] devtunnel 模式启动: ' + dirPath + ' -> 端口 ' + port, 'devtunnel')
      showToast('正在启动...')
    } catch (err) {
      setError(err.message || '启动失败')
      window.services.stopFileServer()
    } finally {
      setLoading(false)
      setExistingTunnel(null)
      setMatchType('')
      operationRef.current = false
    }
  }, [existingTunnel, matchType, dirPath, port, allowAnonymous, showToast])

  // 实际创建隧道的逻辑
  const doStartDevtunnel = useCallback(async () => {
    setLoading(true)
    try {
      // 0. 先停止已有的隧道进程
      const stopPromise = stopCurrentHost()
      if (stopPromise) await stopPromise

      // 1. 启动本地文件服务器（等待端口真正监听）
      const targetPort = parsePort(port)
      if (!targetPort) {
        setError('请输入有效端口号 (1-65535)')
        setLoading(false)
        return
      }

      const fsResult = await window.services.startFileServer(dirPath, targetPort)
      if (!fsResult.success) {
        setError(fsResult.message)
        setLoading(false)
        return
      }

      // 2. 创建 devtunnel
      const tunnel = await window.services.createTunnel({
        port: targetPort,
        protocol: 'auto',
        anonymous: allowAnonymous,
        description: '代理目录: ' + dirPath
      })

      const tid = tunnel.tunnelId || tunnel.tunnel_id || tunnel.id
      await window.services.updateTunnel(tid, { anonymous: allowAnonymous })
      tunnelIdRef.current = tid

      // 3. 启动隧道
      activeTunnelRef.current = tid
      const hostResult = await window.services.startHost(tid, targetPort)
      if (!hostResult?.success) {
        setError(hostResult.message)
        window.services.stopFileServer()
        setLoading(false)
        return
      }

      // 4. 保存 tunnelId 到本地存储
      try {
        window.services?.saveProxyDirLastTunnel?.({ port: targetPort, tunnelId: tid })
      } catch (e) {}

      setRunning(true)
      activeFileModeRef.current = 'devtunnel'
      setServerInfo({ port: targetPort, dir: dirPath })
      window.services?.addProxyDirLog?.('system', '[代理目录] devtunnel 模式启动: ' + dirPath + ' -> 端口 ' + port, 'devtunnel')
      showToast('正在启动...')
    } catch (err) {
      setError(err.message || '启动失败')
      window.services.stopFileServer()
    }
    setLoading(false)
  }, [dirPath, port, allowAnonymous, showToast])

  // 同目录+同端口：直接复用，不弹窗
  const handleDirectReuse = useCallback(async (tunnel) => {
    setLoading(true)
    try {
      const stopPromise = stopCurrentHost()
      if (stopPromise) await stopPromise

      const targetPort = parsePort(port)
      if (!targetPort) {
        setError('请输入有效端口号 (1-65535)')
        setLoading(false)
        return
      }

      const fsResult = await window.services.startFileServer(dirPath, targetPort)
      if (!fsResult.success) {
        setError(fsResult.message)
        setLoading(false)
        return
      }

      const tid = tunnel.tunnelId
      try {
        await window.services.updateTunnel(tid, { anonymous: allowAnonymous })
      } catch (e) {
        setError(e.message || '更新隧道访问策略失败')
        window.services.stopFileServer()
        setLoading(false)
        return
      }
      activeTunnelRef.current = tid
      const hostResult = await window.services.startHost(tid, targetPort)
      if (!hostResult?.success) {
        setError(hostResult.message)
        window.services.stopFileServer()
        setLoading(false)
        return
      }

      try {
        window.services?.saveProxyDirLastTunnel?.({ port: targetPort, tunnelId: tid })
      } catch (e) {}

      tunnelIdRef.current = tid
      setRunning(true)
      activeFileModeRef.current = 'devtunnel'
      setServerInfo({ port: targetPort, dir: dirPath })
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
      const stopPromise = stopCurrentHost()
      if (stopPromise) await stopPromise
      const result = await checkExistingTunnel()
      if (result) {
        // 同目录+同端口：直接复用，不弹窗
        if (result.matchType === 'same') {
          await handleDirectReuse(result.tunnel)
          return
        }
        // 同目录+不同端口 或 同端口+不同目录：弹窗确认
        setExistingTunnel(result.tunnel)
        setMatchType(result.matchType)
        awaitingConfirmRef.current = true
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
    // 启动前重读共享配置；预检失败不进入会清理文件服务器的启动分支。
    let server
    try {
      const latest = await window.services.getFrpConfig()
      server = latest?.server
      setFrpConfig(server || null)
      if (!server?.serverAddr) throw new Error('请先在「设置」中配置 FRP 服务器')
    } catch (error) {
      setError(error.message || '读取 FRP 配置失败')
      return
    }
    if (frpProxyType === 'http' && !frpDomain) {
      setError('请输入自定义域名')
      return
    }
    const targetPort = parsePort(port)
    const remotePort = parsePort(frpRemotePort)
    if (!targetPort) {
      setError('请输入有效端口号 (1-65535)')
      return
    }
    if (frpProxyType === 'tcp' && !remotePort) {
      setError('请输入有效的远程端口')
      return
    }

    setLoading(true)
    try {
      // 1. 启动本地文件服务器（等待端口真正监听）
      const stopPromise = stopCurrentHost()
      if (stopPromise) await stopPromise
      const fsResult = await window.services.startFileServer(dirPath, targetPort, 'frp')
      if (!fsResult.success) {
        setError(fsResult.message)
        setLoading(false)
        return
      }

      // 2. 启动 frpc
      const proxyConfig = {
        name: 'proxydir-' + Date.now(),
        type: frpProxyType,
        localPort: targetPort,
        remotePort: frpProxyType === 'tcp' ? remotePort : undefined,
        customDomain: frpProxyType === 'http' ? frpDomain : undefined
      }
      activeFileModeRef.current = 'frp'
      const result = await window.services.startFrpc(server, [proxyConfig], 'proxydir')
      if (!result?.success) {
        setError(result.message)
        window.services.stopFileServer('frp')
        setLoading(false)
        return
      }

      const runtime = window.services.getFrpcStatus()
      setFrpRuntime(runtime)
      if (!runtime.running) throw new Error('frpc 已退出，请查看日志')
      setRunning(true)
      activeFileModeRef.current = 'frp'
      setServerInfo({ port: targetPort, dir: dirPath })

      window.services?.addProxyDirLog?.('system', '[代理目录] frp 模式启动: ' + dirPath + ' -> 端口 ' + port, 'frp')
      showToast('正在启动 frpc...')
    } catch (err) {
      setError(err.message || '启动失败')
      window.services.stopFileServer('frp')
      setRunning(Boolean(window.services.getFrpcStatus().running))
    }
    setLoading(false)
  }, [dirPath, port, frpProxyType, frpRemotePort, frpDomain, showToast])

  const handleCancelConfirm = useCallback(() => {
    setShowConfirm(false)
    awaitingConfirmRef.current = false
    setExistingTunnel(null)
    setMatchType('')
    operationRef.current = false
    setLoading(false)
  }, [])

  const handleStart = useCallback(async () => {
    if (operationRef.current) return
    operationRef.current = true
    setError('')
    setLoading(true)
    try {
      if (!dirPath) { setError('请选择要代理的目录'); return }
      if (!parsePort(port)) { setError('请输入有效端口号 (1-65535)'); return }

      if (mode === 'frp') {
        await handleStartFrp()
      } else {
        await handleStartDevtunnel()
      }
    } finally {
      if (!awaitingConfirmRef.current) {
        operationRef.current = false
        setLoading(false)
      }
    }
  }, [dirPath, port, mode, handleStartFrp, handleStartDevtunnel])

  const handleStop = useCallback(async () => {
    if (operationRef.current) return
    operationRef.current = true
    setLoading(true)
    const runningMode = activeFileModeRef.current || mode
    try {
      window.services?.addProxyDirLog?.('system', '[代理目录] 停止代理 (' + runningMode + ' 模式)', runningMode)
      const result = runningMode === 'frp'
        ? await window.services.stopFrpc('proxydir')
        : await window.services.stopHost()
      if (!result?.success) {
        setError(result?.message || '停止失败')
        return
      }
      window.services.stopFileServer(runningMode)
      setRunning(false)
      setTunnelUrl('')
      setServerInfo(null)
      tunnelIdRef.current = null
      activeTunnelRef.current = null
      activeFileModeRef.current = null
      showToast('已停止', 'success')
    } catch (err) {
      setError(err.message || '停止失败')
    } finally {
      operationRef.current = false
      setLoading(false)
    }
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
              <path d='M3 5H15M3 9H15M3 13H15' stroke='currentColor' strokeWidth='1.5' strokeLinecap='round' />
            </svg>
          </button>
          <span className='topbar-title'>代理目录</span>
          {running && <span className='badge badge-success'>运行中</span>}
        </div>
      </div>

      <div className='page'>
        <div className='form-hint'>输入框失焦时保存设置，选项修改后立即保存。</div>
        {Object.values(saveErrors).some(Boolean) && <div role='alert' style={{ color: 'var(--red)' }}>{Object.values(saveErrors).filter(Boolean).join('；')}</div>}
        {/* 模式选择（未运行时显示） */}
        {!running && (
          <div className='card mode-card'>
            <div className='card-header'>
              <span className='card-title'>穿透方式</span>
            </div>
            <div className='mode-options'>
              <button
                className={`mode-option ${mode === 'devtunnel' ? 'active' : ''}`}
                disabled={loading}
                onClick={() => { setMode('devtunnel'); saveSettings('mode', 'devtunnel') }}
              >
                <span className='mode-option-icon'><Globe size={18} /></span>
                <div>
                  <div className='mode-option-title'>DevTunnel（免费）</div>
                  <div className='mode-option-desc'>微软免费隧道服务，无需服务器</div>
                </div>
              </button>
              <button
                className={`mode-option ${mode === 'frp' ? 'active' : ''}`}
                disabled={loading}
                onClick={() => { setMode('frp'); saveSettings('mode', 'frp') }}
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
              <span className='status-dot'>{mode !== 'frp' || frpRuntime?.state === 'running' ? '运行中' : frpRuntime?.state === 'error' ? '代理注册失败' : frpRuntime?.state === 'stopping' ? '正在停止' : '启动中'}</span>
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
              <button className='btn btn-warning btn-sm' disabled={loading} onClick={handleStop}><Square size={13} /> 停止代理</button>
            </div>
          </div>
        )}

        {running && error && (
          <div className='card' style={{ borderLeft: '3px solid var(--red)', color: 'var(--red)', fontSize: 13 }}>
            {error}
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
                    disabled={loading}
                    onChange={(e) => { setDirPath(e.target.value); setError('') }}
                    onBlur={e => saveSettings('dirPath', e.target.value)}
                    placeholder='选择或输入要分享的本地目录路径'
                  />
                  <button className='btn btn-ghost' disabled={loading} onClick={handleSelectDir}>浏览</button>
                </div>
                <div className='form-hint'>选择要通过隧道暴露的本地文件夹</div>
              </div>

              <div className='form-group'>
                <label className='form-label'>端口号 *</label>
                <input
                  className='form-input port-input'
                  disabled={loading}
                  type='number'
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  onBlur={e => saveSettings('port', e.target.value)}
                  placeholder='3000'
                  min='1'
                  max='65535'
                />
                <div className='form-hint'>本地 HTTP 服务器监听端口，默认 3000</div>
              </div>

              {mode === 'devtunnel' && (
                <>
                  <label className='form-checkbox'>
                    <input type='checkbox' disabled={loading} checked={allowAnonymous} onChange={(e) => { setAllowAnonymous(e.target.checked); saveSettings('allowAnonymous', e.target.checked) }} />
                    允许匿名访问
                  </label>
                  <div className='form-hint' style={{ marginLeft: 26 }}>开启后任何人可通过 URL 访问文件</div>
                </>
              )}

              {mode === 'frp' && (
                <>
                  {!frpConfig?.serverAddr
                    ? (
                      <div className='frp-hint-box'>
                        <Server size={14} />
                        <span>请先在设置中配置 FRP 服务器</span>
                      </div>
                      )
                    : (
                      <div className='frp-server-summary'>
                        <div className='status-info'>
                          <span className='status-info-label'>服务器</span>
                          <span className='status-info-value'>{frpConfig.serverAddr}:{frpConfig.serverPort || 7000}</span>
                        </div>
                      </div>
                      )}

                  <button className='btn btn-ghost btn-sm' disabled={loading} onClick={onOpenSettings}>前往设置</button>
                  <div className='form-group' style={{ marginTop: 12 }}>
                    <label className='form-label'>代理类型</label>
                    <div className='frp-type-options'>
                      <button
                        className={`frp-type-btn ${frpProxyType === 'tcp' ? 'active' : ''}`}
                        disabled={loading}
                        onClick={() => { setFrpProxyType('tcp'); saveSettings('proxyType', 'tcp', true) }}
                      >
                        TCP 端口
                      </button>
                      <button
                        className={`frp-type-btn ${frpProxyType === 'http' ? 'active' : ''}`}
                        disabled={loading}
                        onClick={() => { setFrpProxyType('http'); saveSettings('proxyType', 'http', true) }}
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
                        disabled={loading}
                        type='number'
                        value={frpRemotePort}
                        onChange={(e) => setFrpRemotePort(e.target.value)}
                        onBlur={e => saveSettings('remotePort', e.target.value, true)}
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
                        disabled={loading}
                        type='text'
                        value={frpDomain}
                        onChange={(e) => setFrpDomain(e.target.value)}
                        onBlur={e => saveSettings('domain', e.target.value, true)}
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
              {loading && !awaitingConfirmRef.current ? <><span className='spinner' /> 启动中...</> : <><Play size={14} /> 启动代理</>}
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
            : `端口 ${port} 已被其他目录占用。是否替换为当前目录「${dirPath}」？`}
          confirmText={matchType === 'sameDir' ? '更新端口' : '替换'}
          cancelText='取消'
          onConfirm={handleUseExisting}
          onCancel={handleCancelConfirm}
        />
      )}
    </>
  )
}
