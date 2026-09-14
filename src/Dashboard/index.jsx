import { useState, useCallback, useEffect, useRef } from 'react'
import { Radio, ClipboardCopy, Code2, Square, Menu, FolderOpen, Server, Activity, ArrowRight } from 'lucide-react'
import ConfirmModal from '../ConfirmModal'
import './index.css'

export default function Dashboard ({ tunnels, loginInfo, loading, onRefresh, onRefreshLogin, onLogin, onCreateNew, onOpenProxyDir, onOpenFrp, onSelectTunnel, onToggleSidebar, showToast }) {
  const [tab, setTab] = useState(() => {
    try { return window.services?.getTabMemory?.('dashboard-tab') || 'tunnels' } catch (e) { return 'tunnels' }
  })
  const [showLoginModal, setShowLoginModal] = useState(false)
  const [loginLoading, setLoginLoading] = useState('')
  const [loginCode, setLoginCode] = useState(null)
  const [logs, setLogs] = useState([])
  const [confirmProps, setConfirmProps] = useState(null)
  const [, setUrlVersion] = useState(0)
  const [refreshLoginLoading, setRefreshLoginLoading] = useState(false)
  const [runningTunnel, setRunningTunnel] = useState(() => {
    // 从全局状态恢复运行中的隧道ID
    try {
      const status = window.services?.getHostStatus()
      return status?.running ? (window.__runningTunnelId || null) : null
    } catch (e) { return null }
  })
  const logEndRef = useRef(null)

  // 保存 tab 记忆（本地存储）
  useEffect(() => {
    try { window.services?.saveTabMemory?.('dashboard-tab', tab) } catch (e) {}
  }, [tab])

  // 日志 + 事件监听
  useEffect(() => {
    const history = window.services?.getLogBuffer() || []
    setLogs(history.map(h => ({ ...h, time: new Date(h.time) })))

    const onEntry = (e) => setLogs(prev => [...prev, { ...e.detail, time: new Date(e.detail.time) }])
    const onLoginDone = (e) => {
      setLoginCode(null)
      if (e.detail.success) {
        showToast('登录成功', 'success')
        onLogin()
      } else {
        showToast('登录失败' + (e.detail.error ? ': ' + e.detail.error : ''), 'error')
      }
    }
    const onLoginCode = (e) => setLoginCode(e.detail)
    const onExit = (e) => {
      setRunningTunnel(null)
      window.__runningTunnelId = null
      showToast('隧道已停止', 'info')
    }
    const onUrlReady = () => {
      // URL 更新时触发重新渲染
      setUrlVersion(v => v + 1)
    }
    const onError = (e) => {
      showToast('隧道错误: ' + e.detail, 'error')
    }

    window.addEventListener('tunnel-log-entry', onEntry)
    window.addEventListener('tunnel-login-done', onLoginDone)
    window.addEventListener('tunnel-login-code', onLoginCode)
    window.addEventListener('tunnel-exit', onExit)
    window.addEventListener('tunnel-url', onUrlReady)
    window.addEventListener('tunnel-error', onError)
    return () => {
      window.removeEventListener('tunnel-log-entry', onEntry)
      window.removeEventListener('tunnel-login-done', onLoginDone)
      window.removeEventListener('tunnel-login-code', onLoginCode)
      window.removeEventListener('tunnel-exit', onExit)
      window.removeEventListener('tunnel-url', onUrlReady)
      window.removeEventListener('tunnel-error', onError)
    }
  }, [onLogin, showToast])

  // 检查运行状态（进入时）
  useEffect(() => {
    try {
      const status = window.services?.getHostStatus()
      if (status?.running && window.__runningTunnelId) {
        setRunningTunnel(window.__runningTunnelId)
      }
    } catch (e) {}
  }, [])

  useEffect(() => {
    if (tab === 'logs') logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs, tab])

  const handleLogin = useCallback((provider) => {
    setLoginLoading(provider)
    const res = window.services.login(provider)
    if (res.success) { showToast('请在浏览器中完成登录'); setShowLoginModal(false) } else showToast('登录失败: ' + res.message, 'error')
    setLoginLoading('')
  }, [showToast])

  const handleLogout = useCallback(async () => {
    const res = await window.services.logout()
    if (res.success) { showToast('已登出', 'success'); await onLogin() }
  }, [onLogin, showToast])

  const handleRefreshLogin = useCallback(async () => {
    setRefreshLoginLoading(true)
    try {
      await onRefreshLogin()
    } finally {
      setRefreshLoginLoading(false)
    }
  }, [onRefreshLogin])

  const handleDelete = useCallback((e, tunnelId) => {
    e.stopPropagation()
    setConfirmProps({
      title: '删除隧道',
      message: `确定要删除隧道「${tunnelId}」吗？此操作不可撤销。`,
      confirmText: '删除',
      danger: true,
      onConfirm: async () => {
        setConfirmProps(null)
        const res = await window.services.deleteTunnel(tunnelId)
        if (res.success) { showToast('已删除', 'success'); onRefresh() } else showToast('删除失败: ' + (res.message || ''), 'error')
      },
      onCancel: () => setConfirmProps(null)
    })
  }, [onRefresh, showToast])

  const handleStart = useCallback(async (e, tunnel) => {
    e.stopPropagation()
    // 获取最新端口信息
    let latestTunnel = tunnel
    let port = tunnel.ports?.[0]?.portNumber
    try {
      const full = await window.services.getTunnelWithPorts(tunnel.tunnelId)
      if (full) {
        latestTunnel = full
        port = full.ports?.[0]?.portNumber || port
      }
    } catch (err) {}
    if (!port) { showToast('请先配置端口', 'error'); return }

    // 代理目录隧道：先启动本地文件服务器
    const desc = latestTunnel.description || ''
    if (desc.startsWith('代理目录: ')) {
      const dirPath = desc.replace('代理目录: ', '')
      const fsResult = await window.services.startFileServer(dirPath, port)
      if (!fsResult.success) {
        showToast('文件服务器启动失败: ' + fsResult.message, 'error')
        return
      }
    }

    const result = window.services.startHost(latestTunnel.tunnelId, port, latestTunnel.anonymous === true)
    if (result.success) {
      setRunningTunnel(latestTunnel.tunnelId)
      window.__runningTunnelId = latestTunnel.tunnelId // 持久化到全局
      showToast('启动中...')
    } else {
      // 启动失败时回滚文件服务器
      if ((latestTunnel.description || '').startsWith('代理目录: ')) window.services.stopFileServer()
      showToast('启动失败: ' + result.message, 'error')
    }
  }, [showToast])

  const handleStop = useCallback((e, tunnel) => {
    e.stopPropagation()
    // 代理目录隧道：同时停止文件服务器
    if ((tunnel?.description || '').startsWith('代理目录: ')) window.services.stopFileServer()
    const result = window.services.stopHost()
    if (result.success) {
      setRunningTunnel(null)
      window.__runningTunnelId = null // 清除全局状态
      showToast('已停止', 'success')
    } else {
      showToast('停止失败: ' + result.message, 'error')
    }
  }, [showToast])

  const handleCopyUrl = useCallback((e, url) => {
    e.stopPropagation()
    if (!url) {
      showToast('请先启动隧道并获取详情', 'error')
      return
    }
    window.utools?.copyText(url)
    showToast('URL 已复制', 'success')
  }, [showToast])

  const getTunnelUrl = (tunnel) => {
    if (!tunnel.tunnelId) return ''
    // 从缓存获取URL
    return window.services?.getTunnelUrl(tunnel.tunnelId) || ''
  }

  const formatTime = (d) => d instanceof Date ? d.toLocaleTimeString('zh-CN', { hour12: false }) : ''

  return (
    <>
      {/* 顶栏 */}
      <div className='topbar'>
        <div className='topbar-left'>
          <button className='topbar-menu-btn' onClick={onToggleSidebar} title='菜单'>
            <Menu size={18} />
          </button>
          <span className='topbar-title'>工作台</span>
          {loading && <span className='spinner' />}
        </div>
        <div className='topbar-right'>
          <button className='btn btn-ghost btn-sm' onClick={handleRefreshLogin} disabled={refreshLoginLoading} title='刷新登录状态'>
            {refreshLoginLoading ? <><span className='spinner' /> 检查中...</> : '刷新登录'}
          </button>
          <button className='btn btn-ghost btn-sm' onClick={onRefresh} disabled={loading}>刷新列表</button>
        </div>
      </div>

      {/* Tab 栏 */}
      <div className='tab-bar'>
        <button className={`tab-item ${tab === 'tunnels' ? 'active' : ''}`} onClick={() => setTab('tunnels')}>
          隧道 {tunnels.length > 0 && <span className='tab-count'>{tunnels.length}</span>}
        </button>
        <button className={`tab-item ${tab === 'logs' ? 'active' : ''}`} onClick={() => setTab('logs')}>
          日志 {logs.length > 0 && <span className='tab-count'>{logs.length}</span>}
        </button>
      </div>

      {/* 隧道 Tab */}
      {tab === 'tunnels' && (
        <div className='page'>
          <div className='workbench-panel'>
            <div className='workbench-head'>
              <div>
                <div className='workbench-title'>选择你现在要做的事</div>
                <div className='workbench-subtitle'>常用操作放在这里，底层通道可以以后再细调</div>
              </div>
              <div className='workbench-metrics'>
                <div className='metric-item'>
                  <span className='metric-value'>{tunnels.length}</span>
                  <span className='metric-label'>隧道</span>
                </div>
                <div className='metric-item'>
                  <span className={`metric-value ${runningTunnel ? 'running' : ''}`}>{runningTunnel ? '1' : '0'}</span>
                  <span className='metric-label'>运行中</span>
                </div>
              </div>
            </div>

            <div className='quick-actions'>
              <button className='quick-action primary' onClick={onCreateNew} disabled={loading || tunnels.length >= 2}>
                <span className='quick-icon'><Radio size={20} /></span>
                <span className='quick-copy'>
                  <span className='quick-title'>暴露本地端口</span>
                  <span className='quick-desc'>适合调试 Web、API、Webhook 回调</span>
                </span>
                <ArrowRight size={16} />
              </button>
              <button className='quick-action' onClick={onOpenProxyDir}>
                <span className='quick-icon'><FolderOpen size={20} /></span>
                <span className='quick-copy'>
                  <span className='quick-title'>分享本地目录</span>
                  <span className='quick-desc'>选择文件夹后生成可访问地址</span>
                </span>
                <ArrowRight size={16} />
              </button>
              <button className='quick-action' onClick={onOpenFrp}>
                <span className='quick-icon'><Server size={20} /></span>
                <span className='quick-copy'>
                  <span className='quick-title'>使用 Frp 内网穿透</span>
                  <span className='quick-desc'>适合长期服务和固定服务器</span>
                </span>
                <ArrowRight size={16} />
              </button>
            </div>
          </div>

          <div className='account-strip'>
            {loginInfo?.loggedIn
              ? (
                <div className='login-row'>
                  <div className='login-left'>
                    <span className='badge badge-success'>已登录</span>
                    <span className='login-user'>{loginInfo.summary}</span>
                  </div>
                  <button className='btn btn-ghost btn-sm' onClick={handleLogout}>登出</button>
                </div>
                )
              : loginInfo === null
                ? (
                  <div className='login-row'>
                    <span className='spinner' />
                    <span style={{ marginLeft: 10, color: 'var(--text-sub)', fontSize: 13 }}>检查中...</span>
                  </div>
                  )
                : (
                  <div className='login-row'>
                    <div className='login-left'>
                      <span className='badge badge-orange'>未登录</span>
                      <span className='login-hint'>登录后可创建隧道</span>
                    </div>
                    <button className='btn btn-brand btn-sm' onClick={() => setShowLoginModal(true)}>登录</button>
                  </div>
                  )}
          </div>

          <div className='section-bar'>
            <span className='section-label'><Activity size={14} /> 最近隧道</span>
            <button
              className='btn btn-brand btn-sm'
              onClick={onCreateNew}
              disabled={loading || tunnels.length >= 2}
              title={tunnels.length >= 2 ? '免费隧道数量已达上限（最多 2 个）' : ''}
            >
              + 新建隧道
            </button>
          </div>
          {tunnels.length >= 2 && (
            <div style={{ fontSize: 12, color: 'var(--text-sub)', marginBottom: 12, paddingLeft: 4 }}>
              免费隧道数量已达上限（最多 2 个），请先删除不需要的隧道
            </div>
          )}

          {tunnels.length === 0
            ? (
              <div className='empty'>
                <div className='empty-icon'><Radio size={40} strokeWidth={1.2} /></div>
                <div className='empty-text'>暂无隧道</div>
                <div className='empty-hint'>
                  {loginInfo?.loggedIn
                    ? '点击上方「新建隧道」，将本地服务暴露到公网'
                    : '请先登录，然后创建隧道'}
                </div>
              </div>
              )
            : (
                tunnels.map((tunnel, i) => {
                  const isRunning = runningTunnel === tunnel.tunnelId
                  return (
                    <div key={tunnel.tunnelId || i} className='card card-clickable' onClick={() => onSelectTunnel(tunnel)}>
                      <div className='tunnel-top'>
                        <span className='tunnel-id'>{tunnel.tunnelId}</span>
                        <span className={`badge ${isRunning ? 'badge-success' : 'badge-blue'}`}>
                          {isRunning ? '运行中' : '就绪'}
                        </span>
                      </div>
                      {tunnel.description && <div className='tunnel-desc'>{tunnel.description}</div>}
                      {getTunnelUrl(tunnel) && (
                        <div className='tunnel-url' onClick={(e) => handleCopyUrl(e, getTunnelUrl(tunnel))} title='点击复制'>
                          {getTunnelUrl(tunnel)} <ClipboardCopy size={13} />
                        </div>
                      )}
                      <div className='tunnel-bottom'>
                        <span className='tunnel-ports'>
                          端口: {tunnel.ports?.map(p => p.portNumber).join(', ') || '无'}
                        </span>
                        <div className='tunnel-actions'>
                          {isRunning
                            ? (
                              <button className='icon-btn icon-btn-stop' onClick={(e) => handleStop(e, tunnel)} title='停止'>
                                <svg width='18' height='18' viewBox='0 0 24 24' fill='currentColor'>
                                  <rect x='6' y='6' width='12' height='12' rx='1' />
                                </svg>
                              </button>
                              )
                            : (
                              <button className='icon-btn icon-btn-start' onClick={(e) => handleStart(e, tunnel)} title='启动'>
                                <svg width='18' height='18' viewBox='0 0 24 24' fill='currentColor'>
                                  <polygon points='5,3 19,12 5,21' />
                                </svg>
                              </button>
                              )}
                          <button className='icon-btn icon-btn-copy' onClick={(e) => handleCopyUrl(e, getTunnelUrl(tunnel))} title='复制 URL'>
                            <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
                              <rect x='9' y='9' width='13' height='13' rx='2' ry='2' />
                              <path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' />
                            </svg>
                          </button>
                          <button className='icon-btn icon-btn-delete' onClick={(e) => handleDelete(e, tunnel.tunnelId)} title='删除'>
                            <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
                              <polyline points='3 6 5 6 21 6' />
                              <path d='M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' />
                              <line x1='10' y1='11' x2='10' y2='17' />
                              <line x1='14' y1='11' x2='14' y2='17' />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
        </div>
      )}

      {/* 日志 Tab */}
      {tab === 'logs' && (
        <div className='page'>
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
            <div className='log-content' style={{ maxHeight: 'calc(100vh - 180px)' }}>
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
      )}

      {/* 登录弹窗 */}
      {showLoginModal && (
        <div className='modal-overlay' onClick={() => setShowLoginModal(false)}>
          <div className='modal-box' onClick={(e) => e.stopPropagation()}>
            <div className='modal-title'>选择登录方式</div>
            <div className='modal-sub'>登录后可创建和管理隧道</div>
            <div className='login-option' onClick={() => handleLogin('microsoft')}>
              <div className='login-option-icon'><Square size={22} strokeWidth={1.8} /></div>
              <div className='login-option-info'>
                <div className='login-option-name'>Microsoft 账户</div>
                <div className='login-option-desc'>Outlook / Azure AD</div>
              </div>
              {loginLoading === 'microsoft' && <span className='spinner' />}
            </div>
            <div className='login-option' onClick={() => handleLogin('github')}>
              <div className='login-option-icon'><Code2 size={22} strokeWidth={1.8} /></div>
              <div className='login-option-info'>
                <div className='login-option-name'>GitHub 账户</div>
                <div className='login-option-desc'>GitHub 账号登录</div>
              </div>
              {loginLoading === 'github' && <span className='spinner' />}
            </div>
            <button className='modal-cancel' onClick={() => setShowLoginModal(false)}>取消</button>
          </div>
        </div>
      )}

      {/* 验证码弹窗 */}
      {loginCode && (
        <div className='modal-overlay'>
          <div className='modal-box' style={{ textAlign: 'center' }}>
            <div className='modal-title'>请在浏览器中输入验证码</div>
            <div className='modal-sub'>页面已自动打开，如未打开请手动访问</div>
            <div className='code-display'>{loginCode.code}</div>
            <button
              className='btn btn-brand btn-sm' style={{ marginTop: 16 }} onClick={() => {
                window.utools?.copyText(loginCode.code)
                try { window.utools.shellOpenExternal(loginCode.url) } catch (e) {}
                showToast('验证码已复制，浏览器已打开', 'success')
              }}
            >复制验证码并打开页面
            </button>
            <div style={{ marginTop: 12 }}>
              <a
                className='code-link' href='#' onClick={(e) => {
                  e.preventDefault()
                  try { window.utools.shellOpenExternal(loginCode.url) } catch (e) {}
                }}
              >手动打开页面
              </a>
            </div>
            <button className='modal-cancel' style={{ marginTop: 12 }} onClick={() => setLoginCode(null)}>关闭</button>
          </div>
        </div>
      )}

      {/* 确认弹窗 */}
      {confirmProps && <ConfirmModal {...confirmProps} />}
    </>
  )
}
