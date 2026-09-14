import { useState, useCallback, useEffect } from 'react'
import './index.css'

function parsePort (value) {
  const num = Number(value)
  return Number.isInteger(num) && num >= 1 && num <= 65535 ? num : null
}

export default function CreateTunnel ({ onBack, onCreated, showToast }) {
  const [port, setPort] = useState('80')
  const [protocol, setProtocol] = useState('auto')
  const [anonymous, setAnonymous] = useState(true)
  const [description, setDescription] = useState('')
  const [tunnelId, setTunnelId] = useState('')
  const [expiration, setExpiration] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const c = window.services?.getConfig()
    if (c) {
      setPort(c.defaultPort)
      setProtocol(c.defaultProtocol)
      setAnonymous(c.defaultAnonymous)
    }
  }, [])

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault()
    setError('')
    if (!port) { setError('请输入端口号'); return }
    const portNum = parsePort(port)
    if (!portNum) {
      setError('端口号必须是 1-65535 之间的整数')
      return
    }

    setCreating(true)
    try {
      const tunnel = await window.services.createTunnel({
        tunnelId: tunnelId || undefined,
        port: portNum,
        protocol,
        anonymous,
        description: description || undefined,
        expiration: expiration || undefined
      })
      showToast('隧道创建成功', 'success')
      onCreated(tunnel)
    } catch (err) {
      setError(err.message || '创建失败')
      showToast(err.message || '创建失败', 'error')
    } finally {
      setCreating(false)
    }
  }, [port, protocol, anonymous, description, tunnelId, expiration, onCreated, showToast])

  return (
    <>
      <div className='topbar'>
        <div className='topbar-left'>
          <button className='back-btn' onClick={onBack} title='返回'>
            <svg width='16' height='16' viewBox='0 0 16 16' fill='none'>
              <path d='M10 12L6 8L10 4' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
            </svg>
          </button>
          <span className='topbar-title'>新建隧道</span>
        </div>
      </div>

      <div className='page'>
        <form onSubmit={handleSubmit}>
          <div className='card'>
            <div className='card-header'>
              <span className='card-title'>基本配置</span>
            </div>

            <div className='form-group'>
              <label className='form-label'>端口号 *</label>
              <input className='form-input' type='number' value={port} onChange={(e) => setPort(e.target.value)} placeholder='80、3000、8080...' min='1' max='65535' />
              <div className='form-hint'>要穿透的本地服务端口</div>
            </div>

            <div className='form-group'>
              <label className='form-label'>协议</label>
              <select className='form-select' value={protocol} onChange={(e) => setProtocol(e.target.value)}>
                <option value='auto'>自动 (auto)</option>
                <option value='http'>HTTP</option>
                <option value='https'>HTTPS</option>
              </select>
            </div>

            <label className='form-checkbox'>
              <input type='checkbox' checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
              允许匿名访问
            </label>
            <div className='form-hint' style={{ marginLeft: 26 }}>开启后任何人可通过 URL 访问</div>
          </div>

          <div className='card'>
            <div className='card-header'>
              <span className='card-title'>可选配置</span>
            </div>

            <div className='form-group'>
              <label className='form-label'>隧道 ID</label>
              <input className='form-input' type='text' value={tunnelId} onChange={(e) => setTunnelId(e.target.value)} placeholder='留空自动生成' />
            </div>

            <div className='form-group'>
              <label className='form-label'>描述</label>
              <input className='form-input' type='text' value={description} onChange={(e) => setDescription(e.target.value)} placeholder='用途说明' />
            </div>

            <div className='form-group' style={{ marginBottom: 0 }}>
              <label className='form-label'>过期时间</label>
              <input className='form-input' type='text' value={expiration} onChange={(e) => setExpiration(e.target.value)} placeholder='24h、7d' />
              <div className='form-hint'>h=小时，d=天，留空使用默认值</div>
            </div>
          </div>

          {error && (
            <div className='card' style={{ borderLeft: '3px solid var(--red)', color: 'var(--red)', fontSize: 13 }}>
              {error}
            </div>
          )}

          <button className='btn btn-brand btn-block' type='submit' disabled={creating}>
            {creating ? <><span className='spinner' /> 创建中...</> : '创建隧道'}
          </button>
        </form>
      </div>
    </>
  )
}
