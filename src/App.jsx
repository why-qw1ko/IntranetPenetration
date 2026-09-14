import { useEffect, useState, useCallback, useRef } from 'react'
import Sidebar from './Sidebar'
import Dashboard from './Dashboard'
import CreateTunnel from './CreateTunnel'
import TunnelDetail from './TunnelDetail'
import Settings from './Settings'
import ProxyDir from './ProxyDir'
import FrpPage from './FrpPage'
import TutorialPage from './TutorialPage'
import AboutPage from './AboutPage'
import './App.css'

export default function App () {
  const [section, setSection] = useState('devtunnel')
  const [view, setView] = useState('')
  const [selectedTunnel, setSelectedTunnel] = useState(null)
  const [tunnels, setTunnels] = useState([])
  const [loginInfo, setLoginInfo] = useState(null)
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState({ msg: '', type: 'info' })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const lastRefreshRef = useRef(0)
  const lastLoginRefreshRef = useRef(0)
  const dataLoadedRef = useRef(false)

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type })
    setTimeout(() => setToast({ msg: '', type: 'info' }), 2200)
  }, [])

  // 全局异常捕获
  const showToastRef = useRef(showToast)
  showToastRef.current = showToast
  useEffect(() => {
    const handleError = (msg, source, lineno, colno, error) => {
      const detail = error?.message || msg || '未知错误'
      console.error('[全局错误]', msg, source, lineno, colno, error)
      try { window.services?.addFrpcLog?.('error', '[渲染异常] ' + detail, 'global') } catch (e) {}
      showToastRef.current('异常: ' + detail, 'error')
    }
    const handleRejection = (e) => {
      const detail = e.reason?.message || e.reason || '未知 Promise 错误'
      console.error('[未捕获 Promise]', e.reason)
      try { window.services?.addFrpcLog?.('error', '[未捕获 Promise] ' + detail, 'global') } catch (e2) {}
      showToastRef.current('异常: ' + detail, 'error')
    }
    window.onerror = handleError
    window.addEventListener('unhandledrejection', handleRejection)
    return () => {
      window.onerror = null
      window.removeEventListener('unhandledrejection', handleRejection)
    }
  }, [])

  const loadLoginStatus = useCallback(async (force = false) => {
    const now = Date.now()
    if (!force && lastLoginRefreshRef.current && now - lastLoginRefreshRef.current < 60000) return

    try {
      if (!window.services) return
      const status = await window.services.getLoginStatus()
      setLoginInfo(status)
      lastLoginRefreshRef.current = now
    } catch (e) {
      console.error('[loadLoginStatus] 错误:', e)
      setLoginInfo({ loggedIn: false, info: '', summary: '检查失败' })
    }
  }, [])

  const loadTunnels = useCallback(async (force = false) => {
    const now = Date.now()
    if (!force && dataLoadedRef.current && now - lastRefreshRef.current < 30000) return

    setLoading(true)
    try {
      if (!window.services) return
      const list = await window.services.listTunnels()
      setTunnels(Array.isArray(list) ? list : [])
      lastRefreshRef.current = now
      dataLoadedRef.current = true
    } catch (e) {
      setTunnels([])
    }
    setLoading(false)
  }, [])

  const forceRefresh = useCallback(async () => {
    await loadTunnels(true)
  }, [loadTunnels])

  const refreshLogin = useCallback(async () => {
    await loadLoginStatus(true)
  }, [loadLoginStatus])

  const handleLogin = useCallback(async () => {
    await new Promise(resolve => setTimeout(resolve, 1000))
    await Promise.all([loadLoginStatus(true), loadTunnels(true)])
  }, [loadLoginStatus, loadTunnels])

  // 首次进入标记
  const firstEnterRef = useRef(true)

  useEffect(() => {
    window.utools.onPluginEnter((action) => {
      loadLoginStatus(true)
      loadTunnels(true)
      // 首次进入时设置默认 section，后续进入保持当前 section
      if (firstEnterRef.current) {
        firstEnterRef.current = false
        setSection('devtunnel')
        setView('dashboard')
      }
    })
    window.utools.onPluginOut(() => {
      // uTools 插件隐藏时保留当前界面，避免再次进入时 DevTunnel 分区没有子视图可渲染。
    })
  }, [loadLoginStatus, loadTunnels])

  const goToDetail = useCallback((tunnel) => {
    setSelectedTunnel(tunnel)
    setView('detail')
  }, [])

  const goToDashboard = useCallback(() => {
    setView('dashboard')
    setSelectedTunnel(null)
  }, [])

  const handleCreated = useCallback((tunnel) => {
    setView('dashboard')
    setSelectedTunnel(null)
    lastRefreshRef.current = 0
    dataLoadedRef.current = false
    loadTunnels(true)
  }, [loadTunnels])

  const handleSectionSelect = useCallback((key) => {
    setSection(key)
    if (key === 'devtunnel') {
      setView('dashboard')
      setSelectedTunnel(null)
    } else {
      setView('')
    }
  }, [])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => !prev)
  }, [])

  return (
    <div className='app'>
      <Sidebar
        activeSection={section}
        onSelect={handleSectionSelect}
        collapsed={sidebarCollapsed}
        onToggle={toggleSidebar}
      />

      <div className='main'>
        {/* devtunnel section — 每个子视图有自己的 topbar */}
        {section === 'devtunnel' && view === 'dashboard' && (
          <Dashboard
            tunnels={tunnels}
            loginInfo={loginInfo}
            loading={loading}
            onRefresh={forceRefresh}
            onRefreshLogin={refreshLogin}
            onLogin={handleLogin}
            onCreateNew={() => setView('create')}
            onOpenProxyDir={() => handleSectionSelect('proxydir')}
            onOpenFrp={() => handleSectionSelect('frp')}
            onSelectTunnel={goToDetail}
            onToggleSidebar={toggleSidebar}
            showToast={showToast}
          />
        )}
        {section === 'devtunnel' && view === 'create' && (
          <CreateTunnel onBack={goToDashboard} onCreated={handleCreated} showToast={showToast} />
        )}
        {section === 'devtunnel' && view === 'detail' && selectedTunnel && (
          <TunnelDetail tunnel={selectedTunnel} onBack={goToDashboard} showToast={showToast} />
        )}
        {/* settings section */}
        {section === 'settings' && (
          <Settings onToggleSidebar={toggleSidebar} showToast={showToast} />
        )}

        {/* frp section */}
        {section === 'frp' && (
          <FrpPage onToggleSidebar={toggleSidebar} showToast={showToast} />
        )}

        {/* proxydir section */}
        {section === 'proxydir' && (
          <ProxyDir onToggleSidebar={toggleSidebar} showToast={showToast} />
        )}

        {/* tutorial section */}
        {section === 'tutorial' && (
          <TutorialPage onToggleSidebar={toggleSidebar} />
        )}

        {/* about section */}
        {section === 'about' && (
          <AboutPage onToggleSidebar={toggleSidebar} />
        )}
      </div>

      {toast.msg && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  )
}
