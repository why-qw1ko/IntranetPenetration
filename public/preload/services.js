const { spawn, execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { getLocal, setLocal, removeLocal } = require('./storage')(window.utools)
const { validateServer, validateProxies, generateFrpcConfig } = require('./frp')
const { watchOutput } = require('./process-utils')
const { normalizeTunnelId, normalizeTunnel, extractTunnelIdFromText, parseTunnelsFromText, parseTunnelDetailFromText, parsePortsFromText, parseTunnelList, parsePortList, pickConnectUrl } = require('./devtunnel-parser')
const fileController = require('./file-server')({
  log: (type, text, mode) => mode === 'frp' ? addFrpcLog(type, text, 'proxydir') : addLog(type, text),
  onStarted: detail => window.dispatchEvent(new CustomEvent('fileserver-started', { detail }))
})
const devtunnelController = require('./devtunnel')({
  spawn,
  platform: process.platform,
  getPath: getDevTunnelPath,
  decodeOutput,
  pickConnectUrl,
  formatCommand,
  log: addLog,
  fileController,
  emit: (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail })),
  onRunningTunnel: id => { window.__runningTunnelId = id }
})
const frpcController = require('./frpc')({
  spawn,
  platform: process.platform,
  getPath: () => window.services.getFrpcPath(),
  generateConfig: (...args) => window.services.generateFrpcConfig(...args),
  log: addFrpcLog,
  emit: dispatchFrpcEvent,
  stopFileServer: mode => window.services.stopFileServer(mode)
})

// TextDecoder 替代 iconv-lite，无需第三方依赖
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
let gbkDecoder = null
try { gbkDecoder = new TextDecoder('gbk') } catch (e) {}

const DEFAULT_DEVTUNNEL_PATH = path.join(os.homedir(), 'devtunnel', 'devtunnel.exe')

// dbStorage 也会同步，本机设置由 storage 按设备 ID 隔离。

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

  // Token 改用设备隔离键，不再写入共享服务器文档；dbStorage 仍参与同步。
  try {
    const doc = window.utools.db.get('frp-config')
    if (doc?.server?.token) {
      if (!getLocal('frp-token', '')) setLocal('frp-token', doc.server.token)
      delete doc.server.token
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

let logBuffer = []
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

// 每次读取云同步配置，避免其他设备更新后仍使用旧默认值
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
    // CLI 正常输出为 UTF-8；仅对 Windows 本地编码错误回退 GBK。
    try { return utf8Decoder.decode(buffer) } catch (e) {}
    if (gbkDecoder) {
      try { return gbkDecoder.decode(buffer) } catch (e) {}
    }
    return buffer.toString('utf-8')
  }
  return String(buffer || '')
}

function formatCommand (bin, args) {
  return [bin, ...args].map(arg => {
    const text = String(arg)
    return /\s|"/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
  }).join(' ')
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
    window.dispatchEvent(new CustomEvent('frpc-log', { detail: { text, source } }))
  }
  saveFrpcLogs()
}

function dispatchFrpcEvent (name, detail, source) {
  window.dispatchEvent(new CustomEvent(name, { detail: { ...detail, source } }))
}

function toPortNumber (value, fallback) {
  const input = value === undefined || value === '' ? fallback : value
  const num = Number(input)
  if (!/^[0-9]+$/.test(String(input)) || !Number.isInteger(num) || num < 1 || num > 65535) throw new Error('端口号必须是 1-65535 之间的整数')
  return num
}

async function setAnonymousAccess (tunnelId, allow) {
  const id = normalizeTunnelId(tunnelId)
  if (!id) throw new Error('缺少有效的隧道 ID')
  await require('./devtunnel-access')(runCommand, parsePortsFromText, id, allow)
}

// ==================== 服务 ====================

window.services = {
  // ==================== 配置 ====================

  getConfig () { return getConfig() },

  saveConfig (config) {
    try {
      const fields = ['path', 'defaultPort', 'defaultProtocol', 'defaultAnonymous']
      if (!config || Object.keys(config).some(key => !fields.includes(key))) throw new Error('不支持的配置字段')
      if (config.path !== undefined && typeof config.path !== 'string') throw new Error('路径必须是字符串')
      if (config.defaultPort !== undefined) toPortNumber(config.defaultPort)
      if (config.defaultProtocol !== undefined && !['auto', 'http', 'https'].includes(config.defaultProtocol)) throw new Error('默认协议无效')
      if (config.defaultAnonymous !== undefined && typeof config.defaultAnonymous !== 'boolean') throw new Error('匿名访问设置必须是布尔值')
      const patch = Object.fromEntries(fields.slice(1).filter(key => config[key] !== undefined).map(key => [key, config[key]]))
      if (Object.keys(patch).length) {
        const existing = window.utools.db.get('devtunnel-config')
        const result = window.utools.db.put({ ...existing, ...patch, _id: 'devtunnel-config' })
        if (result?.ok !== true) throw new Error(result?.message || '保存配置失败')
      }
      // 云端写入失败时不提前更改本机路径；仅改路径不触碰云端默认值。
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

      const flushStdout = watchOutput(child.stdout, decodeOutput, processOutput)

      const flushStderr = watchOutput(child.stderr, decodeOutput, text => {
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
      const result = await runCommand(['list'])
      addLog('stdout', result)
      const tunnels = parseTunnelList(result)

      // 任一详情读取失败时终止本轮查询，不能将失败解释成无端口。
      const detailed = await Promise.all(tunnels.map(async (t) => {
        const ports = await this.listPorts(t.tunnelId)
        return { ...normalizeTunnel(t), ports }
      }))

      return detailed
    } catch (e) {
      addLog('error', '获取隧道列表失败: ' + e.message)
      throw e
    }
  },

  async getTunnelWithPorts (tunnelId) {
    try {
      const detail = await this.showTunnel(tunnelId)
      const ports = await this.listPorts(tunnelId)
      return normalizeTunnel({ ...detail, ports })
    } catch (e) {
      addLog('error', '获取详情失败: ' + e.message)
      return null
    }
  },

  async createTunnel (options = {}) {
    if (options.port !== undefined) toPortNumber(options.port)
    // 限制最多 2 个免费隧道
    const MAX_TUNNELS = 2
    const existing = await this.listTunnels()
    if (existing.length >= MAX_TUNNELS) {
      throw new Error('免费隧道数量已达上限（最多 ' + MAX_TUNNELS + ' 个），请先删除不需要的隧道')
    }

    const createArgs = ['create']
    if (options.tunnelId) createArgs.push(options.tunnelId)
    if (options.anonymous) createArgs.push('-a')
    if (options.expiration) createArgs.push('-e', options.expiration)
    if (options.description) createArgs.push('-d', options.description)
    if (options.labels) createArgs.push('-l', options.labels)

    addLog('system', formatCommand('devtunnel', createArgs))
    const createResult = await runCommand(createArgs)
    addLog('stdout', createResult)
    let tunnel = normalizeTunnel(parseTunnelsFromText(createResult)[0] || {})
    let tunnelId = tunnel.tunnelId || extractTunnelIdFromText(createResult)
    if (!tunnelId) {
      tunnel = await this.showTunnel()
      tunnelId = tunnel?.tunnelId
    }
    if (!tunnelId) throw new Error('隧道已创建，但未能从 devtunnel 输出中识别隧道 ID，请刷新列表确认')
    addLog('system', '隧道已创建: ' + tunnelId)

    if (options.port) {
      const portArgs = ['port', 'create', tunnelId, '-p', String(options.port)]
      if (options.protocol && options.protocol !== 'auto') portArgs.push('--protocol', options.protocol)
      addLog('system', formatCommand('devtunnel', portArgs))
      try {
        const portResult = await runCommand(portArgs)
        addLog('stdout', portResult)
        addLog('system', '端口 ' + options.port + ' 已添加')
      } catch (e) {
        addLog('error', '添加端口失败: ' + e.message)
        throw new Error('隧道已创建（ID: ' + tunnelId + '），但端口添加失败: ' + e.message)
      }
    }

    const detail = await this.getTunnelWithPorts(tunnelId)
    return detail || { ...tunnel, tunnelId, ports: options.port ? [{ portNumber: Number(options.port), protocol: options.protocol || 'auto' }] : [] }
  },

  /**
   * 更新隧道（描述、匿名等）
   */
  async updateTunnel (tunnelId, options = {}) {
    const id = normalizeTunnelId(tunnelId)
    if (!id) throw new Error('缺少有效的隧道 ID')
    const args = ['update', id]
    if (options.description !== undefined) args.push('-d', options.description)
    if (options.expiration) args.push('-e', options.expiration)

    try {
      if (args.length > 2) {
        addLog('system', formatCommand('devtunnel', args))
        const result = await runCommand(args)
        addLog('stdout', result)
      }
      if (options.anonymous !== undefined) {
        await setAnonymousAccess(id, Boolean(options.anonymous))
      }
      addLog('system', '隧道已更新: ' + id)
      return await this.getTunnelWithPorts(id)
    } catch (e) {
      addLog('error', '更新失败: ' + e.message)
      throw new Error('更新隧道失败: ' + e.message)
    }
  },

  async deleteTunnel (tunnelId) {
    try {
      const id = normalizeTunnelId(tunnelId)
      if (!id) throw new Error('缺少有效的隧道 ID')
      if (this.getHostStatus().running && this.getHostStatus().tunnelId === id) {
        const stopped = await this.stopHost()
        if (!stopped.success) throw new Error(stopped.message)
      }
      addLog('system', '正在删除隧道: ' + id)
      const result = await runCommand(['delete', id, '--force'])
      addLog('stdout', result)
      delete this.tunnelUrlCache[id]
      addLog('system', '隧道已删除: ' + id)
      return { success: true }
    } catch (e) {
      addLog('error', '删除失败: ' + e.message)
      return { success: false, message: e.message }
    }
  },

  async showTunnel (tunnelId) {
    try {
      const id = tunnelId ? normalizeTunnelId(tunnelId) : ''
      if (tunnelId && !id) throw new Error('缺少有效的隧道 ID')
      const args = id ? ['show', id] : ['show']
      const result = await runCommand(args)
      addLog('stdout', result)
      return parseTunnelDetailFromText(result, id)
    } catch (e) {
      throw new Error('获取隧道详情失败: ' + e.message)
    }
  },

  async listPorts (tunnelId) {
    try {
      const id = normalizeTunnelId(tunnelId)
      if (!id) throw new Error('缺少有效的隧道 ID')
      const args = ['port', 'list', id]
      const result = await runCommand(args)
      return parsePortList(result)
    } catch (e) {
      addLog('error', '获取端口列表失败: ' + e.message)
      throw e
    }
  },

  async addPort (tunnelId, port, protocol) {
    try {
      toPortNumber(port)
      const id = normalizeTunnelId(tunnelId)
      if (!id) throw new Error('缺少有效的隧道 ID')
      const args = ['port', 'create', id, '-p', String(port)]
      if (protocol && protocol !== 'auto') args.push('--protocol', protocol)
      addLog('system', formatCommand('devtunnel', args))
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
      toPortNumber(port)
      const id = normalizeTunnelId(tunnelId)
      if (!id) throw new Error('缺少有效的隧道 ID')
      const args = ['port', 'delete', id, '-p', String(port)]
      addLog('system', formatCommand('devtunnel', args))
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

  ...devtunnelController,

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
    const failures = []
    // 清除本地存储
    const localKeys = [
      'devtunnel-path', 'frpc-path',
      'frp-token',
      'devtunnel-logs', 'frpc-logs',
      'dashboard-tab', 'frp-tab',
      'proxydir-last-dir', 'proxydir-last-tunnel', 'proxydir-frp-settings'
    ]
    for (const key of localKeys) {
      try { removeLocal(key) } catch (error) { failures.push(key + ': ' + error.message) }
    }
    // 清除云同步 db
    const cloudKeys = ['devtunnel-config', 'frp-config', 'devtunnel-logs', 'frpc-logs', 'proxydir-last-dir', 'proxydir-last-tunnel', 'proxydir-frp-settings', 'dashboard-tab', 'frp-tab']
    for (const key of cloudKeys) {
      try {
        const doc = window.utools.db.get(key)
        if (doc) {
          const result = window.utools.db.remove(doc)
          if (!result?.ok) throw new Error(result?.message || '删除未成功')
        }
      } catch (error) { failures.push(key + ': ' + error.message) }
    }
    logBuffer = []
    frpcLogBuffer = []
    clearTimeout(saveTimer)
    clearTimeout(saveFrpcTimer)
    return failures.length ? { success: false, message: '部分数据未清除，请重试：' + failures.join('；'), failures } : { success: true }
  },

  // ==================== 工具 ====================

  async getLimits () {
    try { return await runCommand(['limits']) } catch (e) { return '获取限制信息失败: ' + e.message }
  },

  async getClusters () {
    try { return await runCommand(['clusters']) } catch (e) { return [] }
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

  ...fileController,

  // ==================== Frp 管理 ====================

  async getFrpConfig () {
    try {
      const doc = window.utools.db.get('frp-config')
      if (!doc) return null
      return {
        revision: doc._rev || null,
        server: { serverAddr: '', serverPort: '7000', ...(doc.server || {}), token: getLocal('frp-token', '') },
        proxies: doc.proxies || []
      }
    } catch (e) {
      throw new Error('读取 FRP 配置失败: ' + e.message)
    }
  },

  async saveFrpConfig (config) {
    try {
      if (config.server !== undefined) {
        const fields = ['serverAddr', 'serverPort', 'token']
        if (!config.server || Object.keys(config.server).some(key => !fields.includes(key))) throw new Error('不支持的服务器配置字段')
        if (config.server.serverPort !== undefined) toPortNumber(config.server.serverPort)
        if (config.server.serverAddr !== undefined && (typeof config.server.serverAddr !== 'string' || !config.server.serverAddr.trim() || /[\s/\\]/.test(config.server.serverAddr))) throw new Error('请输入有效的服务器 IP 或域名，不含协议和路径')
        if (config.server.token !== undefined && typeof config.server.token !== 'string') throw new Error('Token 必须是字符串')
      }
      const existing = window.utools.db.get('frp-config') || {}
      if (Object.prototype.hasOwnProperty.call(config, 'expectedRevision') && config.expectedRevision !== (existing._rev || null)) throw new Error('FRP 配置已被同步更新，请重新进入页面后再保存')
      const server = { serverAddr: '', serverPort: '7000', ...existing.server, ...config.server }
      const proxies = config.proxies !== undefined ? config.proxies : (existing.proxies || [])
      const error = validateServer(server, false) || validateProxies(proxies, server)
      if (error) throw new Error(error)
      const hasToken = Object.prototype.hasOwnProperty.call(config.server || {}, 'token')
      const token = config.server?.token
      delete server.token
      const doc = { ...existing, _id: 'frp-config', server, proxies }
      const result = window.utools.db.put(doc)
      if (!result?.ok) throw new Error(result?.message || '保存 FRP 配置失败')
      if (hasToken) {
        if (token) setLocal('frp-token', token)
        else removeLocal('frp-token')
      }
      return { success: true, revision: result.rev || existing._rev || null, proxies: doc.proxies }
    } catch (err) {
      return { success: false, message: err.message }
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
