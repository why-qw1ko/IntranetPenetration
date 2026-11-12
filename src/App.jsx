import { useEffect, useState, useCallback, useRef } from 'react'
import Sidebar from './Sidebar'
import Home from './Home'
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
  const [section, setSection] = useState('home')
  const [view, setView] = useState('')
  const [selectedTunnel, setSelectedTunnel] = useState(null)
  const [tunnels, setTunnels] = useState([])
  const [loginInfo, setLoginInfo] = useState({ state: 'checking' })
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState({ msg: '', type: 'info' })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const lastRefreshRef = useRef(0)
  const dataLoadedRef = useRef(false)
  const tunnelRequestRef = useRef(0)
  const loginRequestRef = useRef(0)
  const sectionRef = useRef(section)
  sectionRef.current = section

  const toastTimer = useRef(null)
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const showToast = useCallback((msg, type = 'info') => {
    clearTimeout(toastTimer.current)
    setToast({ msg, type })
    toastTimer.current = setTimeout(() => setToast({ msg: '', type: 'info' }), 2200)
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

  const loadLoginStatus = useCallback(async () => {
    const request = ++loginRequestRef.current
    setLoginInfo({ state: 'checking' })
    try {
      if (!window.services) throw new Error('服务不可用')
      const status = await window.services.getLoginStatus()
      if (request !== loginRequestRef.current) return null
      setLoginInfo(status)
      return status
    } catch (e) {
      if (request !== loginRequestRef.current) return null
      const status = { state: 'checkFailed', reason: 'serviceUnavailable' }
      setLoginInfo(status)
      return status
    }
  }, [])

  const loadTunnels = useCallback(async (force = false) => {
    const now = Date.now()
    if (!force && dataLoadedRef.current && now - lastRefreshRef.current < 30000) return

    const request = ++tunnelRequestRef.current
    setLoading(true)
    try {
      if (!window.services) return
      const list = await window.services.listTunnels()
      if (request !== tunnelRequestRef.current) return
      setTunnels(Array.isArray(list) ? list : [])
      lastRefreshRef.current = now
      dataLoadedRef.current = true
    } catch (e) {
      if (request === tunnelRequestRef.current) showToastRef.current('刷新隧道列表失败: ' + e.message, 'error')
    } finally {
      if (request === tunnelRequestRef.current) setLoading(false)
    }
  }, [])

  const forceRefresh = useCallback(async () => {
    await loadTunnels(true)
  }, [loadTunnels])

  const refreshLogin = useCallback(async () => {
    const status = await loadLoginStatus()
    if (!status) return
    if (status.state === 'loggedIn') {
      await loadTunnels(true)
    } else {
      ++tunnelRequestRef.current
      setLoading(false)
      setTunnels([])
      dataLoadedRef.current = false
    }
  }, [loadLoginStatus, loadTunnels])

  const handleLogin = useCallback(async () => {
    setLoginInfo({ state: 'checking' })
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (sectionRef.current === 'devtunnel') await refreshLogin()
  }, [refreshLogin])

  // 首次进入标记
  const firstEnterRef = useRef(true)

  useEffect(() => {
    window.utools.onPluginEnter((action) => {
      // 首次进入显示主页；仅在 Dev Tunnels 页面恢复时检查其状态。
      if (firstEnterRef.current) {
        firstEnterRef.current = false
        sectionRef.current = 'home'
        setSection('home')
        setView('')
      } else if (sectionRef.current === 'devtunnel') {
        refreshLogin()
      }
    })
    window.utools.onPluginOut(() => {
      // 隐藏前提交当前输入框，保留界面以便再次进入时恢复。
      document.activeElement?.blur?.()
    })
  }, [refreshLogin])

  const goToDetail = useCallback((tunnel) => {
    setSelectedTunnel(tunnel)
    setView('detail')
  }, [])

  const goToDashboard = useCallback(() => {
    setView('dashboard')
    setSelectedTunnel(null)
    loadTunnels(true)
  }, [loadTunnels])

  const handleCreated = useCallback((tunnel) => {
    setView('dashboard')
    setSelectedTunnel(null)
    lastRefreshRef.current = 0
    dataLoadedRef.current = false
    loadTunnels(true)
  }, [loadTunnels])

  const handleSectionSelect = useCallback((key) => {
    sectionRef.current = key
    setSection(key)
    if (key === 'devtunnel') {
      setView('dashboard')
      setSelectedTunnel(null)
      refreshLogin()
    } else {
      ++loginRequestRef.current
      ++tunnelRequestRef.current
      setLoading(false)
      setView('')
    }
  }, [refreshLogin])

  const handleSettingsSelect = useCallback(() => {
    handleSectionSelect('settings')
  }, [handleSectionSelect])

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
        {section === 'home' && <Home onSelect={handleSectionSelect} onToggleSidebar={toggleSidebar} />}
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
          <FrpPage onToggleSidebar={toggleSidebar} onOpenSettings={handleSettingsSelect} showToast={showToast} />
        )}

        {/* proxydir section */}
        {section === 'proxydir' && (
          <ProxyDir onToggleSidebar={toggleSidebar} onOpenSettings={handleSettingsSelect} showToast={showToast} />
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
