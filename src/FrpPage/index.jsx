import { useState, useCallback, useEffect, useRef } from 'react'
import { Server, Link2, Square, Play, Pencil, Trash2, BookOpen, Download, ClipboardCopy, Menu } from 'lucide-react'
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

function parsePort (value) {
  if (!/^\d+$/.test(String(value))) return null
  const num = Number(value)
  return Number.isInteger(num) && num >= 1 && num <= 65535 ? num : null
}

export default function FrpPage ({ onToggleSidebar, onOpenSettings, showToast }) {
  const [tab, setTab] = useState(() => {
    try { return window.services?.getTabMemory?.('frp-tab') || 'config' } catch (e) { return 'config' }
  })
  const [config, setConfig] = useState({ serverAddr: '', serverPort: '7000', token: '' })
  const [proxies, setProxies] = useState([])
  const [selectedNames, setSelectedNames] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [editingIdx, setEditingIdx] = useState(-1)
  const [frpcStatus, setFrpcStatus] = useState({ running: false })
  const [form, setForm] = useState({ name: '', type: 'tcp', localPort: '', remotePort: '', customDomain: '' })
  const [error, setError] = useState('')
  const [logs, setLogs] = useState([])
  const [confirmProps, setConfirmProps] = useState(null)
  const [loaded, setLoaded] = useState(false)
  const [operating, setOperating] = useState(false)
  const operationRef = useRef(false)
  const savedRevisionRef = useRef(null)
  const locked = !loaded || operating || frpcStatus.running
  const ownProcess = frpcStatus.running && frpcStatus.source === 'frp'
  const selectedProxies = proxies.filter(proxy => selectedNames.includes(proxy.name.trim()))
  const allSelected = proxies.length > 0 && selectedProxies.length === proxies.length
  const logEndRef = useRef(null)

  // 保存 tab 记忆（本地存储）
  useEffect(() => {
    try { window.services?.saveTabMemory?.('frp-tab', tab) } catch (e) {}
  }, [tab])

  // 加载配置
  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const saved = await window.services?.getFrpConfig?.()
        if (!active) return
        if (saved) {
          if (saved.server) setConfig(saved.server)
          if (saved.proxies) setProxies(saved.proxies)
          savedRevisionRef.current = saved.revision || null
        }
        setLoaded(true)
      } catch (e) { showToast('读取 FRP 配置失败: ' + e.message, 'error') }
      if (!active) return
      try {
        const status = window.services?.getFrpcStatus?.()
        if (status) {
          setFrpcStatus(status)
          if (status.running && status.source === 'frp') setSelectedNames(status.proxies.map(proxy => proxy.name.trim()))
        }
      } catch (e) {}
    }
    load()
    return () => { active = false }
  }, [])

  // 加载 frpc 历史日志 + 监听事件
  useEffect(() => {
    const history = window.services?.getFrpcLogBuffer?.() || []
    setLogs(history
      .filter(h => !h.source || h.source === 'frp')
      .map(h => ({ ...h, time: new Date(h.time) })))

    const onEntry = (e) => {
      if (e.detail?.source && e.detail.source !== 'frp') return
      setLogs(prev => [...prev.slice(-499), { ...e.detail, time: new Date(e.detail.time) }])
    }
    const onError = (e) => {
      const detail = e.detail || {}
      const source = detail.source || e.source
      if (source && source !== 'frp') return
      showToast('frpc 错误: ' + (detail.message || detail || '未知错误'), 'error')
    }
    const onExit = (e) => {
      const detail = e.detail || {}
      const source = detail.source || e.source
      if (source && source !== 'frp') return
      setFrpcStatus(window.services.getFrpcStatus())
      showToast('frpc 已停止', 'info')
    }
    const onStatus = e => {
      setFrpcStatus(window.services.getFrpcStatus())
    }
    window.addEventListener('frpc-log-entry', onEntry)
    window.addEventListener('frpc-error', onError)
    window.addEventListener('frpc-exit', onExit)
    window.addEventListener('frpc-status', onStatus)
    return () => {
      window.removeEventListener('frpc-log-entry', onEntry)
      window.removeEventListener('frpc-error', onError)
      window.removeEventListener('frpc-exit', onExit)
      window.removeEventListener('frpc-status', onStatus)
    }
  }, [showToast])

  // 日志自动滚动
  useEffect(() => {
    if (tab === 'logs') logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs, tab])

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
    if (operationRef.current) return
    setError('')
    if (!form.name) { setError('请输入代理名称'); return }
    const localPort = parsePort(form.localPort)
    const remotePort = form.type === 'tcp' ? parsePort(form.remotePort) : null
    if (!localPort) { setError('请输入 1-65535 之间的本地端口'); return }
    if (form.type === 'tcp' && !remotePort) { setError('TCP 类型需要输入 1-65535 之间的远程端口'); return }
    if (form.type === 'http' && !form.customDomain) { setError('HTTP 类型需要输入自定义域名'); return }

    const proxy = {
      name: form.name.trim(),
      type: form.type,
      localPort,
      remotePort: form.type === 'tcp' ? remotePort : undefined,
      customDomain: form.type === 'http' ? form.customDomain.trim().toLowerCase().replace(/\.$/, '') : undefined
    }

    let newProxies
    if (editingIdx >= 0) {
      newProxies = [...proxies]
      newProxies[editingIdx] = proxy
    } else {
      newProxies = [...proxies, proxy]
    }
    operationRef.current = true
    setOperating(true)
    try {
      const result = await window.services.saveFrpConfig({ proxies: newProxies, expectedRevision: savedRevisionRef.current })
      if (!result?.success) throw new Error(result?.message || '保存失败')
      savedRevisionRef.current = result.revision || null
      if (editingIdx >= 0) {
        const previousName = proxies[editingIdx].name.trim()
        setSelectedNames(prev => prev.map(name => name === previousName ? proxy.name : name))
      }
      setProxies(newProxies)
      setShowForm(false)
    } catch (e) {
      showToast('保存代理失败: ' + e.message, 'error')
    } finally {
      operationRef.current = false
      setOperating(false)
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
        try {
          const result = await window.services.saveFrpConfig({ proxies: newProxies, expectedRevision: savedRevisionRef.current })
          if (!result?.success) throw new Error(result?.message || '保存失败')
          savedRevisionRef.current = result.revision || null
          setProxies(newProxies)
          setSelectedNames(prev => prev.filter(name => name !== proxy.name.trim()))
        } catch (e) {
          showToast('保存失败: ' + e.message, 'error')
          return
        }
        showToast('已删除', 'success')
      },
      onCancel: () => setConfirmProps(null)
    })
  }, [proxies, config, showToast])

  const handleStartSelected = useCallback(async () => {
    if (operationRef.current) return
    if (!config.serverAddr) { showToast('请先配置服务器', 'error'); return }
    if (selectedProxies.length === 0) { showToast('请先勾选要启动的代理', 'error'); return }
    operationRef.current = true
    setOperating(true)
    window.services?.clearFrpcLogs?.()
    window.services?.addFrpcLog?.('system', '正在启动 frpc...', 'frp')
    try {
      const result = await window.services?.startFrpc?.(config, selectedProxies, 'frp')
      if (result?.success) {
        setFrpcStatus(window.services.getFrpcStatus())
        window.services?.addFrpcLog?.('system', 'frpc 进程已启动 (pid: ' + result.pid + ')', 'frp')
      } else {
        window.services?.addFrpcLog?.('error', '启动失败: ' + (result?.message || ''), 'frp')
        showToast('启动失败: ' + (result?.message || ''), 'error')
      }
    } catch (e) {
      window.services?.addFrpcLog?.('error', '启动异常: ' + e.message, 'frp')
      showToast('启动失败: ' + e.message, 'error')
    } finally {
      operationRef.current = false
      setOperating(false)
    }
  }, [config, selectedProxies, showToast])

  const handleStopAll = useCallback(async () => {
    if (operationRef.current) return
    operationRef.current = true
    setOperating(true)
    try {
      const result = await window.services.stopFrpc('frp')
      setFrpcStatus(window.services.getFrpcStatus())
      if (!result?.success) throw new Error(result?.message || '停止失败')
      showToast('已停止', 'success')
    } catch (e) {
      showToast('停止失败: ' + e.message, 'error')
    } finally {
      operationRef.current = false
      setOperating(false)
    }
  }, [showToast])

  const handleCopyLogs = useCallback(() => {
    const text = logs.map(l => `[${formatTime(l.time)}] [${l.type}] ${l.text}`).join('\n')
    window.utools?.copyText(text)
    showToast('日志已复制', 'success')
  }, [logs, showToast])

  // 计算代理的访问 URL
  const getProxyUrl = useCallback((proxy) => {
    const runtime = frpcStatus.proxies?.find(item => item.name === proxy.name.trim())
    if (!ownProcess || runtime?.status !== 'running') return ''
    if (runtime.type === 'tcp') {
      return frpcStatus.serverAddr + ':' + runtime.remotePort
    } else if (runtime.type === 'http') {
      return 'http://' + runtime.customDomain
    }
    return ''
  }, [frpcStatus, ownProcess])

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
          {ownProcess && <span className='badge badge-success'>{frpcStatus.state === 'running' ? '运行中' : frpcStatus.state === 'error' ? '代理注册失败' : frpcStatus.state === 'stopping' ? '正在停止' : '启动中'}</span>}
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

            <div className='form-hint'>服务器统一在设置页管理，内网穿透与代理目录共用。</div>
            <div className='status-info'>
              <span className='status-info-label'>服务器</span>
              <span className='status-info-value'>{loaded ? (config.serverAddr ? `${config.serverAddr}:${config.serverPort || 7000}` : '尚未配置') : '读取中…'}</span>
            </div>
            <div className='frp-server-actions'>
              <button className='btn btn-ghost btn-sm' onClick={onOpenSettings}>前往设置</button>
            </div>
          </div>

          {frpcStatus.running && (
            <div className='card frp-runtime-summary' role='status'>
              <div>当前由「{frpcStatus.source === 'proxydir' ? '代理目录' : 'Frp 内网穿透'}」启动 · PID {frpcStatus.pid}</div>
              <div>{frpcStatus.serverAddr}:{frpcStatus.serverPort}</div>
              <div>本次代理：{frpcStatus.proxies?.map(proxy => proxy.name).join('、')}</div>
              {!ownProcess && <div>请到「代理目录」停止后，再启动此处的代理。</div>}
            </div>
          )}

          {/* 代理列表 */}
          <div className='card'>
            <div className='frp-proxy-header'>
              <span className='card-title'>我的代理 ({proxies.length})</span>
              <div className='frp-proxy-controls'>
                {ownProcess
                  ? (
                    <button className='btn btn-warning btn-sm' onClick={handleStopAll} disabled={operating || frpcStatus.state === 'stopping'}><Square size={13} /> 停止本次启动</button>
                    )
                  : (
                    <button className='btn btn-brand btn-sm' onClick={handleStartSelected} disabled={locked || selectedProxies.length === 0}><Play size={13} /> 启动选中 ({selectedProxies.length})</button>
                    )}
                <button className='btn btn-ghost btn-sm' onClick={openCreateForm} disabled={locked}>+ 新建代理</button>
              </div>
            </div>

            {proxies.length > 0 && (
              <div className='frp-selection-toolbar'>
                <label className='form-checkbox'>
                  <input
                    type='checkbox' aria-label='全选代理' checked={allSelected} disabled={locked}
                    ref={node => { if (node) node.indeterminate = selectedProxies.length > 0 && !allSelected }}
                    onChange={event => setSelectedNames(event.target.checked ? proxies.map(proxy => proxy.name.trim()) : [])}
                  />
                  全选
                </label>
                <span role='status'>已选 {selectedProxies.length} / {proxies.length}</span>
                <span>{ownProcess ? '更换代理前，请先停止本次启动。' : '勾选需要启动的代理，可同时转发多个端口。'}</span>
              </div>
            )}

            {proxies.length === 0
              ? (
                <div className='empty' style={{ padding: '24px 0' }}>
                  <div className='empty-icon'><Link2 size={40} strokeWidth={1.2} /></div>
                  <div className='empty-text'>暂无代理规则</div>
                  <div className='empty-hint'>点击「新建代理」添加你的第一个 frp 代理</div>
                </div>
                )
              : (
                  proxies.map((proxy, idx) => {
                    const proxyUrl = getProxyUrl(proxy)
                    const runtime = frpcStatus.source === 'frp' ? frpcStatus.proxies?.find(item => item.name === proxy.name.trim()) : null
                    const labels = { starting: '启动中', running: '运行中', error: '启动失败', stopped: '已停止' }
                    return (
                      <div key={idx} className='card frp-proxy-card' style={{ marginBottom: 8 }}>
                        <div className='frp-proxy-top'>
                          <label className='frp-proxy-select'>
                            <input
                              type='checkbox' aria-label={'选择代理 ' + proxy.name} checked={selectedNames.includes(proxy.name.trim())} disabled={locked}
                              onChange={event => {
                                const checked = event.target.checked
                                setSelectedNames(prev => checked ? [...prev, proxy.name.trim()] : prev.filter(name => name !== proxy.name.trim()))
                              }}
                            />
                            <span className='frp-proxy-name'>{proxy.name}</span>
                          </label>
                          <span className='frp-proxy-type'>{proxy.type.toUpperCase()}</span>
                          <span className={runtime?.status === 'running' ? 'badge badge-success' : runtime?.status === 'error' ? 'badge badge-red' : 'badge badge-blue'}>{labels[runtime?.status] || '未启动'}</span>
                        </div>
                        <div className='frp-proxy-info'>
                          本地 :{proxy.localPort}
                          {proxy.type === 'tcp' && ` → 远程 :${proxy.remotePort}`}
                          {proxy.type === 'http' && ` → ${proxy.customDomain}`}
                        </div>
                        {runtime?.message && <div className='frp-proxy-error' role='alert'>{runtime.message}</div>}
                        {frpcStatus.running && proxyUrl && (
                          <div className='frp-proxy-url' onClick={() => handleCopyUrl(proxyUrl)} title='点击复制'>
                            <span className='frp-proxy-url-text'>{proxyUrl}</span>
                            <span className='frp-proxy-url-hint'><ClipboardCopy size={12} /> 复制</span>
                          </div>
                        )}
                        <div className='frp-proxy-actions'>
                          <button className='btn btn-ghost btn-sm' onClick={() => openEditForm(idx)} disabled={locked}><Pencil size={13} /> 编辑</button>
                          <button className='btn btn-ghost btn-sm' onClick={() => handleDeleteProxy(idx)} disabled={locked} style={{ color: 'var(--red)' }}><Trash2 size={13} /> 删除</button>
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
              <div className='frp-guide-text'>2. 在「设置」中填写服务器地址和 Token</div>
              <div className='frp-guide-text'>3. 点击「新建代理」添加代理规则</div>
              <div className='frp-guide-text'>4. 勾选需要的代理，点击「启动选中」，一个 frpc 进程只启动勾选的代理规则，等待列表显示「运行中」</div>
              <div className='frp-guide-text' style={{ marginTop: 8 }}>
                <Download size={13} /> 需要 frpc？
                <a
                  className='frp-guide-link'
                  href='#'
                  onClick={(e) => {
                    e.preventDefault()
                    try { window.utools.shellOpenExternal('https://github.com/fatedier/frp/releases') } catch (e) {}
                  }}
                >
                  前往 GitHub 下载
                </a>
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

      {/* 确认弹窗 */}
      {confirmProps && <ConfirmModal {...confirmProps} />}

      {/* 新建/编辑代理弹窗 */}
      {showForm && (
        <div className='frp-form-overlay' onClick={() => setShowForm(false)}>
          <div className='frp-form-box' onClick={(e) => e.stopPropagation()}>
            <div className='frp-form-title'>{editingIdx >= 0 ? '编辑代理' : '新建代理'}</div>

            <div className='form-group'>
              <label className='form-label'>代理名称 *</label>
              <input className='form-input' type='text' value={form.name} disabled={locked} onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))} placeholder='如 web、ssh、api' />
            </div>

            <div className='form-group'>
              <label className='form-label'>代理类型 *</label>
              <select className='form-select' value={form.type} disabled={locked} onChange={(e) => setForm(prev => ({ ...prev, type: e.target.value }))}>
                {PROXY_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label} — {t.desc}</option>
                ))}
              </select>
            </div>

            <div className='form-group'>
              <label className='form-label'>本地端口 *</label>
              <input className='form-input' type='number' value={form.localPort} disabled={locked} onChange={(e) => setForm(prev => ({ ...prev, localPort: e.target.value }))} placeholder='3000' min='1' max='65535' />
            </div>

            {form.type === 'tcp' && (
              <div className='form-group'>
                <label className='form-label'>远程端口 *</label>
                <input className='form-input' type='number' value={form.remotePort} disabled={locked} onChange={(e) => setForm(prev => ({ ...prev, remotePort: e.target.value }))} placeholder='6000' min='1' max='65535' />
                <div className='form-hint'>通过 服务器IP:远程端口 访问</div>
              </div>
            )}

            {form.type === 'http' && (
              <div className='form-group'>
                <label className='form-label'>自定义域名 *</label>
                <input className='form-input' type='text' value={form.customDomain} disabled={locked} onChange={(e) => setForm(prev => ({ ...prev, customDomain: e.target.value }))} placeholder='web.your-server.com' />
                <div className='form-hint'>需要在 frps 配置泛域名解析</div>
              </div>
            )}

            {error && (
              <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>{error}</div>
            )}

            <div className='frp-form-actions'>
              <button className='btn btn-ghost' onClick={() => setShowForm(false)} disabled={operating}>取消</button>
              <button className='btn btn-brand' onClick={handleSaveProxy} disabled={locked}>{editingIdx >= 0 ? '保存' : '创建'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
