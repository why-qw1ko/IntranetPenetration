import { useState, useCallback, useEffect, useRef } from 'react'
import { Server, Link2, Save, Square, Play, Pencil, Trash2, BookOpen, Download, ClipboardCopy, Globe, Menu } from 'lucide-react'
import ConfirmModal from '../ConfirmModal'
import './index.css'

const PROXY_TYPES = [
  { value: 'tcp', label: 'TCP', desc: '通用 TCP 端口转发' },
  { value: 'http', label: 'HTTP', desc: 'Web 服务，支持自定义域名' }
]

function formatTime (ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}

export default function FrpPage ({ onToggleSidebar, showToast }) {
  const [tab, setTab] = useState(() => {
    try { return window.services?.getTabMemory?.('frp-tab') || 'config' } catch (e) { return 'config' }
  })
  const [config, setConfig] = useState({ serverAddr: '', serverPort: '7000', token: '' })
  const [proxies, setProxies] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [editingIdx, setEditingIdx] = useState(-1)
  const [frpcStatus, setFrpcStatus] = useState({ running: false })
  const [form, setForm] = useState({ name: '', type: 'tcp', localPort: '', remotePort: '', customDomain: '' })
  const [error, setError] = useState('')
  const [logs, setLogs] = useState([])
  const [confirmProps, setConfirmProps] = useState(null)
  const logEndRef = useRef(null)

  // 保存 tab 记忆（本地存储）
  useEffect(() => {
    try { window.services?.saveTabMemory?.('frp-tab', tab) } catch (e) {}
  }, [tab])

  // 加载配置
  useEffect(() => {
    const load = async () => {
      try {
        const saved = await window.services?.getFrpConfig?.()
        if (saved) {
          if (saved.server) setConfig(saved.server)
          if (saved.proxies) setProxies(saved.proxies)
        }
      } catch (e) {}
      try {
        const status = window.services?.getFrpcStatus?.()
        if (status) setFrpcStatus(status)
      } catch (e) {}
    }
    load()
  }, [])

  // 加载 frpc 历史日志 + 监听事件
  useEffect(() => {
    const history = window.services?.getFrpcLogBuffer?.() || []
    setLogs(history.map(h => ({ ...h, time: new Date(h.time) })))

    const onEntry = (e) => setLogs(prev => [...prev, { ...e.detail, time: new Date(e.detail.time) }])
    const onError = (e) => {
      if (e.source && e.source !== 'frp') return
      showToast('frpc 错误: ' + e.detail, 'error')
    }
    const onExit = (e) => {
      if (e.source && e.source !== 'frp') return
      setFrpcStatus({ running: false })
      showToast('frpc 已停止', 'info')
    }
    window.addEventListener('frpc-log-entry', onEntry)
    window.addEventListener('frpc-error', onError)
    window.addEventListener('frpc-exit', onExit)
    return () => {
      window.removeEventListener('frpc-log-entry', onEntry)
      window.removeEventListener('frpc-error', onError)
      window.removeEventListener('frpc-exit', onExit)
    }
  }, [showToast])

  // 日志自动滚动
  useEffect(() => {
    if (tab === 'logs') logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs, tab])

  const handleSaveServer = useCallback(async () => {
    if (!config.serverAddr) { showToast('请输入服务器地址', 'error'); return }
    try {
      await window.services?.saveFrpConfig?.({ server: config, proxies })
      showToast('服务器配置已保存', 'success')
    } catch (e) {
      showToast('保存失败: ' + e.message, 'error')
    }
  }, [config, proxies, showToast])

  const handleTestConnection = useCallback(async () => {
    if (!config.serverAddr) { showToast('请先填写服务器地址', 'error'); return }
    const serverPort = parseInt(config.serverPort) || 7000
    const logMsg = `测试连接 ${config.serverAddr}:${serverPort} ...`
    window.services?.addFrpcLog?.('system', logMsg, 'frp')
    showToast('测试连接中...')
    try {
      const result = await window.services?.testFrpConnection?.(config.serverAddr, serverPort, config.token)
      if (result?.success) {
        window.services?.addFrpcLog?.('stdout', '连接成功', 'frp')
        showToast('连接成功', 'success')
      } else {
        window.services?.addFrpcLog?.('stderr', '连接失败: ' + (result?.message || '无法连接'), 'frp')
        showToast('连接失败: ' + (result?.message || '无法连接'), 'error')
      }
    } catch (e) {
      window.services?.addFrpcLog?.('error', '测试异常: ' + e.message, 'frp')
      showToast('测试失败: ' + e.message, 'error')
    }
  }, [config, showToast])

  const openCreateForm = useCallback(() => {
    setForm({ name: '', type: 'tcp', localPort: '', remotePort: '', customDomain: '' })
    setEditingIdx(-1)
    setError('')
    setShowForm(true)
  }, [])

  const openEditForm = useCallback((idx) => {
    const p = proxies[idx]
    setForm({
      name: p.name,
      type: p.type,
      localPort: String(p.localPort),
      remotePort: String(p.remotePort || ''),
      customDomain: p.customDomain || ''
    })
    setEditingIdx(idx)
    setError('')
    setShowForm(true)
  }, [proxies])

  const handleSaveProxy = useCallback(async () => {
    setError('')
    if (!form.name) { setError('请输入代理名称'); return }
    if (!form.localPort || parseInt(form.localPort) < 1) { setError('请输入有效本地端口'); return }
    if (form.type === 'tcp' && (!form.remotePort || parseInt(form.remotePort) < 1)) { setError('TCP 类型需要输入远程端口'); return }
    if (form.type === 'http' && !form.customDomain) { setError('HTTP 类型需要输入自定义域名'); return }

    const proxy = {
      name: form.name,
      type: form.type,
      localPort: parseInt(form.localPort),
      remotePort: form.type === 'tcp' ? parseInt(form.remotePort) : undefined,
      customDomain: form.type === 'http' ? form.customDomain : undefined
    }

    let newProxies
    if (editingIdx >= 0) {
      newProxies = [...proxies]
      newProxies[editingIdx] = proxy
    } else {
      newProxies = [...proxies, proxy]
    }
    setProxies(newProxies)
    setShowForm(false)

    try {
      await window.services?.saveFrpConfig?.({ server: config, proxies: newProxies })
    } catch (e) {
      showToast('保存代理失败: ' + e.message, 'error')
    }
  }, [form, editingIdx, proxies, config, showToast])

  const handleDeleteProxy = useCallback((idx) => {
    const proxy = proxies[idx]
    setConfirmProps({
      title: '删除代理',
      message: `确定要删除代理「${proxy.name}」吗？`,
      confirmText: '删除',
      danger: true,
      onConfirm: async () => {
        setConfirmProps(null)
        const newProxies = proxies.filter((_, i) => i !== idx)
        setProxies(newProxies)
        try {
          await window.services?.saveFrpConfig?.({ server: config, proxies: newProxies })
        } catch (e) {
          showToast('保存失败: ' + e.message, 'error')
          return
        }
        showToast('已删除', 'success')
      },
      onCancel: () => setConfirmProps(null)
    })
  }, [proxies, config, showToast])

  const handleStartAll = useCallback(async () => {
    if (!config.serverAddr) { showToast('请先配置服务器', 'error'); return }
    if (proxies.length === 0) { showToast('请先添加代理规则', 'error'); return }
    window.services?.clearFrpcLogs?.()
    window.services?.addFrpcLog?.('system', '正在启动 frpc...', 'frp')
    try {
      const result = await window.services?.startFrpc?.(config, proxies, 'frp')
      if (result?.success) {
        setFrpcStatus({ running: true })
        window.services?.addFrpcLog?.('system', 'frpc 进程已启动 (pid: ' + result.pid + ')', 'frp')
      } else {
        window.services?.addFrpcLog?.('error', '启动失败: ' + (result?.message || ''), 'frp')
        showToast('启动失败: ' + (result?.message || ''), 'error')
      }
    } catch (e) {
      window.services?.addFrpcLog?.('error', '启动异常: ' + e.message, 'frp')
      showToast('启动失败: ' + e.message, 'error')
    }
  }, [config, proxies, showToast])

  const handleStopAll = useCallback(() => {
    try {
      window.services?.stopFrpc?.()
      setFrpcStatus({ running: false })
      window.services?.addFrpcLog?.('system', '已发送停止信号', 'frp')
      showToast('已停止', 'success')
    } catch (e) {
      showToast('停止失败: ' + e.message, 'error')
    }
  }, [showToast])

  const handleCopyLogs = useCallback(() => {
    const text = logs.map(l => `[${formatTime(l.time)}] [${l.type}] ${l.text}`).join('\n')
    window.utools?.copyText(text)
    showToast('日志已复制', 'success')
  }, [logs, showToast])

  // 计算代理的访问 URL
  const getProxyUrl = useCallback((proxy) => {
    if (!config.serverAddr) return ''
    if (proxy.type === 'tcp') {
      return config.serverAddr + ':' + proxy.remotePort
    } else if (proxy.type === 'http') {
      return 'http://' + proxy.customDomain
    }
    return ''
  }, [config.serverAddr])

  const handleCopyUrl = useCallback((url) => {
    if (url) {
      window.utools?.copyText(url)
      showToast('URL 已复制', 'success')
    }
  }, [showToast])

  return (
    <>
      {/* 顶栏 */}
      <div className='topbar'>
        <div className='topbar-left'>
          <button className='topbar-menu-btn' onClick={onToggleSidebar} title='菜单'>
            <Menu size={18} />
          </button>
          <span className='topbar-title'>Frp 内网穿透</span>
          {frpcStatus.running && <span className='badge badge-success'>运行中</span>}
        </div>
      </div>

      {/* Tab 栏 */}
      <div className='tab-bar'>
        <button className={`tab-item ${tab === 'config' ? 'active' : ''}`} onClick={() => setTab('config')}>
          Frp 配置
        </button>
        <button className={`tab-item ${tab === 'logs' ? 'active' : ''}`} onClick={() => setTab('logs')}>
          日志 {logs.length > 0 && <span className='tab-count'>{logs.length}</span>}
        </button>
      </div>

      {/* Frp 配置 Tab */}
      {tab === 'config' && (
        <div className='page'>
          {/* 服务器配置 */}
          <div className='card frp-server-card'>
            <div className='card-header'>
              <span className='card-title'><Server size={15} /> 服务器配置</span>
            </div>

            <div className='form-group'>
              <label className='form-label'>服务器地址 *</label>
              <input className='form-input' type='text' value={config.serverAddr} onChange={(e) => setConfig(prev => ({ ...prev, serverAddr: e.target.value }))} placeholder='your-server.com 或 IP' />
            </div>

            <div className='form-group'>
              <label className='form-label'>服务器端口</label>
              <input className='form-input' type='number' value={config.serverPort} onChange={(e) => setConfig(prev => ({ ...prev, serverPort: e.target.value }))} placeholder='7000' />
              <div className='form-hint'>frps 服务端监听端口，默认 7000</div>
            </div>

            <div className='form-group' style={{ marginBottom: 0 }}>
              <label className='form-label'>认证 Token</label>
              <input className='form-input' type='password' value={config.token} onChange={(e) => setConfig(prev => ({ ...prev, token: e.target.value }))} placeholder='frps 配置的 token' />
            </div>

            <div className='frp-server-actions'>
              <button className='btn btn-ghost btn-sm' onClick={handleTestConnection}><Link2 size={14} /> 测试连接</button>
              <button className='btn btn-brand btn-sm' onClick={handleSaveServer}><Save size={14} /> 保存配置</button>
            </div>
          </div>

          {/* 代理列表 */}
          <div className='card'>
            <div className='frp-proxy-header'>
              <span className='card-title'>我的代理 ({proxies.length})</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {frpcStatus.running ? (
                  <button className='btn btn-warning btn-sm' onClick={handleStopAll}><Square size={13} /> 全部停止</button>
                ) : (
                  <button className='btn btn-brand btn-sm' onClick={handleStartAll} disabled={proxies.length === 0}><Play size={13} /> 全部启动</button>
                )}
                <button className='btn btn-ghost btn-sm' onClick={openCreateForm}>+ 新建代理</button>
              </div>
            </div>

            {proxies.length === 0 ? (
              <div className='empty' style={{ padding: '24px 0' }}>
                <div className='empty-icon'><Link2 size={40} strokeWidth={1.2} /></div>
                <div className='empty-text'>暂无代理规则</div>
                <div className='empty-hint'>点击「新建代理」添加你的第一个 frp 代理</div>
              </div>
            ) : (
              proxies.map((proxy, idx) => {
                const proxyUrl = getProxyUrl(proxy)
                return (
                  <div key={idx} className='card frp-proxy-card' style={{ marginBottom: 8 }}>
                    <div className='frp-proxy-top'>
                      <span className='frp-proxy-name'>{proxy.name}</span>
                      <span className='frp-proxy-type'>{proxy.type.toUpperCase()}</span>
                    </div>
                    <div className='frp-proxy-info'>
                      本地 :{proxy.localPort}
                      {proxy.type === 'tcp' && ` → 远程 :${proxy.remotePort}`}
                      {proxy.type === 'http' && ` → ${proxy.customDomain}`}
                    </div>
                    {frpcStatus.running && proxyUrl && (
                      <div className='frp-proxy-url' onClick={() => handleCopyUrl(proxyUrl)} title='点击复制'>
                        <span className='frp-proxy-url-text'>{proxyUrl}</span>
                        <span className='frp-proxy-url-hint'><ClipboardCopy size={12} /> 复制</span>
                      </div>
                    )}
                    <div className='frp-proxy-actions'>
                      <button className='btn btn-ghost btn-sm' onClick={() => openEditForm(idx)}><Pencil size={13} /> 编辑</button>
                      <button className='btn btn-ghost btn-sm' onClick={() => handleDeleteProxy(idx)} style={{ color: 'var(--red)' }}><Trash2 size={13} /> 删除</button>
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {/* 使用引导 */}
          {proxies.length === 0 && (
            <div className='card frp-guide'>
              <div className='frp-guide-title'><BookOpen size={15} /> 快速开始</div>
              <div className='frp-guide-text'>1. 在你的 VPS 上安装并启动 frps 服务端</div>
              <div className='frp-guide-text'>2. 填写上方的服务器地址和 Token</div>
              <div className='frp-guide-text'>3. 点击「新建代理」添加代理规则</div>
              <div className='frp-guide-text'>4. 点击「全部启动」开始穿透</div>
              <div className='frp-guide-text' style={{ marginTop: 8 }}>
                <Download size={13} /> 需要 frpc？<a className='frp-guide-link' href='#' onClick={(e) => {
                  e.preventDefault()
                  try { window.utools.shellOpenExternal('https://github.com/fatedier/frp/releases') } catch (e) {}
                }}>前往 GitHub 下载</a>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 日志 Tab */}
      {tab === 'logs' && (
        <div className='page'>
          <div className='log-panel'>
            <div className='log-header'>
              <span>frpc 日志 ({logs.length})</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className='btn btn-ghost btn-sm' onClick={handleCopyLogs}>复制</button>
                <button className='btn btn-ghost btn-sm' onClick={() => { window.services?.clearFrpcLogs?.(); setLogs([]) }}>清空</button>
              </div>
            </div>
            <div className='log-content' style={{ maxHeight: 'calc(100vh - 180px)' }}>
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
      )}

      {/* 确认弹窗 */}
      {confirmProps && <ConfirmModal {...confirmProps} />}

      {/* 新建/编辑代理弹窗 */}
      {showForm && (
        <div className='frp-form-overlay' onClick={() => setShowForm(false)}>
          <div className='frp-form-box' onClick={(e) => e.stopPropagation()}>
            <div className='frp-form-title'>{editingIdx >= 0 ? '编辑代理' : '新建代理'}</div>

            <div className='form-group'>
              <label className='form-label'>代理名称 *</label>
              <input className='form-input' type='text' value={form.name} onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))} placeholder='如 web、ssh、api' />
            </div>

            <div className='form-group'>
              <label className='form-label'>代理类型 *</label>
              <select className='form-select' value={form.type} onChange={(e) => setForm(prev => ({ ...prev, type: e.target.value }))}>
                {PROXY_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label} — {t.desc}</option>
                ))}
              </select>
            </div>

            <div className='form-group'>
              <label className='form-label'>本地端口 *</label>
              <input className='form-input' type='number' value={form.localPort} onChange={(e) => setForm(prev => ({ ...prev, localPort: e.target.value }))} placeholder='3000' min='1' max='65535' />
            </div>

            {form.type === 'tcp' && (
              <div className='form-group'>
                <label className='form-label'>远程端口 *</label>
                <input className='form-input' type='number' value={form.remotePort} onChange={(e) => setForm(prev => ({ ...prev, remotePort: e.target.value }))} placeholder='6000' min='1' max='65535' />
                <div className='form-hint'>通过 服务器IP:远程端口 访问</div>
              </div>
            )}

            {form.type === 'http' && (
              <div className='form-group'>
                <label className='form-label'>自定义域名 *</label>
                <input className='form-input' type='text' value={form.customDomain} onChange={(e) => setForm(prev => ({ ...prev, customDomain: e.target.value }))} placeholder='web.your-server.com' />
                <div className='form-hint'>需要在 frps 配置泛域名解析</div>
              </div>
            )}

            {error && (
              <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>{error}</div>
            )}

            <div className='frp-form-actions'>
              <button className='btn btn-ghost' onClick={() => setShowForm(false)}>取消</button>
              <button className='btn btn-brand' onClick={handleSaveProxy}>{editingIdx >= 0 ? '保存' : '创建'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
