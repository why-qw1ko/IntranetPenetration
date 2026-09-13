const { spawn, exec } = require('child_process')
const http = require('http')
const url = require('url')
const path = require('path')
const fs = require('fs')
const os = require('os')

// TextDecoder 替代 iconv-lite，无需第三方依赖
let gbkDecoder = null
try { gbkDecoder = new TextDecoder('gbk') } catch (e) {}

const DEFAULT_DEVTUNNEL_PATH = path.join(os.homedir(), 'devtunnel', 'devtunnel.exe')

// ==================== 本地存储辅助（不同步到云端） ====================

function getLocal (key, defaultValue) {
  try {
    const val = window.utools.dbStorage.getItem(key)
    return val !== null && val !== undefined ? val : defaultValue
  } catch (e) { return defaultValue }
}

function setLocal (key, value) {
  try { window.utools.dbStorage.setItem(key, value) } catch (e) {}
}

function removeLocal (key) {
  try { window.utools.dbStorage.removeItem(key) } catch (e) {}
}

// 从云同步 db 迁移数据到本地存储（一次性）
function migrateIfNeeded () {
  // 迁移 devtunnel-config.path
  try {
    const doc = window.utools.db.get('devtunnel-config')
    if (doc && doc.path) {
      setLocal('devtunnel-path', doc.path)
      delete doc.path
      window.utools.db.put(doc)
    }
  } catch (e) {}

  // 迁移 frp-config.frpcPath
  try {
    const doc = window.utools.db.get('frp-config')
    if (doc && doc.frpcPath) {
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
        setLocal(key, localDoc)
        window.utools.db.remove(doc)
      }
    } catch (e) {}
  }
}

let hostProcess = null
let hostPid = null
let logBuffer = []
let configCache = null
let fileServer = null
let fileServerPort = null
let fileServerDir = null
let frpcProcess = null
let frpcPid = null
let frpcSource = '' // 记录是谁启动的 frpc ('frp' | 'proxydir')
let frpcStopping = false // 标记是否是主动停止
let frpcLogBuffer = []

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

// 获取配置（带缓存）
// path 从本地存储读取（本机特有），default* 从云同步 db 读取
function getConfig () {
  if (configCache) return configCache
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
  configCache = {
    path: localPath || DEFAULT_DEVTUNNEL_PATH,
    ...defaults
  }
  return configCache
}

function getDevTunnelPath () {
  return getConfig().path
}

// ==================== 核心工具 ====================

function decodeOutput (buffer) {
  if (Buffer.isBuffer(buffer)) {
    // Windows 中文系统默认 GBK，优先用 GBK 解码，否则 UTF-8
    if (gbkDecoder) {
      try { return gbkDecoder.decode(buffer) } catch (e) {}
    }
    return buffer.toString('utf-8')
  }
  return String(buffer || '')
}

function runCommand (args, timeout = 30000) {
  const devtunnelPath = getDevTunnelPath()
  return new Promise((resolve, reject) => {
    const cmd = `"${devtunnelPath}" ${args.join(' ')}`
    exec(cmd, { encoding: 'buffer', timeout }, (error, stdout, stderr) => {
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
  const entry = { type, text, time: Date.now() }
  frpcLogBuffer.push(entry)
  if (frpcLogBuffer.length > 500) frpcLogBuffer.shift()
  window.dispatchEvent(new CustomEvent('frpc-log-entry', { detail: entry }))
  // 兼容：同时派发 frpc-log 事件（带 source），供 ProxyDir 过滤
  if (source) {
    window.dispatchEvent(new CustomEvent('frpc-log', { detail: text, source }))
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
      configCache = null // 清除缓存
      // path 保存到本地存储（本机特有）
      if (config.path !== undefined) {
        setLocal('devtunnel-path', config.path)
      }
      // default* 保存到云同步 db（可跨设备）
      const cloudDoc = { _id: 'devtunnel-config' }
      try {
        const existing = window.utools.db.get('devtunnel-config')
        cloudDoc._rev = existing._rev
      } catch (e) {}
      cloudDoc.defaultPort = config.defaultPort
      cloudDoc.defaultProtocol = config.defaultProtocol
      cloudDoc.defaultAnonymous = config.defaultAnonymous
      window.utools.db.put(cloudDoc)
      return { success: true }
    } catch (e) {
      return { success: false, message: e.message }
    }
  },

  async validatePath (filePath) {
    try {
      if (!fs.existsSync(filePath)) return { valid: false, message: '文件不存在' }
      const result = await new Promise((resolve, reject) => {
        exec(`"${filePath}" --version`, { encoding: 'buffer', timeout: 5000 }, (err, stdout) => {
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

      child.stdout.on('data', (data) => {
        const text = decodeOutput(data).trim()
        if (text) text.split('\n').forEach(line => processOutput(line.trim()))
      })

      child.stderr.on('data', (data) => {
        const text = decodeOutput(data).trim()
        if (text) {
          addLog('stderr', text)
          const deviceMatch = text.match(/open the page (https:\/\/\S+).*enter the code (\S+)/i)
          if (deviceMatch && !browserOpened) {
            browserOpened = true
            try { window.utools.shellOpenExternal(deviceMatch[1]) } catch (e) {}
            window.dispatchEvent(new CustomEvent('tunnel-login-code', { detail: { url: deviceMatch[1], code: deviceMatch[2] } }))
          }
        }
      })

      child.on('close', (code) => {
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

      // 从日志中提取运行中隧道的URL
      if (hostProcess && window.__runningTunnelId) {
        const logs = logBuffer.slice(-50)
        for (let i = logs.length - 1; i >= 0; i--) {
          const text = logs[i].text
          const urlMatches = text.match(/https:\/\/\S+\.devtunnels\.ms/g)
          if (urlMatches && urlMatches.length > 0) {
            this.tunnelUrlCache[window.__runningTunnelId] = urlMatches.length > 1 ? urlMatches[1] : urlMatches[0]
            break
          }
        }
      }

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
    if (options.description) createArgs.push('-d', `"${options.description}"`)
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
      }
    }

    try {
      return await this.getTunnelWithPorts(tunnelId)
    } catch (e) {
      return { ...tunnel, tunnelId, ports: options.port ? [{ portNumber: options.port, protocol: options.protocol || 'auto' }] : [] }
    }
  },

  /**
   * 更新隧道（描述、匿名等）
   */
  async updateTunnel (tunnelId, options = {}) {
    const args = ['update', tunnelId]
    if (options.description !== undefined) args.push('-d', `"${options.description}"`)
    if (options.anonymous !== undefined) args.push(options.anonymous ? '--allow-anonymous' : '--deny-anonymous')
    if (options.expiration) args.push('-e', options.expiration)
    args.push('-j')

    addLog('system', 'devtunnel ' + args.join(' '))
    try {
      const result = await runCommand(args)
      addLog('stdout', result)
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

  startHost (tunnelId, port, allowAnonymous) {
    if (hostProcess) return { success: false, message: '已有隧道在运行中，请先停止' }

    const args = ['host']
    if (tunnelId) args.push(tunnelId)
    if (allowAnonymous) args.push('-a')

    const devtunnelPath = getDevTunnelPath()
    addLog('system', 'devtunnel ' + args.join(' '))

    try {
      hostProcess = spawn(devtunnelPath, args, { windowsHide: true })
      hostPid = hostProcess.pid

      hostProcess.stdout.on('data', (data) => {
        const text = decodeOutput(data).trim()
        if (text) {
          addLog('stdout', text)
          window.dispatchEvent(new CustomEvent('tunnel-log', { detail: text }))
          // 提取URL（格式：https://xxx-xxx.devtunnels.ms）
          const urlMatches = text.match(/https:\/\/\S+\.devtunnels\.ms/g)
          if (urlMatches && urlMatches.length > 0) {
            // 优先使用不带端口的URL（第二个）
            const url = urlMatches.length > 1 ? urlMatches[1] : urlMatches[0]
            this.tunnelUrlCache[tunnelId] = url
            window.dispatchEvent(new CustomEvent('tunnel-url', { detail: { tunnelId, url } }))
          }
        }
      })

      hostProcess.stderr.on('data', (data) => {
        const text = decodeOutput(data).trim()
        if (text) {
          addLog('stderr', text)
          window.dispatchEvent(new CustomEvent('tunnel-error', { detail: text }))
        }
      })

      hostProcess.on('close', (code) => {
        addLog('system', '进程退出 (code: ' + code + ')')
        window.dispatchEvent(new CustomEvent('tunnel-exit', { detail: code }))
        hostProcess = null
        hostPid = null
      })

      hostProcess.on('error', (err) => {
        addLog('error', '启动失败: ' + err.message)
        window.dispatchEvent(new CustomEvent('tunnel-error', { detail: err.message }))
        hostProcess = null
        hostPid = null
      })

      return { success: true, pid: hostPid }
    } catch (e) {
      hostProcess = null
      hostPid = null
      return { success: false, message: e.message }
    }
  },

  stopHost () {
    if (!hostProcess) return { success: false, message: '没有运行中的隧道' }
    try {
      spawn('taskkill', ['/pid', String(hostPid), '/T', '/F'], { windowsHide: true })
      addLog('system', '正在停止...')
      // 清除运行中隧道的URL缓存
      if (window.__runningTunnelId) {
        delete this.tunnelUrlCache[window.__runningTunnelId]
      }
      hostProcess = null
      hostPid = null
      return { success: true }
    } catch (e) {
      return { success: false, message: e.message }
    }
  },

  getHostStatus () {
    return { running: hostProcess !== null, pid: hostPid }
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
    configCache = null
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

  startFileServer (dirPath, port = 3000, mode) {
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

    function renderDirPage (dirUrl, entries, parentPath) {
      const items = entries.map(e => {
        const icon = e.isDirectory
          ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="#6C8EBF"><path d="M1.5 2h4.3l1.2 2H14.5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 16 16" fill="#999"><path d="M4 1h5.5L12 3.5V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm1 4h5v1H5V5zm0 3h5v1H5V8zm0 3h3v1H5v-1z"/></svg>'
        const name = e.name + (e.isDirectory ? '/' : '')
        const href = dirUrl + encodeURIComponent(e.name) + (e.isDirectory ? '/' : '')
        const size = e.isDirectory ? '-' : getFileSize(e.size)
        const mtime = e.mtime ? new Date(e.mtime).toLocaleString('zh-CN') : '-'
        return `<tr><td>${icon}</td><td><a href="${href}">${name}</a></td><td>${size}</td><td>${mtime}</td></tr>`
      }).join('\n')

      const parentIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="#6C8EBF"><path d="M1.5 2h4.3l1.2 2H14.5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/></svg>'
      const parentRow = parentPath
        ? `<tr><td>${parentIcon}</td><td><a href="${parentPath}">..</a></td><td>-</td><td>-</td></tr>`
        : ''

      return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>📂 ${dirUrl}</title>
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
    <span class="path">${dirUrl}</span>
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
        const rootDir = path.resolve(dirPath)

        fileServer = http.createServer((req, res) => {
          try {
            const parsedUrl = url.parse(req.url)
            let reqPath = decodeURIComponent(parsedUrl.pathname)

            // 安全检查：防止目录遍历
            const fullPath = path.resolve(path.join(rootDir, reqPath))
            if (!fullPath.startsWith(rootDir)) {
              res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('403 禁止访问')
              return
            }

            if (!fs.existsSync(fullPath)) {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('404 文件不存在')
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
                  const s = fs.statSync(path.join(fullPath, e.name))
                  return { ...e, size: s.size, mtime: s.mtimeMs }
                } catch (err) {
                  return { ...e, size: 0, mtime: 0 }
                }
              })

              const dirUrl = reqPath.endsWith('/') ? reqPath : reqPath + '/'
              const parentPath = dirUrl !== '/' ? url.resolve(dirUrl, '..') : null
              const html = renderDirPage(dirUrl, entries, parentPath)
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              res.end(html)
            } else {
              const mime = getMimeType(fullPath)
              res.writeHead(200, {
                'Content-Type': mime,
                'Content-Length': stat.size,
                'Content-Disposition': 'inline'
              })
              fs.createReadStream(fullPath).pipe(res)
            }
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('500 服务器错误: ' + err.message)
          }
        })

        fileServer.on('error', (err) => {
          if (mode === 'frp') addFrpcLog('error', '文件服务器错误: ' + err.message, 'proxydir')
          else addLog('error', '文件服务器错误: ' + err.message)
          fileServer = null
          fileServerPort = null
          fileServerDir = null
          resolve({ success: false, message: '端口 ' + port + ' 启动失败: ' + err.message })
        })

        fileServer.listen(port, '127.0.0.1', () => {
          fileServerPort = port
          fileServerDir = rootDir
          if (mode === 'frp') addFrpcLog('system', '文件服务器已启动: http://127.0.0.1:' + port + ' -> ' + rootDir, 'proxydir')
          else addLog('system', '文件服务器已启动: http://127.0.0.1:' + port + ' -> ' + rootDir)
          window.dispatchEvent(new CustomEvent('fileserver-started', { detail: { port, dir: rootDir } }))
          resolve({ success: true, port })
        })
      } catch (e) {
        fileServer = null
        resolve({ success: false, message: e.message })
      }
    })
  },

  stopFileServer (mode) {
    if (!fileServer) return { success: false, message: '文件服务器未在运行' }
    try {
      fileServer.close()
      if (mode === 'frp') addFrpcLog('system', '文件服务器已停止', 'proxydir')
      else addLog('system', '文件服务器已停止')
      fileServer = null
      fileServerPort = null
      fileServerDir = null
      return { success: true }
    } catch (e) {
      return { success: false, message: e.message }
    }
  },

  getFileServerStatus () {
    return { running: fileServer !== null, port: fileServerPort, dir: fileServerDir }
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
      const doc = { _id: 'frp-config', server: config.server, proxies: config.proxies }
      try {
        const existing = window.utools.db.get('frp-config')
        if (existing) doc._rev = existing._rev
      } catch (e) {}
      window.utools.db.put(doc)
      return { success: true }
    } catch (e) {
      return { success: false, message: e.message }
    }
  },

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
        exec(`"${filePath}" --version`, { encoding: 'buffer', timeout: 5000 }, (err, stdout) => {
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

  generateFrpcConfig (serverConfig, proxies) {
    let toml = `serverAddr = "${serverConfig.serverAddr}"\n`
    toml += `serverPort = ${serverConfig.serverPort || 7000}\n`
    if (serverConfig.token) toml += `auth.token = "${serverConfig.token}"\n`
    toml += `\n`

    for (const p of proxies) {
      toml += `[[proxies]]\n`
      toml += `name = "${p.name}"\n`
      toml += `type = "${p.type}"\n`
      toml += `localPort = ${p.localPort}\n`
      if (p.type === 'tcp' && p.remotePort) toml += `remotePort = ${p.remotePort}\n`
      if (p.type === 'http' && p.customDomain) toml += `customDomains = ["${p.customDomain}"]\n`
      toml += `\n`
    }
    return toml
  },

  startFrpc (serverConfig, proxies, source) {
    if (frpcProcess) return { success: false, message: 'frpc 已在运行中' }
    frpcSource = source || 'frp'

    const frpcPath = this.getFrpcPath()
    if (!fs.existsSync(frpcPath)) {
      return { success: false, message: 'frpc 未找到: ' + frpcPath + '\n请在「设置」页面配置 frpc 路径' }
    }

    // 生成临时配置文件
    const configContent = this.generateFrpcConfig(serverConfig, proxies)
    const configPath = path.join(require('os').tmpdir(), 'frpc-tunnel-plugin.toml')
    try {
      fs.writeFileSync(configPath, configContent, 'utf-8')
    } catch (e) {
      return { success: false, message: '写入配置文件失败: ' + e.message }
    }

    addFrpcLog('system', '配置文件: ' + configPath)
    addFrpcLog('system', '配置内容:\n' + configContent)

    const args = ['-c', configPath]
    addFrpcLog('system', '启动命令: frpc ' + args.join(' '))

    addFrpcLog('system', '可执行文件: ' + frpcPath)

    try {
      frpcProcess = spawn(frpcPath, args, { windowsHide: true })
      frpcPid = frpcProcess.pid
      const startTime = Date.now()
      let stderrBuf = ''
      let errorFired = false

      frpcProcess.stdout.on('data', (data) => {
        const text = data.toString().trim()
        if (text) addFrpcLog('stdout', text, frpcSource)
      })

      frpcProcess.stderr.on('data', (data) => {
        const text = data.toString().trim()
        if (text) {
          stderrBuf += text + '\n'
          addFrpcLog('stderr', text, frpcSource)
        }
      })

      frpcProcess.on('close', (code) => {
        const errMsg = stderrBuf.trim()

        // 主动停止时不显示错误
        if (code !== 0 && !errorFired && !frpcStopping) {
          const detail = errMsg || ('frpc 退出码: ' + code)
          addFrpcLog('error', detail, frpcSource)
          window.dispatchEvent(new CustomEvent('frpc-error', { detail, source: frpcSource }))
        }

        frpcStopping = false // 重置标志
        addFrpcLog('system', 'frpc 进程退出 (code: ' + code + ')', frpcSource)
        window.dispatchEvent(new CustomEvent('frpc-exit', { detail: code, source: frpcSource }))
        frpcProcess = null
        frpcPid = null
        try { fs.unlinkSync(configPath) } catch (e) {}
      })

      frpcProcess.on('error', (err) => {
        errorFired = true
        addFrpcLog('error', err.message, frpcSource)
        window.dispatchEvent(new CustomEvent('frpc-error', { detail: err.message, source: frpcSource }))
        window.dispatchEvent(new CustomEvent('frpc-exit', { detail: -1, source: frpcSource }))
        frpcProcess = null
        frpcPid = null
        try { fs.unlinkSync(configPath) } catch (e) {}
      })

      return { success: true, pid: frpcPid }
    } catch (e) {
      frpcProcess = null
      frpcPid = null
      return { success: false, message: e.message }
    }
  },

  stopFrpc () {
    if (!frpcProcess) return { success: false, message: 'frpc 未在运行' }
    try {
      frpcStopping = true // 标记主动停止
      spawn('taskkill', ['/pid', String(frpcPid), '/T', '/F'], { windowsHide: true })
      addFrpcLog('system', '正在停止 frpc...')
      frpcProcess = null
      frpcPid = null
      return { success: true }
    } catch (e) {
      frpcStopping = false
      return { success: false, message: e.message }
    }
  },

  getFrpcStatus () {
    return { running: frpcProcess !== null, pid: frpcPid }
  },

  async testFrpConnection (serverAddr, serverPort, token) {
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
