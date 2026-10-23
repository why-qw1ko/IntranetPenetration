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
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const ownProcess = frpcStatus.running && frpcStatus.source === 'frp'
  const selectedProxies = proxies.filter(proxy => selectedNames.includes(proxy.name))
  const allSelected = proxies.length > 0 && selectedProxies.length === proxies.length
  const selectionLocked = !loaded || busy || frpcStatus.running
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
          if (saved.server) setConfig(prev => ({ ...prev, ...saved.server }))
          if (saved.proxies) setProxies(saved.proxies)
        }
        setLoaded(true)
      } catch (e) { showToast('读取 FRP 配置失败：' + e.message, 'error') }
      try {
        const status = window.services?.getFrpcStatus?.()
        if (status) {
          setFrpcStatus(status)
          if (status.running && status.source === 'frp') setSelectedNames(status.proxies.map(proxy => proxy.name))
        }
      } catch (e) {}
    }
    load()
  }, [])

  // 加载 frpc 历史日志 + 监听事件
  useEffect(() => {
    const history = (window.services?.getFrpcLogBuffer?.() || []).filter(entry => !entry.source || entry.source === 'frp')
    setLogs(history.map(h => ({ ...h, time: new Date(h.time) })))

    const onEntry = (e) => {
      if (e.detail.source && e.detail.source !== 'frp') return
      setLogs(prev => [...prev.slice(-499), { ...e.detail, time: new Date(e.detail.time) }])
    }
    const onStatus = e => setFrpcStatus(e.detail)
    const onError = (e) => {
      if (e.source && e.source !== 'frp') return
      showToast('frpc 错误: ' + e.detail, 'error')
    }
    const onExit = (e) => {
      if (e.source && e.source !== 'frp') return
      setFrpcStatus(window.services.getFrpcStatus())
    }
    window.addEventListener('frpc-status', onStatus)
    window.addEventListener('frpc-log-entry', onEntry)
    window.addEventListener('frpc-error', onError)
    window.addEventListener('frpc-exit', onExit)
    return () => {
      window.removeEventListener('frpc-status', onStatus)
      window.removeEventListener('frpc-log-entry', onEntry)
      window.removeEventListener('frpc-error', onError)
      window.removeEventListener('frpc-exit', onExit)
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
    setError('')

    const proxy = {
      name: form.name.trim(),
      type: form.type,
      localPort: form.localPort,
      remotePort: form.type === 'tcp' ? form.remotePort : undefined,
      customDomain: form.type === 'http' ? form.customDomain.trim().toLowerCase().replace(/\.$/, '') : undefined
    }

    let newProxies
    if (editingIdx >= 0) {
      newProxies = [...proxies]
      newProxies[editingIdx] = proxy
    } else {
      newProxies = [...proxies, proxy]
    }
    const validation = window.services.validateFrpProxies(newProxies, config)
    if (validation) { setError(validation); return }
    proxy.localPort = Number(proxy.localPort)
    if (proxy.type === 'tcp') proxy.remotePort = Number(proxy.remotePort)
    try {
      const result = await window.services.saveFrpConfig({ proxies: newProxies })
      if (!result?.success) throw new Error(result?.message || '保存失败')
      if (editingIdx >= 0) {
        const previousName = proxies[editingIdx].name
        setSelectedNames(prev => prev.map(name => name === previousName ? proxy.name : name))
      }
      setProxies(newProxies)
      setShowForm(false)
      showToast('代理已保存', 'success')
    } catch (e) { setError('保存代理失败：' + e.message) }
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
          const result = await window.services.saveFrpConfig({ proxies: newProxies })
          if (!result?.success) throw new Error(result?.message || '保存失败')
          setProxies(newProxies)
          setSelectedNames(prev => prev.filter(name => name !== proxy.name))
        } catch (e) {
          showToast('保存失败: ' + e.message, 'error')
          return
        }
        showToast('已删除', 'success')
      },
      onCancel: () => setConfirmProps(null)
    })
  }, [proxies, config, showToast])

  const handleStart = useCallback(async () => {
    if (!selectedProxies.length) { showToast('请先勾选要启动的代理', 'error'); return }
    setBusy(true)
    try {
      const result = await window.services.startFrpc(config, selectedProxies, 'frp')
      setFrpcStatus(window.services.getFrpcStatus())
      if (!result?.success) throw new Error(result?.message || '启动失败')
      showToast('正在启动：' + selectedProxies.map(proxy => proxy.name).join('、'))
    } catch (e) { showToast('启动失败：' + e.message, 'error') }
    setBusy(false)
  }, [config, selectedProxies, showToast])

  const handleStopAll = useCallback(async () => {
    setBusy(true)
    try {
      const result = await window.services.stopFrpc('frp')
      if (!result?.success) throw new Error(result?.message || '停止失败')
      showToast('本次启动的代理已停止', 'success')
    } catch (e) { showToast('停止失败：' + e.message, 'error') }
    setFrpcStatus(window.services.getFrpcStatus())
    setBusy(false)
  }, [showToast])

  const handleCopyLogs = useCallback(() => {
    const text = logs.map(l => `[${formatTime(l.time)}] [${l.type}] ${l.text}`).join('\n')
    window.utools?.copyText(text)
    showToast('日志已复制', 'success')
  }, [logs, showToast])

  // 计算代理的访问 URL
  const getProxyUrl = useCallback((proxy) => {
    const address = frpcStatus.serverAddr || config.serverAddr
    if (!address) return ''
    if (proxy.type === 'tcp') {
      return address + ':' + proxy.remotePort
    } else if (proxy.type === 'http') {
      return 'http://' + proxy.customDomain
    }
    return ''
  }, [config.serverAddr, frpcStatus.serverAddr])

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
          {ownProcess && <span className='badge badge-blue'>{frpcStatus.state === 'running' ? '运行中' : frpcStatus.state === 'stopping' ? '正在停止' : frpcStatus.state === 'error' ? '存在失败代理' : '启动中'}</span>}
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
              <span className='card-title'><Server size={15} /> 服务器</span>
              <button className='btn btn-ghost btn-sm' onClick={onOpenSettings}>前往设置</button>
            </div>
            <div className='frp-proxy-info'>{config.serverAddr ? config.serverAddr + ':' + config.serverPort : '请在设置中配置 FRP 服务器'}</div>
            <div className='form-hint'>服务器配置由内网穿透和代理目录共用，在设置中自动保存。</div>
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
                {ownProcess ? (
                  <button className='btn btn-warning btn-sm' onClick={handleStopAll} disabled={busy || frpcStatus.state === 'stopping'}><Square size={13} /> 停止本次启动</button>
                ) : (
                  <button className='btn btn-brand btn-sm' onClick={handleStart} disabled={selectionLocked || selectedProxies.length === 0}><Play size={13} /> 启动选中 ({selectedProxies.length})</button>
                )}
                <button className='btn btn-ghost btn-sm' onClick={openCreateForm} disabled={!loaded || busy || ownProcess}>+ 新建代理</button>
              </div>
            </div>

            {proxies.length > 0 && (
              <div className='frp-selection-toolbar'>
                <label className='form-checkbox'>
                  <input
                    type='checkbox' aria-label='全选代理' checked={allSelected} disabled={selectionLocked}
                    ref={node => { if (node) node.indeterminate = selectedProxies.length > 0 && !allSelected }}
                    onChange={event => setSelectedNames(event.target.checked ? proxies.map(proxy => proxy.name) : [])}
                  />
                  全选
                </label>
                <span role='status'>已选 {selectedProxies.length} / {proxies.length}</span>
                <span>{ownProcess ? '更换代理前，请先停止本次启动。' : '勾选需要启动的代理，可同时转发多个端口。'}</span>
              </div>
            )}

            {proxies.length === 0 ? (
              <div className='empty' style={{ padding: '24px 0' }}>
                <div className='empty-icon'><Link2 size={40} strokeWidth={1.2} /></div>
                <div className='empty-text'>暂无代理规则</div>
                <div className='empty-hint'>点击「新建代理」添加你的第一个 frp 代理</div>
              </div>
            ) : (
              proxies.map((proxy, idx) => {
                const runtime = frpcStatus.source === 'frp' ? frpcStatus.proxies?.find(item => item.name === proxy.name) : null
                const proxyUrl = getProxyUrl(runtime || proxy)
                const labels = { starting: '启动中', running: '运行中', error: '启动失败', stopped: '已停止' }
                return (
                  <div key={proxy.name} className='card frp-proxy-card' style={{ marginBottom: 8 }}>
                    <div className='frp-proxy-top'>
                      <label className='frp-proxy-select'>
                        <input
                          type='checkbox' aria-label={'选择代理 ' + proxy.name} checked={selectedNames.includes(proxy.name)} disabled={selectionLocked}
                          onChange={event => {
                            const checked = event.target.checked
                            setSelectedNames(prev => checked ? [...prev, proxy.name] : prev.filter(name => name !== proxy.name))
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
                    {runtime?.status === 'running' && proxyUrl && (
                      <div className='frp-proxy-url' onClick={() => handleCopyUrl(proxyUrl)} title='点击复制'>
                        <span className='frp-proxy-url-text'>{proxyUrl}</span>
                        <span className='frp-proxy-url-hint'><ClipboardCopy size={12} /> 复制</span>
                      </div>
                    )}
                    {runtime?.message && <div className='frp-proxy-error' role='alert'>{runtime.message}</div>}
                    <div className='frp-proxy-actions'>
                      <button className='btn btn-ghost btn-sm' onClick={() => openEditForm(idx)} disabled={busy || ownProcess}><Pencil size={13} /> 编辑</button>
                      <button className='btn btn-ghost btn-sm' onClick={() => handleDeleteProxy(idx)} disabled={busy || ownProcess} style={{ color: 'var(--red)' }}><Trash2 size={13} /> 删除</button>
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
              <div className='frp-guide-text'>4. 勾选需要的代理，点击「启动选中」，等待列表显示「运行中」</div>
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
                <div className='form-hint'>同一服务器的远程端口不能重复；本地端口可以被多条代理转发。</div>
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
