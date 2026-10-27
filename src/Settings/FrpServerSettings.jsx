import { useEffect, useRef, useState } from 'react'
import { Link2, Server } from 'lucide-react'

function validPort (value) {
  return /^\d+$/.test(String(value)) && Number(value) >= 1 && Number(value) <= 65535
}

export default function FrpServerSettings ({ showToast }) {
  const [server, setServer] = useState({ serverAddr: '', serverPort: '7000', token: '' })
  const [loaded, setLoaded] = useState(false)
  const [testing, setTesting] = useState(false)
  const [pending, setPending] = useState(0)
  const [status, setStatus] = useState('输入框失焦时自动保存')
  const [errors, setErrors] = useState({})
  const saved = useRef({})
  const active = useRef(false)
  const queue = useRef(Promise.resolve())
  const versions = useRef({})

  useEffect(() => {
    active.current = true
    let cancelled = false
    const load = async () => {
      try {
        const config = await window.services.getFrpConfig()
        if (cancelled) return
        const values = { serverAddr: '', serverPort: '7000', token: '', ...config?.server }
        setServer(values)
        saved.current = values
        setLoaded(true)
      } catch (error) {
        if (!cancelled) setStatus('配置读取失败，请重新进入设置')
      }
    }
    load()
    return () => { cancelled = true; active.current = false }
  }, [])

  // 串行提交字段，切页后仍完成已提交的保存，但不再更新卸载组件。
  const saveField = (key, value) => {
    const version = (versions.current[key] || 0) + 1
    versions.current[key] = version
    setServer(prev => ({ ...prev, [key]: value }))
    setPending(prev => prev + 1)
    queue.current = queue.current.then(async () => {
      try {
        if (key === 'serverPort' && !validPort(value)) throw new Error('服务器端口必须是 1-65535 之间的整数')
        if (key === 'serverAddr' && value && /[\s/\\]/.test(value)) throw new Error('请输入服务器 IP 或域名，不含协议和路径')
        if (saved.current[key] !== value) {
          const result = await window.services.saveFrpConfig({ server: { [key]: value } })
          if (!result?.success) throw new Error(result?.message || '保存失败')
          saved.current = { ...saved.current, [key]: value }
        }
        if (active.current && versions.current[key] === version) {
          setErrors(prev => ({ ...prev, [key]: '' }))
          setStatus('已保存')
        }
      } catch (error) {
        if (active.current && versions.current[key] === version) {
          setErrors(prev => ({ ...prev, [key]: '未保存：' + error.message }))
          showToast(error.message, 'error')
        }
      } finally {
        if (active.current) setPending(prev => prev - 1)
      }
    })
    return queue.current
  }

  const testConnection = async () => {
    if (!server.serverAddr.trim() || !validPort(server.serverPort)) {
      showToast('请填写有效的服务器地址和端口', 'error')
      return
    }
    setTesting(true)
    try {
      const result = await window.services.testFrpConnection(server.serverAddr.trim(), Number(server.serverPort))
      if (active.current) showToast(result?.success ? '服务器端口可连接，Token 和代理注册结果请在启动后查看' : '连接失败：' + (result?.message || '未知错误'), result?.success ? 'success' : 'error')
    } catch (error) {
      if (active.current) showToast('连接失败：' + error.message, 'error')
    } finally {
      if (active.current) setTesting(false)
    }
  }

  return (
    <div className='card'>
      <div className='card-header'><span className='card-title'><Server size={15} /> FRP 服务器</span></div>
      <div className='form-hint'>内网穿透和代理目录共用此配置。地址、端口随 uTools 配置同步；Token 沿用独立存储，不写入服务器同步文档。</div>
      {[
        ['serverAddr', '服务器地址', 'text', '服务器 IP 或域名'],
        ['serverPort', '服务器端口', 'number', '7000'],
        ['token', '认证 Token', 'password', 'frps 配置的 token']
      ].map(([key, label, type, placeholder]) => (
        <div className='form-group' key={key}>
          <label className='form-label' htmlFor={'frp-' + key}>{label}</label>
          <input
            id={'frp-' + key} className='form-input' type={type} value={server[key]} placeholder={placeholder} disabled={!loaded}
            min={type === 'number' ? 1 : undefined} max={type === 'number' ? 65535 : undefined}
            aria-invalid={Boolean(errors[key])} aria-describedby={errors[key] ? 'frp-error-' + key : undefined}
            onChange={event => { setServer(prev => ({ ...prev, [key]: event.target.value })); setStatus('离开输入框后保存') }}
            onBlur={event => saveField(key, key === 'token' ? event.target.value : event.target.value.trim())}
          />
          {errors[key] && <div className='settings-field-error' id={'frp-error-' + key} role='alert'>{errors[key]}</div>}
        </div>
      ))}
      <div className='path-actions'>
        <button className='btn btn-ghost btn-sm' onClick={testConnection} disabled={testing || !loaded || pending > 0}><Link2 size={14} /> {testing ? '测试中…' : '测试连接'}</button>
        <span className='form-hint' role='status'>{pending ? '保存中…' : Object.values(errors).some(Boolean) ? '存在未保存配置，请修正上方字段' : status}</span>
      </div>
    </div>
  )
}
