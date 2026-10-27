import { useState, useEffect, useCallback, useRef } from 'react'
import { Menu } from 'lucide-react'
import ConfirmModal from '../ConfirmModal'
import FrpServerSettings from './FrpServerSettings'
import './index.css'

function isValidPort (value) {
  if (!/^\d+$/.test(String(value))) return false
  const num = Number(value)
  return Number.isInteger(num) && num >= 1 && num <= 65535
}

export default function Settings ({ onToggleSidebar, showToast }) {
  const [config, setConfig] = useState({ path: '', defaultPort: '80', defaultProtocol: 'auto', defaultAnonymous: true })
  const [pathStatus, setPathStatus] = useState(null)
  const [validating, setValidating] = useState(false)

  const [frpcPath, setFrpcPath] = useState('')
  const [frpcPathStatus, setFrpcPathStatus] = useState(null)
  const [validatingFrpc, setValidatingFrpc] = useState(false)

  const [confirmProps, setConfirmProps] = useState(null)
  const [saveStatus, setSaveStatus] = useState('输入框失焦时自动保存，选项修改后立即保存')
  const [saveErrors, setSaveErrors] = useState({})
  const [resetKey, setResetKey] = useState(0)
  const savedConfig = useRef({})
  const savedFrpcPath = useRef('')

  useEffect(() => {
    const c = window.services?.getConfig()
    if (c) { setConfig(c); savedConfig.current = c }
    const fp = window.services?.getFrpcPath?.() || ''
    setFrpcPath(fp)
    savedFrpcPath.current = fp
  }, [])

  const saveSetting = useCallback((key, value) => {
    try {
      if (key === 'defaultPort' && !isValidPort(value)) throw new Error('默认端口必须是 1-65535 之间的整数')
      if (key === 'path') setConfig(prev => ({ ...prev, path: value }))
      if (savedConfig.current[key] !== value) {
        const result = window.services.saveConfig({ [key]: value })
        if (!result?.success) throw new Error(result?.message || '保存失败')
        savedConfig.current = { ...savedConfig.current, [key]: value }
      }
      setSaveErrors(prev => ({ ...prev, [key]: '' }))
      setSaveStatus('已保存')
    } catch (error) {
      setSaveErrors(prev => ({ ...prev, [key]: '未保存：' + error.message }))
      showToast(error.message, 'error')
    }
  }, [showToast])

  const saveFrpc = useCallback(value => {
    setFrpcPath(value)
    try {
      if (savedFrpcPath.current !== value) {
        const result = window.services.saveFrpcPath(value)
        if (!result?.success) throw new Error(result?.message || '保存失败')
        savedFrpcPath.current = value
      }
      setSaveErrors(prev => ({ ...prev, frpcPath: '' }))
      setSaveStatus('已保存')
    } catch (error) {
      setSaveErrors(prev => ({ ...prev, frpcPath: '未保存：' + error.message }))
      showToast(error.message, 'error')
    }
  }, [showToast])

  // devtunnel 路径
  const validatePath = useCallback(async () => {
    if (!config.path) { setPathStatus(null); return }
    setValidating(true)
    const result = await window.services.validatePath(config.path)
    setPathStatus(result)
    setValidating(false)
  }, [config.path])

  const handleSelectFile = useCallback(() => {
    const file = window.services.selectFile()
    if (file) {
      setConfig(prev => ({ ...prev, path: file }))
      setPathStatus(null)
      saveSetting('path', file)
    }
  }, [saveSetting])

  // frpc 路径
  const validateFrpcPath = useCallback(async () => {
    if (!frpcPath) { setFrpcPathStatus(null); return }
    setValidatingFrpc(true)
    const result = await window.services.validateFrpcPath(frpcPath)
    setFrpcPathStatus(result)
    setValidatingFrpc(false)
  }, [frpcPath])

  const handleSelectFrpcFile = useCallback(() => {
    const file = window.services.selectFrpcFile()
    if (file) {
      setFrpcPath(file)
      setFrpcPathStatus(null)
      saveFrpc(file)
    }
  }, [saveFrpc])

  const handleClearData = useCallback(() => {
    setConfirmProps({
      title: '清除所有数据',
      message: '确定要清除所有已存储的配置和日志吗？包括 devtunnel 配置、frp 配置、代理目录设置和运行日志。此操作不可撤销。',
      confirmText: '清除所有数据',
      danger: true,
      onConfirm: () => {
        setConfirmProps(null)
        window.services?.clearAllData?.()
        // 重新读取配置（清除缓存后的默认值）
        const freshConfig = window.services?.getConfig?.()
        if (freshConfig) setConfig(freshConfig)
        else setConfig({ path: '', defaultPort: '80', defaultProtocol: 'auto', defaultAnonymous: true })
        const freshFrpcPath = window.services?.getFrpcPath?.() || ''
        setFrpcPath(freshFrpcPath)
        setPathStatus(null)
        setFrpcPathStatus(null)
        savedConfig.current = freshConfig || {}
        savedFrpcPath.current = freshFrpcPath || ''
        setResetKey(prev => prev + 1)
        setSaveStatus('数据已清除')
        setSaveErrors({})
        showToast('所有数据已清除', 'success')
      },
      onCancel: () => setConfirmProps(null)
    })
  }, [showToast])

  return (
    <>
      <div className='topbar'>
        <div className='topbar-left'>
          <button className='topbar-menu-btn' onClick={onToggleSidebar} title='菜单'>
            <Menu size={18} />
          </button>
          <span className='topbar-title'>设置</span>
        </div>
      </div>

      <div className='page'>
        <div className='settings-save-status' role='status'>{Object.values(saveErrors).some(Boolean) ? Object.values(saveErrors).filter(Boolean).join('；') : saveStatus}</div>
        <div className='form-hint settings-sync-hint'>隧道默认值、FRP 服务器地址、端口和代理规则通过 uTools 同步；可执行文件路径、目录设置和 Token 按设备隔离，换电脑需分别配置。</div>
        <div className='card'>
          <div className='card-header'>
            <span className='card-title'>devtunnel 可执行文件</span>
          </div>
          <div className='path-row'>
            <input
              className='form-input path-input'
              type='text'
              value={config.path}
              onChange={(e) => { setConfig(prev => ({ ...prev, path: e.target.value })); setPathStatus(null); setSaveErrors(prev => ({ ...prev, path: '' })) }}
              onBlur={e => saveSetting('path', e.target.value.trim())}
              aria-invalid={Boolean(saveErrors.path)}
              placeholder='C:\path\to\devtunnel.exe'
            />
            <button className='btn btn-ghost' onClick={handleSelectFile}>浏览</button>
          </div>
          <div className='path-actions'>
            <button className='btn btn-ghost btn-sm' onClick={validatePath} disabled={validating}>
              {validating ? <><span className='spinner' /> 验证中</> : '验证路径'}
            </button>
            {pathStatus?.valid && <span className='badge badge-success'>✓ {pathStatus.version}</span>}
            {pathStatus && !pathStatus.valid && <span className='badge badge-red'>✗ {pathStatus.message}</span>}
          </div>
        </div>

        <div className='card'>
          <div className='card-header'>
            <span className='card-title'>frpc 可执行文件</span>
          </div>
          <div className='path-row'>
            <input
              className='form-input path-input'
              type='text'
              value={frpcPath}
              onChange={(e) => { setFrpcPath(e.target.value); setFrpcPathStatus(null); setSaveErrors(prev => ({ ...prev, frpcPath: '' })) }}
              onBlur={e => saveFrpc(e.target.value.trim())}
              aria-invalid={Boolean(saveErrors.frpcPath)}
              placeholder='/path/to/frpc 或 frpc.exe'
            />
            <button className='btn btn-ghost' onClick={handleSelectFrpcFile}>浏览</button>
          </div>
          <div className='form-hint'>留空自动检测 devtunnel 同目录下的 frpc</div>
          <div className='path-actions'>
            <button className='btn btn-ghost btn-sm' onClick={validateFrpcPath} disabled={validatingFrpc}>
              {validatingFrpc ? <><span className='spinner' /> 验证中</> : '验证路径'}
            </button>
            {frpcPathStatus?.valid && <span className='badge badge-success'>✓ {frpcPathStatus.version}</span>}
            {frpcPathStatus && !frpcPathStatus.valid && <span className='badge badge-red'>✗ {frpcPathStatus.message}</span>}
          </div>
        </div>

        <div className='card'>
          <div className='card-header'>
            <span className='card-title'>创建隧道默认值</span>
          </div>
          <div className='form-group'>
            <label className='form-label'>默认端口</label>
            <input className='form-input' type='number' value={config.defaultPort} onChange={(e) => { setConfig(prev => ({ ...prev, defaultPort: e.target.value })); setSaveErrors(prev => ({ ...prev, defaultPort: '' })) }} onBlur={e => saveSetting('defaultPort', e.target.value)} aria-invalid={Boolean(saveErrors.defaultPort)} min='1' max='65535' />
          </div>
          <div className='form-group'>
            <label className='form-label'>默认协议</label>
            <select className='form-select' value={config.defaultProtocol} onChange={(e) => { setConfig(prev => ({ ...prev, defaultProtocol: e.target.value })); saveSetting('defaultProtocol', e.target.value); setSaveErrors(prev => ({ ...prev, defaultProtocol: '' })) }}>
              <option value='auto'>自动 (auto)</option>
              <option value='http'>HTTP</option>
              <option value='https'>HTTPS</option>
            </select>
          </div>
          <label className='form-checkbox'>
            <input type='checkbox' checked={config.defaultAnonymous} onChange={(e) => { setConfig(prev => ({ ...prev, defaultAnonymous: e.target.checked })); saveSetting('defaultAnonymous', e.target.checked); setSaveErrors(prev => ({ ...prev, defaultAnonymous: '' })) }} />
            默认允许匿名访问
          </label>
        </div>

        <FrpServerSettings key={resetKey} showToast={showToast} />

        <div className='divider' style={{ margin: '24px 0' }} />

        <div className='card'>
          <div className='card-header'>
            <span className='card-title'>数据管理</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, color: 'var(--text-sub)' }}>
              清除所有已存储的配置和日志数据
            </span>
            <button className='btn btn-danger btn-sm' onClick={handleClearData}>清除所有数据</button>
          </div>
        </div>
      </div>

      {confirmProps && <ConfirmModal {...confirmProps} />}
    </>
  )
}
