import { useEffect, useRef, useState } from 'react'
import { Link2, Server } from 'lucide-react'

export default function FrpServerSettings ({ showToast }) {
  const [server, setServer] = useState({ serverAddr: '', serverPort: '7000', token: '' })
  const [loaded, setLoaded] = useState(false)
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState('')
  const [errors, setErrors] = useState({})
  const saved = useRef({})

  useEffect(() => {
    window.services.getFrpConfig().then(config => {
      const values = { serverAddr: '', serverPort: '7000', token: '', ...config?.server }
      setServer(values)
      saved.current = values
      setLoaded(true)
    }).catch(() => setStatus('配置读取失败，请重新进入设置'))
  }, [])

  const saveField = async (key, value) => {
    if (saved.current[key] === value) {
      setErrors(prev => ({ ...prev, [key]: '' }))
      setStatus('已保存')
      return
    }
    try {
      const result = await window.services.saveFrpConfig({ server: { [key]: value } })
      if (!result?.success) throw new Error(result?.message || '保存失败')
      saved.current = { ...saved.current, [key]: value }
      setErrors(prev => ({ ...prev, [key]: '' }))
      setStatus('已保存')
    } catch (error) {
      setErrors(prev => ({ ...prev, [key]: '未保存：' + error.message }))
      showToast(error.message, 'error')
    }
  }

  const testConnection = async () => {
    setTesting(true)
    try {
      const result = await window.services.testFrpConnection(server.serverAddr.trim(), server.serverPort)
      showToast(result?.success ? '服务器端口可连接，Token 和代理注册结果请在启动后查看' : '连接失败：' + result?.message, result?.success ? 'success' : 'error')
    } catch (error) { showToast('连接失败：' + error.message, 'error') }
    setTesting(false)
  }

  return (
    <div className='card'>
      <div className='card-header'><span className='card-title'><Server size={15} /> FRP 服务器</span></div>
      <div className='form-hint'>内网穿透和代理目录共用此配置，随 uTools 账号同步。</div>
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
        <button className='btn btn-ghost btn-sm' onClick={testConnection} disabled={testing || !loaded}><Link2 size={14} /> {testing ? '测试中…' : '测试连接'}</button>
        <span className='form-hint' role='status'>{Object.values(errors).some(Boolean) ? '存在未保存配置，请修正上方字段' : status}</span>
      </div>
    </div>
  )
}
