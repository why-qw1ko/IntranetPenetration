const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { StringDecoder } = require('string_decoder')

function isPort (value) {
  return ['number', 'string'].includes(typeof value) && /^\d+$/.test(String(value)) && Number(value) >= 1 && Number(value) <= 65535
}

function validateServer (server, required = true) {
  if (!server || typeof server.serverAddr !== 'string' || (server.token !== undefined && typeof server.token !== 'string')) return '服务器配置格式无效'
  if (required && !server?.serverAddr?.trim()) return '请输入服务器地址'
  if (server?.serverAddr && /[\s/\\?#"']/.test(server.serverAddr.trim())) return '服务器地址应为 IP 或域名，不包含协议、路径或空格'
  if (!isPort(server?.serverPort)) return '服务器端口必须是 1–65535 的整数'
  return ''
}

function validateProxies (proxies, server) {
  if (!Array.isArray(proxies)) return '代理规则格式无效'
  const names = new Set()
  const ports = new Map()
  const domains = new Map()
  for (const proxy of proxies) {
    if (!proxy || typeof proxy.name !== 'string') return '请输入有效的代理名称'
    const name = proxy.name?.trim()
    if (!name || [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return '请输入有效的代理名称'
    if (names.has(name)) return `代理名称「${name}」已存在`
    names.add(name)
    if (!['tcp', 'http'].includes(proxy.type)) return `「${name}」的代理类型无效`
    if (!isPort(proxy.localPort)) return `「${name}」的本地端口必须是 1–65535 的整数`
    if (proxy.type === 'tcp') {
      if (!isPort(proxy.remotePort)) return `「${name}」的远程端口必须是 1–65535 的整数`
      const port = Number(proxy.remotePort)
      if (port === Number(server?.serverPort)) return `远程端口 ${port} 与服务器监听端口冲突`
      if (ports.has(port)) return `远程端口 ${port} 已被「${ports.get(port)}」使用`
      ports.set(port, name)
    } else {
      const domain = typeof proxy.customDomain === 'string' ? proxy.customDomain.trim().toLowerCase().replace(/\.$/, '') : ''
      if (!/^(\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.includes('..')) return `「${name}」请输入有效域名，不包含协议、端口或路径`
      if (domains.has(domain)) return `域名 ${domain} 已被「${domains.get(domain)}」使用`
      domains.set(domain, name)
    }
  }
  return ''
}

function generateFrpcConfig (server, proxies) {
  const error = validateServer(server) || validateProxies(proxies, server)
  if (error) throw new Error(error)
  const quote = value => JSON.stringify(String(value))
  const lines = [`serverAddr = ${quote(server.serverAddr.trim())}`, `serverPort = ${Number(server.serverPort)}`]
  if (server.token) lines.push(`auth.token = ${quote(server.token)}`)
  for (const proxy of proxies) {
    lines.push('', '[[proxies]]', `name = ${quote(proxy.name.trim())}`, `type = ${quote(proxy.type)}`, `localPort = ${Number(proxy.localPort)}`)
    if (proxy.type === 'tcp') lines.push(`remotePort = ${Number(proxy.remotePort)}`)
    else lines.push(`customDomains = [${quote(proxy.customDomain.trim().toLowerCase().replace(/\.$/, ''))}]`)
  }
  return lines.join('\n') + '\n'
}

function createFrpcController ({ getFrpcPath, addFrpcLog, emitEvent }) {
  let active = null
  let status = { running: false, state: 'stopped', proxies: [] }
  const snapshot = () => ({ ...status, proxies: status.proxies.map(proxy => ({ ...proxy })) })
  const emit = (name, detail, source = status.source) => {
    emitEvent(name, detail, source)
  }
  const notify = () => emit('frpc-status', snapshot())

  async function startFrpc (server, proxies, source = 'frp') {
    if (active) return { success: false, message: `frpc 正由「${status.source === 'proxydir' ? '代理目录' : 'Frp 内网穿透'}」使用，请先在对应页面停止` }
    const error = validateServer(server) || validateProxies(proxies, server) || (!proxies.length && '请先添加代理规则')
    if (error) return { success: false, message: error }
    const executable = getFrpcPath()
    if (!fs.existsSync(executable)) return { success: false, message: 'frpc 未找到，请在「设置」中配置本机 frpc 路径' }
    let tempDir
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-tunnel-'))
      const configPath = path.join(tempDir, 'frpc.toml')
      fs.writeFileSync(configPath, generateFrpcConfig(server, proxies), { encoding: 'utf8', mode: 0o600 })
      const child = spawn(executable, ['-c', configPath], { windowsHide: true })
      let spawned = false
      active = child
      status = {
        running: true,
        state: 'starting',
        source,
        pid: child.pid,
        serverAddr: server.serverAddr.trim(),
        serverPort: Number(server.serverPort),
        proxies: proxies.map(proxy => ({ ...proxy, name: proxy.name.trim(), status: 'starting', message: '' }))
      }
      notify()
      addFrpcLog('system', `正在启动 ${status.serverAddr}:${status.serverPort}，代理：${status.proxies.map(p => p.name).join('、')}`, source)
      const redact = text => server.token ? text.split(server.token).join('[已隐藏]') : text
      let closed = false
      const finish = (code, message) => {
        if (closed) return
        closed = true
        const stopped = status.state === 'stopping'
        active = null
        status = {
          ...status,
          running: false,
          state: stopped || code === 0 ? 'stopped' : 'error',
          pid: null,
          proxies: status.proxies.map(proxy => ({ ...proxy, status: stopped || code === 0 ? 'stopped' : 'error', message: stopped ? '' : message || proxy.message || (code === 0 ? '' : `frpc 已退出 (${code})，请查看日志`) }))
        }
        notify()
        if (!stopped && code !== 0) emit('frpc-error', message || `frpc 退出码：${code}`, source)
        emit('frpc-exit', code, source)
        addFrpcLog('system', `frpc 已退出 (${code})`, source)
        try { fs.unlinkSync(configPath); fs.rmdirSync(tempDir) } catch (e) {}
      }
      // 按行处理输出，避免 stdout 数据块截断代理名称或成功消息。
      const watchOutput = (stream, type) => {
        let pending = ''
        const decoder = new StringDecoder('utf8')
        const consume = line => {
          if (closed || active !== child) return
          // frpc 可能输出 ANSI 颜色码，需要先去掉再匹配代理状态。
          // eslint-disable-next-line no-control-regex
          const text = line.replace(/\x1b\[[0-9;]*m/g, '').trim()
          if (!text) return
          addFrpcLog(type, redact(text), source)
          for (const proxy of status.proxies) {
            if (!text.includes(`[${proxy.name}]`)) continue
            if (/start proxy success/i.test(text)) { proxy.status = 'running'; proxy.message = '' }
            const failure = text.match(/start error:\s*(.*)/i)
            if (failure) { proxy.status = 'error'; proxy.message = redact(failure[1]) }
          }
          if (status.state !== 'stopping') {
            status.state = status.proxies.some(p => p.status === 'starting') ? 'starting' : status.proxies.every(p => p.status === 'running') ? 'running' : 'error'
          }
          notify()
        }
        stream.on('data', data => {
          pending += decoder.write(data)
          const lines = pending.split(/\r?\n/)
          pending = lines.pop()
          lines.forEach(consume)
        })
        stream.on('end', () => { pending += decoder.end(); if (pending) consume(pending) })
      }
      watchOutput(child.stdout, 'stdout')
      watchOutput(child.stderr, 'stderr')
      child.once('close', code => finish(code))
      return await new Promise(resolve => {
        child.once('spawn', () => { spawned = true; resolve({ success: true, pid: child.pid }) })
        child.on('error', err => {
          if (closed) return
          const message = redact(err.message)
          if (!spawned) finish(-1, message)
          else {
            addFrpcLog('error', message, source)
            emit('frpc-error', message, source)
          }
          resolve({ success: false, message })
        })
      })
    } catch (err) {
      if (tempDir) {
        try { fs.unlinkSync(path.join(tempDir, 'frpc.toml')) } catch (e) {}
        try { fs.rmdirSync(tempDir) } catch (e) {}
      }
      return { success: false, message: err.message }
    }
  }

  async function stopFrpc (source) {
    if (!active) return { success: false, message: 'frpc 未在运行' }
    if (source && source !== status.source) return { success: false, message: '请在启动 frpc 的页面停止' }
    if (status.state === 'stopping') return { success: false, message: '正在停止，请稍候' }
    const child = active
    const previousState = status.state
    status.state = 'stopping'
    notify()
    return await new Promise(resolve => {
      let settled = false
      const complete = result => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.removeListener('close', onClose)
        child.removeListener('error', onError)
        if (!result.success && active === child) { status.state = previousState; notify() }
        resolve(result)
      }
      const onClose = () => complete({ success: true })
      const onError = err => complete({ success: false, message: err.message })
      child.once('close', onClose)
      child.once('error', onError)
      const timer = setTimeout(() => complete({ success: false, message: '停止超时，请重试' }), 5000)
      try {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
          killer.once('error', err => complete({ success: false, message: err.message }))
          killer.once('close', code => { if (code && active === child) complete({ success: false, message: `停止失败 (${code})` }) })
        } else child.kill()
      } catch (err) { complete({ success: false, message: err.message }) }
    })
  }

  return { startFrpc, stopFrpc, getFrpcStatus: snapshot }
}

module.exports = { isPort, validateServer, validateProxies, generateFrpcConfig, createFrpcController }
