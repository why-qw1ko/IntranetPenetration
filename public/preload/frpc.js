const fs = require('fs')
const os = require('os')
const path = require('path')
const { watchOutput, stopProcess } = require('./process-utils')

module.exports = function createFrpcController ({ spawn, platform, getPath, generateConfig, log, emit, stopFileServer }) {
  let active = null
  let stopping = null
  let status = { running: false, state: 'stopped', source: '', pid: null, proxies: [] }
  const snapshot = () => ({ ...status, proxies: status.proxies.map(proxy => ({ ...proxy })) })
  const notify = () => emit('frpc-status', snapshot(), status.source)
  const proxyState = () => status.proxies.some(proxy => proxy.status === 'starting') ? 'starting' : status.proxies.every(proxy => proxy.status === 'running') ? 'running' : 'error'

  async function startFrpc (server, proxies, source = 'frp') {
    if (active || stopping) return { success: false, message: 'frpc 已在运行或停止中' }
    if (!Array.isArray(proxies) || !proxies.length) return { success: false, message: '请先添加代理规则' }
    const names = proxies.map(proxy => proxy.name?.trim())
    if (names.some(name => !name || [...name].some(char => char.charCodeAt(0) < 32)) || new Set(names).size !== names.length) return { success: false, message: '代理名称无效或重复' }
    let directory
    try {
      const executable = getPath()
      if (!fs.existsSync(executable)) return { success: false, message: 'frpc 未找到，请在设置中配置路径' }
      const content = generateConfig(server, proxies)
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-tunnel-'))
      const configPath = path.join(directory, 'frpc.toml')
      fs.writeFileSync(configPath, content, { encoding: 'utf8', mode: 0o600 })
      const child = spawn(executable, ['-c', configPath], { windowsHide: true })
      active = child
      status = { running: true, state: 'starting', pid: child.pid, source, serverAddr: server.serverAddr.trim(), serverPort: Number(server.serverPort), proxies: proxies.map(proxy => ({ ...proxy, name: proxy.name.trim(), status: 'starting', message: '' })) }
      let closed = false
      let spawned = false
      let settleStart
      const redact = text => server.token ? String(text).split(server.token).join('[已隐藏]') : String(text)
      const consume = (type, line) => {
        if (closed || active !== child) return
        // frpc 的 ANSI 颜色码不属于代理名称。
        // eslint-disable-next-line no-control-regex
        const text = line.replace(/\x1b\[[0-9;]*m/g, '').trim()
        if (!text) return
        log(type, redact(text), source)
        let registration
        for (const proxy of status.proxies) {
          const label = '[' + proxy.name + ']'
          let index = text.indexOf(label)
          while (index !== -1) {
            const event = text.slice(index + label.length).match(/^\s+(start proxy success\b|start error:\s*(.*))/i)
            if ((index === 0 || /\s/.test(text[index - 1])) && event) {
              if (!registration || index < registration.index) registration = { proxy, index, event }
              break
            }
            index = text.indexOf(label, index + 1)
          }
        }
        if (registration) {
          const { proxy, event } = registration
          proxy.status = event[2] === undefined ? 'running' : 'error'
          proxy.message = event[2] === undefined ? '' : redact(event[2])
        }
        if (status.state !== 'stopping') status.state = proxyState()
        notify()
      }
      const flushStdout = watchOutput(child.stdout, data => data.toString('utf8'), line => consume('stdout', line))
      const flushStderr = watchOutput(child.stderr, data => data.toString('utf8'), line => consume('stderr', line))
      const finish = (code, message) => {
        if (closed || active !== child) return
        flushStdout()
        flushStderr()
        closed = true
        const stopped = status.state === 'stopping'
        active = null
        status = { ...status, running: false, pid: null, state: stopped || code === 0 ? 'stopped' : 'error', proxies: status.proxies.map(proxy => ({ ...proxy, status: stopped || code === 0 ? 'stopped' : 'error', message: message || proxy.message })) }
        if (source === 'proxydir') stopFileServer('frp')
        notify()
        if (!stopped && code !== 0) emit('frpc-error', { message: message || 'frpc 已退出 (' + code + ')' }, source)
        emit('frpc-exit', { code }, source)
        log('system', 'frpc 已退出 (' + code + ')', source)
        if (!spawned) settleStart?.({ success: false, message: message || 'frpc 在启动前退出' })
        try { fs.unlinkSync(configPath); fs.rmdirSync(directory) } catch (e) {}
      }
      child.once('close', code => finish(code))
      notify()
      log('system', '正在启动 frpc，代理：' + names.join('、'), source)
      return await new Promise(resolve => {
        settleStart = resolve
        child.once('spawn', () => { if (closed) return; spawned = true; resolve({ success: true, pid: child.pid, source }) })
        child.on('error', err => {
          if (closed || active !== child) return
          const message = redact(err.message)
          if (!spawned) finish(-1, message)
          else { log('error', message, source); emit('frpc-error', { message }, source) }
        })
      })
    } catch (err) {
      if (directory) {
        try { fs.unlinkSync(path.join(directory, 'frpc.toml')); fs.rmdirSync(directory) } catch (e) {}
      }
      return { success: false, message: err.message }
    }
  }

  async function stopFrpc (source) {
    if (source && source !== status.source) return { success: false, message: '请在启动 frpc 的页面停止' }
    if (stopping) return stopping
    if (!active) return { success: false, message: 'frpc 未在运行' }
    const child = active
    status.state = 'stopping'
    notify()
    stopping = stopProcess(child, spawn, platform).then(result => {
      if (!result.success && active === child) { status.state = proxyState(); notify() }
      return result
    }).finally(() => { stopping = null })
    return stopping
  }

  return { startFrpc, stopFrpc, getFrpcStatus: snapshot }
}
