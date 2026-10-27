const { spawn, execFile } = require('child_process')
const http = require('http')
const url = require('url')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { getLocal, setLocal, removeLocal, putDocument } = require('./storage')(window.utools)
const { isPort, validateServer, validateProxies, generateFrpcConfig, createFrpcController } = require('./frp')

// UTF-8 优先，兼容 Windows 本地命令的 GBK 错误输出。
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
let gbkDecoder = null
try { gbkDecoder = new TextDecoder('gbk') } catch (e) {}

const DEFAULT_DEVTUNNEL_PATH = path.join(os.homedir(), 'devtunnel', 'devtunnel.exe')

// ==================== 旧版数据迁移 ====================

// 从云同步 db 迁移数据到本地存储（一次性）
function migrateIfNeeded () {
  // 迁移 devtunnel-config.path
  try {
    const doc = window.utools.db.get('devtunnel-config')
    if (doc && doc.path && !getLocal('devtunnel-path', '') && fs.existsSync(doc.path)) {
      setLocal('devtunnel-path', doc.path)
      delete doc.path
      window.utools.db.put(doc)
    }
  } catch (e) {}

  // 迁移 frp-config.frpcPath
  try {
    const doc = window.utools.db.get('frp-config')
    if (doc && doc.frpcPath && !getLocal('frpc-path', '') && fs.existsSync(doc.frpcPath)) {
      setLocal('frpc-path', doc.frpcPath)
      delete doc.frpcPath
      try { window.utools.db.put(doc) } catch (e2) {}
    }
  } catch (e) {}

  // 迁移日志
  try {
    const doc = window.utools.db.get('devtunnel-logs')
    if (doc && doc.logs) {
      setLocal('devtunnel-logs', doc.logs)
      window.utools.db.remove(doc)
    }
  } catch (e) {}
  try {
    const doc = window.utools.db.get('frpc-logs')
    if (doc && doc.logs) {
      setLocal('frpc-logs', doc.logs)
      window.utools.db.remove(doc)
    }
  } catch (e) {}

  // 迁移 tab 记忆
  for (const key of ['dashboard-tab', 'frp-tab']) {
    try {
      const doc = window.utools.db.get(key)
      if (doc && doc.tab) {
        setLocal(key, doc.tab)
        window.utools.db.remove(doc)
      }
    } catch (e) {}
  }

  // 迁移代理目录相关
  for (const key of ['proxydir-last-dir', 'proxydir-last-tunnel', 'proxydir-frp-settings']) {
    try {
      const doc = window.utools.db.get(key)
      if (doc) {
        const localDoc = { ...doc }
        delete localDoc._id
        delete localDoc._rev
        if (localDoc.dirPath && !fs.existsSync(localDoc.dirPath)) localDoc.dirPath = ''
        setLocal(key, localDoc)
        window.utools.db.remove(doc)
      }
    } catch (e) {}
  }
}

let hostProcess = null
let hostPid = null
let hostStopping = false
let logBuffer = []
let fileServer = null
let fileServerPort = null
let fileServerDir = null
let fileServerMode = null
let frpcLogBuffer = []
const frpcController = createFrpcController({
  getFrpcPath: () => window.services.getFrpcPath(),
  addFrpcLog,
  emitEvent: (name, detail, source) => {
    // 清理属于该隧道的文件服务，不依赖代理目录页面是否挂载。
    if (name === 'frpc-exit' && source === 'proxydir' && fileServerMode === 'frp') {
      window.services.stopFileServer('frp')
    }
    const event = new CustomEvent(name, { detail })
    event.source = source
    window.dispatchEvent(event)
  }
})

// ==================== 初始化 ====================

// 从本地存储加载历史日志（异步，不阻塞）
function loadLogs () {
  try {
    const logs = getLocal('devtunnel-logs', null)
    if (logs) logBuffer = logs
  } catch (e) {}
}

// 保存日志到本地存储（防抖）
let saveTimer = null
function saveLogs () {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try { setLocal('devtunnel-logs', logBuffer.slice(-200)) } catch (e) {}
  }, 1000)
}

// 从本地存储加载 frpc 历史日志
function loadFrpcLogs () {
  try {
    const logs = getLocal('frpc-logs', null)
    if (logs) frpcLogBuffer = logs
  } catch (e) {}
}

// 保存 frpc 日志到本地存储（防抖）
let saveFrpcTimer = null
function saveFrpcLogs () {
  clearTimeout(saveFrpcTimer)
  saveFrpcTimer = setTimeout(() => {
    try { setLocal('frpc-logs', frpcLogBuffer.slice(-200)) } catch (e) {}
  }, 1000)
}

// 每次读取同步配置，避免另一台设备的更新被内存缓存遮蔽
// path 从本地存储读取（本机特有），default* 从云同步 db 读取
function getConfig () {
  const localPath = getLocal('devtunnel-path', '')
  let defaults = { defaultPort: '80', defaultProtocol: 'auto', defaultAnonymous: true }
  try {
    const doc = window.utools.db.get('devtunnel-config')
    if (doc) {
      defaults = {
        defaultPort: doc.defaultPort || '80',
        defaultProtocol: doc.defaultProtocol || 'auto',
        defaultAnonymous: doc.defaultAnonymous !== false
      }
    }
  } catch (e) {}
  return {
    path: localPath || DEFAULT_DEVTUNNEL_PATH,
    ...defaults
  }
}

function getDevTunnelPath () {
  return getConfig().path
}

// ==================== 核心工具 ====================

function decodeOutput (buffer) {
  if (Buffer.isBuffer(buffer)) {
    try { return utf8Decoder.decode(buffer) } catch (e) {}
    if (gbkDecoder) {
      try { return gbkDecoder.decode(buffer) } catch (e) {}
    }
    return buffer.toString('utf-8')
  }
  return String(buffer || '')
}

// 按完整行解码，避免 UTF-8 / GBK 字符和 URL 被 stdout 数据块拆开。
function watchCommandOutput (stream, consume) {
  let pending = Buffer.alloc(0)
  const flush = () => {
    if (!pending.length) return
    const text = decodeOutput(pending).trim()
    pending = Buffer.alloc(0)
    if (text) consume(text)
  }
  stream.on('data', data => {
    pending = Buffer.concat([pending, Buffer.isBuffer(data) ? data : Buffer.from(data)])
    let newline
    while ((newline = pending.indexOf(10)) !== -1) {
      const text = decodeOutput(pending.subarray(0, newline)).trim()
      pending = pending.subarray(newline + 1)
      if (text) consume(text)
    }
  })
  stream.on('end', flush)
  return flush
}

function runCommand (args, timeout = 30000) {
  const devtunnelPath = getDevTunnelPath()
  return new Promise((resolve, reject) => {
    execFile(devtunnelPath, args, { encoding: 'buffer', timeout, windowsHide: true }, (error, stdout, stderr) => {
      const out = decodeOutput(stdout).trim()
      const err = decodeOutput(stderr).trim()
      if (error) reject(new Error(err || out || error.message))
      else resolve(out)
    })
  })
}

function addLog (type, text) {
  // frpc 日志不进入 devtunnel 日志缓冲
  if (text.startsWith('[frpc]') || text.startsWith('frpc ')) return
  const entry = { type, text, time: Date.now() }
  logBuffer.push(entry)
  if (logBuffer.length > 500) logBuffer.shift()
  window.dispatchEvent(new CustomEvent('tunnel-log-entry', { detail: entry }))
  saveLogs()
}

// frpc 专用日志（独立缓冲，不进入 devtunnel 缓冲）
function addFrpcLog (type, text, source) {
  const entry = { type, text, source, time: Date.now() }
  frpcLogBuffer.push(entry)
  if (frpcLogBuffer.length > 500) frpcLogBuffer.shift()
  window.dispatchEvent(new CustomEvent('frpc-log-entry', { detail: entry }))
  // 兼容：同时派发 frpc-log 事件（带 source），供 ProxyDir 过滤
  if (source) {
    const event = new CustomEvent('frpc-log', { detail: text })
    event.source = source
    window.dispatchEvent(event)
  }
  saveFrpcLogs()
}

/**
 * 从 devtunnel 输出中提取 JSON
 */
function extractJson (text) {
  try { return JSON.parse(text) } catch (e) {}
  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (arrayMatch) { try { return JSON.parse(arrayMatch[0]) } catch (e) {} }
  const objMatch = text.match(/\{[\s\S]*\}/)
  if (objMatch) { try { return JSON.parse(objMatch[0]) } catch (e) {} }
  throw new Error('无法解析 JSON: ' + text.substring(0, 200))
}

// ==================== 服务 ====================

window.services = {
  // ==================== 配置 ====================

  getConfig () { return getConfig() },

  saveConfig (config) {
    try {
      if (config.defaultPort !== undefined && !isPort(config.defaultPort)) throw new Error('默认端口必须是 1–65535 的整数')
      if (config.defaultProtocol !== undefined && !['auto', 'http', 'https'].includes(config.defaultProtocol)) throw new Error('默认协议无效')
      const defaults = {}
      for (const key of ['defaultPort', 'defaultProtocol', 'defaultAnonymous']) {
        if (config[key] !== undefined) defaults[key] = config[key]
      }
      if (Object.keys(defaults).length) putDocument('devtunnel-config', defaults)
      if (config.path !== undefined) setLocal('devtunnel-path', config.path.trim())
      return { success: true }
    } catch (e) {
      return { success: false, message: e.message }
    }
  },

  async validatePath (filePath) {
    try {
      if (!fs.existsSync(filePath)) return { valid: false, message: '文件不存在' }
      const result = await new Promise((resolve, reject) => {
        execFile(filePath, ['--version'], { encoding: 'buffer', timeout: 5000, windowsHide: true }, (err, stdout) => {
          if (err) reject(err)
          else resolve(decodeOutput(stdout).trim())
        })
      })
      return { valid: true, version: result }
    } catch (e) {
      return { valid: false, message: '无法执行: ' + e.message }
    }
  },

  // ==================== 登录 ====================

  async getLoginStatus () {
    try {
      const result = await runCommand(['limits'], 10000)
      const lines = result.split('\n').filter(l => l.trim())
      return { loggedIn: true, info: result, summary: lines[0] || '已登录' }
    } catch (e) {
      return { loggedIn: false, info: '', summary: '未登录' }
    }
  },

  login (provider) {
    const devtunnelPath = getDevTunnelPath()
    const args = ['login']
    if (provider === 'github') args.push('--github')

    addLog('system', '正在启动登录 (' + (provider || 'microsoft') + ')...')

    try {
      const child = spawn(devtunnelPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let browserOpened = false

      const processOutput = (text) => {
        addLog('stdout', text)

        // device code 模式
        const deviceMatch = text.match(/open the page (https:\/\/\S+).*enter the code (\S+)/i)
        if (deviceMatch && !browserOpened) {
          browserOpened = true
          const url = deviceMatch[1]
          const code = deviceMatch[2]
          addLog('system', '验证码: ' + code)
          try { window.utools.shellOpenExternal(url) } catch (e) {
            try { require('electron').shell.openExternal(url) } catch (e2) {}
          }
          window.dispatchEvent(new CustomEvent('tunnel-login-code', { detail: { url, code } }))
          return
        }

        // GitHub device 模式
        const githubMatch = text.match(/(https:\/\/github\.com\/login\/device\S*)/i)
        if (githubMatch && !browserOpened) {
          browserOpened = true
          try { window.utools.shellOpenExternal(githubMatch[1]) } catch (e) {
            try { require('electron').shell.openExternal(githubMatch[1]) } catch (e2) {}
          }
          return
        }

        if (text.includes('browser') || text.includes('Browser') || text.includes('Opened')) {
          browserOpened = true
        }
      }

      const flushStdout = watchCommandOutput(child.stdout, processOutput)

      const flushStderr = watchCommandOutput(child.stderr, text => {
        addLog('stderr', text)
        const deviceMatch = text.match(/open the page (https:\/\/\S+).*enter the code (\S+)/i)
        if (deviceMatch && !browserOpened) {
          browserOpened = true
          try { window.utools.shellOpenExternal(deviceMatch[1]) } catch (e) {}
          window.dispatchEvent(new CustomEvent('tunnel-login-code', { detail: { url: deviceMatch[1], code: deviceMatch[2] } }))
        }
      })

      child.on('close', (code) => {
        flushStdout()
        flushStderr()
        if (code === 0) {
          addLog('system', '登录成功')
          window.dispatchEvent(new CustomEvent('tunnel-login-done', { detail: { success: true } }))
        } else {
          addLog('error', '登录失败 (code: ' + code + ')')
          window.dispatchEvent(new CustomEvent('tunnel-login-done', { detail: { success: false } }))
        }
      })

      child.on('error', (err) => {
        addLog('error', '启动失败: ' + err.message)
        window.dispatchEvent(new CustomEvent('tunnel-login-done', { detail: { success: false, error: err.message } }))
      })

      return { success: true, message: '请在浏览器中完成登录' }
    } catch (e) {
      addLog('error', '启动失败: ' + e.message)
      return { success: false, message: e.message }
    }
  },

  async logout () {
    try {
      await runCommand(['logout'])
      addLog('system', '已登出')
      return { success: true }
    } catch (e) {
      return { success: false, message: e.message }
    }
  },

  // ==================== 隧道管理 ====================

  /**
   * 获取隧道列表（含端口详情，并发请求）
   */
  async listTunnels () {
    try {
      const result = await runCommand(['list', '-j'])
      addLog('stdout', result)
      const data = extractJson(result)
      const tunnels = Array.isArray(data) ? data : (data.tunnels || data.value || [])

      // 并发获取每个隧道的端口详情
      const detailed = await Promise.all(tunnels.map(async (t) => {
        try {
          const ports = await this.listPorts(t.tunnelId)
          return { ...t, ports: Array.isArray(ports) ? ports : [] }
        } catch (e) {
          return { ...t, ports: [] }
        }
      }))

      return detailed
    } catch (e) {
      return []
    }
  },

  async getTunnelWithPorts (tunnelId) {
    try {
      const detail = await this.showTunnel(tunnelId)
      const ports = await this.listPorts(tunnelId)
      // devtunnel show 可能返回 {tunnel: {...}} 或直接 {...}
      const tunnelData = detail.tunnel || detail
      return { ...tunnelData, ports: Array.isArray(ports) ? ports : [] }
    } catch (e) {
      addLog('error', '获取详情失败: ' + e.message)
      return null
    }
  },

  async createTunnel (options = {}) {
    if (options.port !== undefined && !isPort(options.port)) throw new Error('端口号必须是 1-65535 之间的整数')
    // 限制最多 2 个免费隧道
    const MAX_TUNNELS = 2
    try {
      const existing = await this.listTunnels()
      if (existing.length >= MAX_TUNNELS) {
        throw new Error('免费隧道数量已达上限（最多 ' + MAX_TUNNELS + ' 个），请先删除不需要的隧道')
      }
    } catch (e) {
      if (e.message.includes('上限')) throw e
    }

    const createArgs = ['create']
    if (options.tunnelId) createArgs.push(options.tunnelId)
    if (options.anonymous) createArgs.push('-a')
    if (options.expiration) createArgs.push('-e', options.expiration)
    if (options.description) createArgs.push('-d', options.description)
    if (options.labels) createArgs.push('-l', options.labels)
    createArgs.push('-j')

    addLog('system', 'devtunnel ' + createArgs.join(' '))
    const createResult = await runCommand(createArgs)
    addLog('stdout', createResult)
    const tunnel = extractJson(createResult)
    const tunnelId = tunnel.tunnelId || tunnel.tunnel_id || tunnel.id
    addLog('system', '隧道已创建: ' + tunnelId)

    if (options.port) {
      const portArgs = ['port', 'create', tunnelId, '-p', String(options.port)]
      if (options.protocol && options.protocol !== 'auto') portArgs.push('--protocol', options.protocol)
      portArgs.push('-j')
      addLog('system', 'devtunnel ' + portArgs.join(' '))
      try {
        const portResult = await runCommand(portArgs)
        addLog('stdout', portResult)
        addLog('system', '端口 ' + options.port + ' 已添加')
      } catch (e) {
        addLog('error', '添加端口失败: ' + e.message)
        throw new Error('隧道 ' + tunnelId + ' 已创建，但添加端口失败: ' + e.message)
      }
    }

    try {
      const full = await this.getTunnelWithPorts(tunnelId)
      if (full) return full
    } catch (e) {}
    return { ...tunnel, tunnelId, ports: options.port ? [{ portNumber: options.port, protocol: options.protocol || 'auto' }] : [] }
  },

  /**
   * 更新隧道（描述、匿名等）
   */
  async updateTunnel (tunnelId, options = {}) {
    const args = ['update', tunnelId]
    if (options.description !== undefined) args.push('-d', options.description)
    if (options.expiration) args.push('-e', options.expiration)
    args.push('-j')

    try {
      if (options.description !== undefined || options.expiration) {
        addLog('system', 'devtunnel ' + args.join(' '))
        const result = await runCommand(args)
        addLog('stdout', result)
      }
      if (options.anonymous !== undefined) {
        addLog('system', '正在' + (options.anonymous ? '启用' : '撤销') + '隧道匿名访问: ' + tunnelId)
        await require('./devtunnel-access')(runCommand, tunnelId, options.anonymous)
      }
      addLog('system', '隧道已更新: ' + tunnelId)
      return await this.getTunnelWithPorts(tunnelId)
    } catch (e) {
      addLog('error', '更新失败: ' + e.message)
      throw new Error('更新隧道失败: ' + e.message)
    }
  },

  async deleteTunnel (tunnelId) {
    try {
      addLog('system', '正在删除隧道: ' + tunnelId)
      const result = await runCommand(['delete', tunnelId])
      addLog('stdout', result)
      addLog('system', '隧道已删除: ' + tunnelId)
      return { success: true }
    } catch (e) {
      addLog('error', '删除失败: ' + e.message)
      return { success: false, message: e.message }
    }
  },

  async showTunnel (tunnelId) {
    try {
      const result = await runCommand(['show', tunnelId, '-j'])
      return extractJson(result)
    } catch (e) {
      throw new Error('获取隧道详情失败: ' + e.message)
    }
  },

  async listPorts (tunnelId) {
    try {
      const result = await runCommand(['port', 'list', tunnelId, '-j'])
      const data = extractJson(result)
      // devtunnel 返回格式可能是 {ports: [...]} 或 [...]
      if (Array.isArray(data)) return data
      if (data && Array.isArray(data.ports)) return data.ports
      if (data && data.portNumber) return [data] // 单个端口对象
      return []
    } catch (e) {
      return []
    }
  },

  async addPort (tunnelId, port, protocol) {
    try {
      if (!isPort(port)) throw new Error('端口号必须是 1-65535 之间的整数')
      const args = ['port', 'create', tunnelId, '-p', String(port)]
      if (protocol && protocol !== 'auto') args.push('--protocol', protocol)
      args.push('-j')
      addLog('system', 'devtunnel ' + args.join(' '))
      const result = await runCommand(args)
      addLog('stdout', result)
      addLog('system', '端口 ' + port + ' 已添加')
      return { success: true }
    } catch (e) {
      addLog('error', '添加端口失败: ' + e.message)
      throw new Error('添加端口失败: ' + e.message)
    }
  },

  async deletePort (tunnelId, port) {
    try {
      if (!isPort(port)) throw new Error('端口号必须是 1-65535 之间的整数')
      const args = ['port', 'delete', tunnelId, '-p', String(port), '-j']
      addLog('system', 'devtunnel ' + args.join(' '))
      const result = await runCommand(args)
      addLog('stdout', result)
      addLog('system', '端口 ' + port + ' 已删除')
      return { success: true }
    } catch (e) {
      addLog('error', '删除端口失败: ' + e.message)
      throw new Error('删除端口失败: ' + e.message)
    }
  },

  // ==================== 隧道运行 ====================

  tunnelUrlCache: {}, // 存储隧道URL

  async startHost (tunnelId, port, allowAnonymous) {
    if (hostProcess) return { success: false, message: '已有隧道在运行中，请先停止' }

    const args = ['host']
    if (tunnelId) args.push(tunnelId)
    // 省略该参数时沿用已保存的访问权限；仅显式选择匿名访问时追加 -a。
    if (allowAnonymous === true) args.push('-a')

    const devtunnelPath = getDevTunnelPath()
    const ownedFileServer = fileServerMode === 'devtunnel' && Number(fileServerPort) === Number(port) ? fileServer : null
    addLog('system', 'devtunnel ' + args.join(' '))

    try {
      const child = spawn(devtunnelPath, args, { windowsHide: true })
      hostProcess = child
      hostPid = child.pid
      hostStopping = false
      let spawned = false
      let closed = false
      let settleStart
      const finish = (code, message) => {
        if (closed) return
        flushStdout()
        flushStderr()
        closed = true
        if (hostProcess !== child) return
        hostProcess = null
        hostPid = null
        hostStopping = false
        delete this.tunnelUrlCache[tunnelId]
        if (window.__runningTunnelId === tunnelId) window.__runningTunnelId = null
        if (ownedFileServer && fileServer === ownedFileServer) this.stopFileServer('devtunnel')
        addLog('system', '进程退出 (code: ' + code + ')')
        window.dispatchEvent(new CustomEvent('tunnel-host-status', { detail: { ...this.getHostStatus(), tunnelId } }))
        window.dispatchEvent(new CustomEvent('tunnel-exit', { detail: code }))
        if (!spawned) settleStart?.({ success: false, message: message || '隧道进程在启动前退出 (' + code + ')' })
      }

      const flushStdout = watchCommandOutput(child.stdout, text => {
        if (closed || hostProcess !== child) return
        if (text) {
          addLog('stdout', text)
          window.dispatchEvent(new CustomEvent('tunnel-log', { detail: text }))
          const urlMatches = text.match(/https:\/\/\S+\.devtunnels\.ms/g)
          if (urlMatches && urlMatches.length > 0) {
            const url = urlMatches.length > 1 ? urlMatches[1] : urlMatches[0]
            this.tunnelUrlCache[tunnelId] = url
            window.dispatchEvent(new CustomEvent('tunnel-url', { detail: { tunnelId, url } }))
          }
        }
      })

      const flushStderr = watchCommandOutput(child.stderr, text => {
        if (closed || hostProcess !== child) return
        if (text) {
          addLog('stderr', text)
          window.dispatchEvent(new CustomEvent('tunnel-error', { detail: text }))
        }
      })

      child.once('close', code => finish(code))
      return await new Promise(resolve => {
        settleStart = resolve
        child.once('spawn', () => {
          if (closed || hostProcess !== child) return
          spawned = true
          window.__runningTunnelId = tunnelId
          window.dispatchEvent(new CustomEvent('tunnel-host-status', { detail: { ...this.getHostStatus(), tunnelId } }))
          resolve({ success: true, pid: child.pid })
        })
        child.on('error', err => {
          if (closed || hostProcess !== child) return
          addLog('error', '进程错误: ' + err.message)
          window.dispatchEvent(new CustomEvent('tunnel-error', { detail: err.message }))
          if (!spawned) finish(-1, err.message)
          resolve({ success: false, message: err.message })
        })
      })
    } catch (e) {
      if (ownedFileServer && fileServer === ownedFileServer) this.stopFileServer('devtunnel')
      return { success: false, message: e.message }
    }
  },

  async stopHost () {
    if (!hostProcess) return { success: false, message: '没有运行中的隧道' }
    if (hostStopping) return { success: false, message: '正在停止，请稍候' }
    const child = hostProcess
    hostStopping = true
    addLog('system', '正在停止...')
    return await new Promise(resolve => {
      let settled = false
      const complete = result => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.removeListener('close', onClose)
        child.removeListener('error', onError)
        if (hostProcess === child) hostStopping = false
        resolve(result)
      }
      const onClose = () => complete({ success: true })
      const onError = err => complete({ success: false, message: err.message })
      const timer = setTimeout(() => complete({ success: false, message: '停止超时，请重试' }), 5000)
      child.once('close', onClose)
      child.once('error', onError)
      try {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
          killer.once('error', onError)
          killer.once('close', code => {
            if (code && hostProcess === child) complete({ success: false, message: '停止失败 (' + code + ')' })
          })
        } else if (!child.kill()) {
          complete({ success: false, message: '无法发送停止信号，请重试' })
        }
      } catch (err) { complete({ success: false, message: err.message }) }
    })
  },

  getHostStatus () {
    return { running: hostProcess !== null, pid: hostPid, stopping: hostStopping }
  },

  getTunnelUrl (tunnelId) {
    return this.tunnelUrlCache[tunnelId] || ''
  },

  // ==================== 日志 ====================

  getLogBuffer () { return logBuffer },
  clearLogs () {
    logBuffer = []
    removeLocal('devtunnel-logs')
  },

  getFrpcLogBuffer () { return frpcLogBuffer },
  clearFrpcLogs () {
    frpcLogBuffer = []
    removeLocal('frpc-logs')
  },

  // 写入 frpc 日志缓冲（通用）
  addFrpcLog (type, text, source) {
    addFrpcLog(type, text, source)
  },

  // 代理目录专用：根据模式写入对应的日志缓冲
  addProxyDirLog (type, text, mode) {
    if (mode === 'frp') {
      addFrpcLog(type, text, 'proxydir')
    } else {
      addLog(type, text)
    }
  },

  // ==================== 代理目录本地存储 ====================

  getProxyDirSettings () {
    return getLocal('proxydir-last-dir', null)
  },

  saveProxyDirSettings (settings) {
    setLocal('proxydir-last-dir', settings)
  },

  getProxyDirFrpSettings () {
    return getLocal('proxydir-frp-settings', null)
  },

  saveProxyDirFrpSettings (settings) {
    setLocal('proxydir-frp-settings', settings)
  },

  getProxyDirLastTunnel () {
    return getLocal('proxydir-last-tunnel', null)
  },

  saveProxyDirLastTunnel (data) {
    setLocal('proxydir-last-tunnel', data)
  },

  // ==================== Tab 记忆本地存储 ====================

  getTabMemory (key) {
    return getLocal(key, null)
  },

  saveTabMemory (key, tab) {
    setLocal(key, tab)
  },

  // ==================== 清除所有数据 ====================

  clearAllData () {
    // 清除本地存储
    const localKeys = [
      'devtunnel-path', 'frpc-path',
      'devtunnel-logs', 'frpc-logs',
      'dashboard-tab', 'frp-tab',
      'proxydir-last-dir', 'proxydir-last-tunnel', 'proxydir-frp-settings'
    ]
    for (const key of localKeys) removeLocal(key)
    // 清除云同步 db
    const cloudKeys = ['devtunnel-config', 'frp-config', 'devtunnel-logs', 'frpc-logs', 'proxydir-last-dir', 'proxydir-last-tunnel', 'proxydir-frp-settings', 'dashboard-tab', 'frp-tab']
    for (const key of cloudKeys) {
      try {
        const doc = window.utools.db.get(key)
        if (doc) window.utools.db.remove(doc)
      } catch (e) {}
    }
    logBuffer = []
    frpcLogBuffer = []
  },

  // ==================== 工具 ====================

  async getLimits () {
    try { return await runCommand(['limits']) }
    catch (e) { return '获取限制信息失败: ' + e.message }
  },

  async getClusters () {
    try { return extractJson(await runCommand(['clusters', '-j'])) }
    catch (e) { return [] }
  },

  selectFile () {
    const files = window.utools.showOpenDialog({
      title: '选择 devtunnel.exe',
      filters: [{ name: '可执行文件', extensions: ['exe'] }],
      properties: ['openFile']
    })
    return files ? files[0] : null
  },

  // ==================== 目录代理 ====================

  selectDirectory () {
    const dirs = window.utools.showOpenDialog({
      title: '选择要代理的目录',
      properties: ['openDirectory']
    })
    return dirs ? dirs[0] : null
  },

  startFileServer (dirPath, port = 3000, mode = 'devtunnel') {
    if (!isPort(port)) return Promise.resolve({ success: false, message: '端口号必须是 1-65535 之间的整数' })
    if (fileServer) return Promise.resolve({ success: false, message: '文件服务器已在运行中' })
    if (!fs.existsSync(dirPath)) return Promise.resolve({ success: false, message: '目录不存在' })

    const MIME_TYPES = {
      '.html': 'text/html; charset=utf-8',
      '.htm': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.xml': 'application/xml; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8',
      '.md': 'text/plain; charset=utf-8',
      '.csv': 'text/plain; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.webp': 'image/webp',
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.gz': 'application/gzip',
      '.tar': 'application/x-tar',
      '.wasm': 'application/wasm'
    }

    function getMimeType (filePath) {
      const ext = path.extname(filePath).toLowerCase()
      return MIME_TYPES[ext] || 'application/octet-stream'
    }

    function getFileSize (size) {
      if (size < 1024) return size + ' B'
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
      if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB'
      return (size / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
    }

    const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
    const isWithinRoot = (root, target) => {
      const relative = path.relative(root, target)
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
    }

    function renderDirPage (dirUrl, entries, parentPath) {
      const items = entries.map(e => {
        const icon = e.isDirectory
          ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="#6C8EBF"><path d="M1.5 2h4.3l1.2 2H14.5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 16 16" fill="#999"><path d="M4 1h5.5L12 3.5V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm1 4h5v1H5V5zm0 3h5v1H5V8zm0 3h3v1H5v-1z"/></svg>'
        const name = e.name + (e.isDirectory ? '/' : '')
        const href = dirUrl + encodeURIComponent(e.name) + (e.isDirectory ? '/' : '')
        const size = e.isDirectory ? '-' : getFileSize(e.size)
        const mtime = e.mtime ? new Date(e.mtime).toLocaleString('zh-CN') : '-'
        return `<tr><td>${icon}</td><td><a href="${escapeHtml(href)}">${escapeHtml(name)}</a></td><td>${size}</td><td>${mtime}</td></tr>`
      }).join('\n')

      const parentIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="#6C8EBF"><path d="M1.5 2h4.3l1.2 2H14.5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/></svg>'
      const parentRow = parentPath
        ? `<tr><td>${parentIcon}</td><td><a href="${escapeHtml(parentPath)}">..</a></td><td>-</td><td>-</td></tr>`
        : ''

      return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>📂 ${escapeHtml(decodeURIComponent(dirUrl))}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; color: #1a1a1a; padding: 24px; }
  .header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #e8ecf0; }
  .header h1 { font-size: 18px; font-weight: 600; color: #1a1a1a; }
  .header .path { font-size: 13px; color: #8a8a8a; font-family: 'Cascadia Code', 'Fira Code', monospace; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.04); }
  th { background: #f1f3f5; text-align: left; padding: 10px 16px; font-size: 12px; font-weight: 600; color: #8a8a8a; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 10px 16px; border-top: 1px solid #f1f3f5; font-size: 13px; }
  td:first-child { width: 32px; text-align: center; }
  td:nth-child(3), td:nth-child(4) { color: #8a8a8a; font-size: 12px; }
  a { color: #10B981; text-decoration: none; font-weight: 500; }
  a:hover { text-decoration: underline; }
  tr:hover { background: #f8f9fa; }
  .footer { margin-top: 16px; text-align: center; font-size: 11px; color: #b0b0b0; }
</style>
</head>
<body>
  <div class="header">
    <h1>📂 目录浏览</h1>
    <span class="path">${escapeHtml(decodeURIComponent(dirUrl))}</span>
  </div>
  <table>
    <thead><tr><th></th><th>名称</th><th>大小</th><th>修改时间</th></tr></thead>
    <tbody>
      ${parentRow}
      ${items}
    </tbody>
  </table>
  <div class="footer">由 devtunnel 内网穿透插件提供</div>
</body>
</html>`
    }

    return new Promise((resolve) => {
      try {
        const rootDir = fs.realpathSync(dirPath)
        if (!fs.statSync(rootDir).isDirectory()) throw new Error('请选择有效目录')

        const server = http.createServer((req, res) => {
          try {
            const parsedUrl = url.parse(req.url)
            const reqPath = decodeURIComponent(parsedUrl.pathname)

            // 安全检查：防止目录遍历
            const requestedPath = path.resolve(path.join(rootDir, reqPath))
            if (!isWithinRoot(rootDir, requestedPath)) {
              res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('403 禁止访问')
              return
            }

            if (!fs.existsSync(requestedPath)) {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('404 文件不存在')
              return
            }

            // Windows junction 和符号链接也必须指向分享根目录内。
            const fullPath = fs.realpathSync(requestedPath)
            if (!isWithinRoot(rootDir, fullPath)) {
              res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('403 禁止访问')
              return
            }
            const stat = fs.statSync(fullPath)

            if (stat.isDirectory()) {
              let entries = fs.readdirSync(fullPath, { withFileTypes: true })
              entries.sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
                return a.name.localeCompare(b.name)
              })
              entries = entries.map(e => {
                try {
                  const entryPath = fs.realpathSync(path.join(fullPath, e.name))
                  if (!isWithinRoot(rootDir, entryPath)) return null
                  const s = fs.statSync(entryPath)
                  return { name: e.name, isDirectory: s.isDirectory(), size: s.size, mtime: s.mtimeMs }
                } catch (err) {
                  return null
                }
              }).filter(Boolean)

              const relativeUrl = path.relative(rootDir, requestedPath).split(path.sep).map(encodeURIComponent).join('/')
              const dirUrl = '/' + relativeUrl + (relativeUrl ? '/' : '')
              const parentPath = dirUrl !== '/' ? url.resolve(dirUrl, '..') : null
              const html = renderDirPage(dirUrl, entries, parentPath)
              res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
                'X-Content-Type-Options': 'nosniff'
              })
              res.end(html)
            } else {
              const mime = getMimeType(fullPath)
              res.writeHead(200, {
                'Content-Type': mime,
                'Content-Length': stat.size,
                'Content-Disposition': 'inline'
              })
              const stream = fs.createReadStream(fullPath)
              stream.on('error', () => res.destroy())
              res.on('close', () => stream.destroy())
              stream.pipe(res)
            }
          } catch (err) {
            res.writeHead(err instanceof URIError ? 400 : 500, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end(err instanceof URIError ? '400 无效请求路径' : '500 无法读取文件')
          }
        })

        fileServer = server
        fileServerMode = mode
        server.on('error', (err) => {
          if (mode === 'frp') addFrpcLog('error', '文件服务器错误: ' + err.message, 'proxydir')
          else addLog('error', '文件服务器错误: ' + err.message)
          if (fileServer === server) {
            fileServer = null
            fileServerPort = null
            fileServerDir = null
            fileServerMode = null
          }
          resolve({ success: false, message: '端口 ' + port + ' 启动失败: ' + err.message })
        })

        server.listen(port, '127.0.0.1', () => {
          fileServerPort = port
          fileServerDir = rootDir
          if (mode === 'frp') addFrpcLog('system', '文件服务器已启动: http://127.0.0.1:' + port + ' -> ' + rootDir, 'proxydir')
          else addLog('system', '文件服务器已启动: http://127.0.0.1:' + port + ' -> ' + rootDir)
          window.dispatchEvent(new CustomEvent('fileserver-started', { detail: { port, dir: rootDir } }))
          resolve({ success: true, port })
        })
      } catch (e) {
        fileServer = null
        fileServerPort = null
        fileServerDir = null
        fileServerMode = null
        resolve({ success: false, message: e.message })
      }
    })
  },

  stopFileServer (mode = 'devtunnel') {
    if (!fileServer) return { success: false, message: '文件服务器未在运行' }
    if (fileServerMode !== mode) return { success: false, message: '请在启动文件服务器的模式下停止' }
    try {
      fileServer.close()
      fileServer.closeAllConnections?.()
      if (mode === 'frp') addFrpcLog('system', '文件服务器已停止', 'proxydir')
      else addLog('system', '文件服务器已停止')
      fileServer = null
      fileServerPort = null
      fileServerDir = null
      fileServerMode = null
      return { success: true }
    } catch (e) {
      return { success: false, message: e.message }
    }
  },

  getFileServerStatus () {
    return { running: fileServer !== null, port: fileServerPort, dir: fileServerDir, mode: fileServerMode }
  },

  // ==================== Frp 管理 ====================

  async getFrpConfig () {
    try {
      const doc = window.utools.db.get('frp-config')
      return doc ? { server: doc.server || {}, proxies: doc.proxies || [] } : null
    } catch (e) {
      return null
    }
  },

  async saveFrpConfig (config) {
    try {
      putDocument('frp-config', existing => {
        const fields = {}
        const server = { serverAddr: '', serverPort: '7000', token: '', ...existing?.server, ...config.server }
        const error = validateServer(server, false) || (config.proxies !== undefined && validateProxies(config.proxies, server))
        if (error) throw new Error(error)
        if (config.server) fields.server = { ...server, serverAddr: server.serverAddr.trim(), serverPort: String(server.serverPort) }
        if (config.proxies !== undefined) fields.proxies = config.proxies
        return fields
      })
      return { success: true }
    } catch (e) {
      return { success: false, message: e.message }
    }
  },

  validateFrpProxies (proxies, server) { return validateProxies(proxies, server) },

  getFrpcPath () {
    // 从本地存储读取（本机特有）
    const localPath = getLocal('frpc-path', '')
    if (localPath) return localPath
    // 自动检测：根据平台优先检查对应后缀
    const dir = path.dirname(getDevTunnelPath())
    const isWin = process.platform === 'win32'
    const candidates = isWin
      ? [path.join(dir, 'frpc.exe'), path.join(dir, 'frpc')]
      : [path.join(dir, 'frpc'), path.join(dir, 'frpc.exe')]
    for (const p of candidates) {
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
      } catch (e) {}
    }
    // 都没找到则返回 exe 版本（Windows 提示更友好）
    return candidates[0]
  },

  selectFrpcFile () {
    const files = window.utools.showOpenDialog({
      title: '选择 frpc 可执行文件',
      filters: [{ name: '可执行文件', extensions: ['exe'] }],
      properties: ['openFile']
    })
    return files ? files[0] : null
  },

  async validateFrpcPath (filePath) {
    try {
      if (!fs.existsSync(filePath)) return { valid: false, message: '文件不存在' }
      const result = await new Promise((resolve, reject) => {
        execFile(filePath, ['--version'], { encoding: 'buffer', timeout: 5000, windowsHide: true }, (err, stdout) => {
          if (err) reject(err)
          else resolve(decodeOutput(stdout).trim())
        })
      })
      return { valid: true, version: result }
    } catch (e) {
      return { valid: false, message: '无法执行: ' + e.message }
    }
  },

  saveFrpcPath (frpcPath) {
    try {
      setLocal('frpc-path', frpcPath)
      return { success: true }
    } catch (e) {
      return { success: false, message: e.message }
    }
  },

  generateFrpcConfig,
  ...frpcController,

  async testFrpConnection (serverAddr, serverPort) {
    const error = validateServer({ serverAddr, serverPort })
    if (error) return { success: false, message: error }
    // 简单的 TCP 连通性测试
    const net = require('net')
    return new Promise((resolve) => {
      const socket = new net.Socket()
      socket.setTimeout(5000)
      socket.on('connect', () => {
        socket.destroy()
        resolve({ success: true })
      })
      socket.on('timeout', () => {
        socket.destroy()
        resolve({ success: false, message: '连接超时' })
      })
      socket.on('error', (err) => {
        socket.destroy()
        resolve({ success: false, message: err.message })
      })
      socket.connect(serverPort || 7000, serverAddr)
    })
  }
}

// 启动时执行数据迁移，然后加载日志
migrateIfNeeded()
loadLogs()
loadFrpcLogs()
