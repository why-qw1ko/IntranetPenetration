const { spawn, execFile } = require('child_process')
const http = require('http')
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

  // 迁移 frp token 到本地存储，避免随 uTools db 云同步
  try {
    const doc = window.utools.db.get('frp-config')
    if (doc?.server?.token) {
      setLocal('frp-token', doc.server.token)
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

function escapeHtml (value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isPathInside (rootPath, targetPath) {
  const relativePath = path.relative(rootPath, targetPath)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function tomlString (value) {
  return JSON.stringify(String(value || ''))
}

function toPortNumber (value, fallback) {
  const num = Number(value || fallback)
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new Error('端口号必须是 1-65535 之间的整数')
  }
  return num
}

function hasAnonymousConnectAccess (text) {
  return /\+Anonymous\s*\[[^\]]*\bconnect\b[^\]]*\]/i.test(String(text || ''))
}

function maskFrpcConfig (content) {
  return content.replace(/auth\.token\s*=\s*".*"/g, 'auth.token = "******"')
}

function extractDevTunnelUrls (text) {
  const input = String(text || '')
  const matches = input.match(/https:\/\/[^\s<>"')\]]+?\.devtunnels\.ms\/?/gi) || []
  return matches.map(url => url.replace(/[),.;]+$/g, '')).filter(Boolean)
}

function pickConnectUrl (text, port) {
  const urls = extractDevTunnelUrls(text).filter(url => !/-inspect(?:\.|\/|$)/i.test(url))
  if (!urls.length) return ''
  const portText = port ? String(port) : ''
  if (portText) {
    const exact = urls.find(url => (
      url.includes(`-${portText}.devtunnels.ms`) ||
      url.includes(`-${portText}.`) ||
      url.includes(`:${portText}/`) ||
      url.endsWith(`:${portText}`)
    ))
    if (exact) return exact
  }
  return urls[0]
}

/**
 * 从 devtunnel 输出中提取 JSON。新版 CLI 不再公开 -j 参数；此函数只作为兼容旧输出的兜底。
 */
function extractJson (text) {
  const input = String(text || '').trim()
  try { return JSON.parse(input) } catch (e) {}
  if (!/^\s*(?:\[|\{)/.test(input)) throw new Error('无法解析 JSON: ' + input.substring(0, 200))
  const arrayMatch = input.match(/^\s*(\[[\s\S]*\])\s*$/)
  if (arrayMatch) { try { return JSON.parse(arrayMatch[1]) } catch (e) {} }
  const objMatch = input.match(/^\s*(\{[\s\S]*\})\s*$/)
  if (objMatch) { try { return JSON.parse(objMatch[1]) } catch (e) {} }
  throw new Error('无法解析 JSON: ' + input.substring(0, 200))
}

const TUNNEL_ID_RE = /^[a-z0-9][a-z0-9-]{2,}(?:\.[a-z0-9][a-z0-9-]*)?$/i
const RESERVED_TUNNEL_WORDS = new Set([
  'tunnel', 'tunnels', 'created', 'updated', 'deleted', 'delete', 'show',
  'port', 'ports', 'hosting', 'host', 'https', 'http', 'cluster', 'status',
  'description', 'expires', 'expiration', 'none', 'true', 'false',
  'welcome', 'report', 'issues', 'github', 'devtunnels', 'microsoft'
])

function cleanCliValue (value) {
  return String(value || '')
    .trim()
    .replace(/^[`'"]+|[`'",;]+$/g, '')
    .replace(/\/+$/g, '')
}

function normalizeTunnelId (value) {
  const id = cleanCliValue(value)
  if (!TUNNEL_ID_RE.test(id) || RESERVED_TUNNEL_WORDS.has(id.toLowerCase())) return ''
  return id
}

function isCliNoiseLine (line) {
  return /^(welcome\s+to\s+dev\s+tunnels!?|report\s+issues\s+on\s+github|https?:\/\/aka\.ms\/devtunnels)/i.test(String(line || '').trim())
}

function isTunnelListHeaderLine (line) {
  const text = String(line || '').trim()
  return /^[-=]+$/.test(text) || /^(?:tunnel\s+id|id|隧道\s*id)(?:\s|$)/i.test(text)
}

function extractTunnelIdFromText (text) {
  const input = String(text || '')
  const urlMatch = input.match(/https:\/\/([a-z0-9-]+?)(?:-\d+)?(?:\.([a-z0-9-]+))?\.devtunnels\.ms/i)
  if (urlMatch) return normalizeTunnelId(urlMatch[2] ? `${urlMatch[1]}.${urlMatch[2]}` : urlMatch[1])

  const idPattern = '([a-z0-9][a-z0-9-]{2,}(?:\\.[a-z0-9][a-z0-9-]*)?)'
  const labeledMatch = input.match(new RegExp('(?:^|\\n)\\s*(?:tunnel\\s*id|tunnelid|隧道\\s*id)\\s*[:=：]\\s*' + idPattern, 'i'))
  if (labeledMatch) return normalizeTunnelId(labeledMatch[1])

  const createdMatch = input.match(new RegExp('(?:created|updated|deleted|hosting|set\\s+default\\s+tunnel\\s+to)\\D{0,80}(?:tunnel\\D+)?' + idPattern + '(?=\\s|$|,|\\.)', 'i'))
  if (createdMatch) return normalizeTunnelId(createdMatch[1])

  return normalizeTunnelId(input)
}

function getObjectArray (data) {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return []
  if (Array.isArray(data.tunnels)) return data.tunnels
  if (Array.isArray(data.value)) return data.value
  if (Array.isArray(data.items)) return data.items
  if (data.tunnel && typeof data.tunnel === 'object') return [data.tunnel]
  if (data.tunnelId || data.tunnel_id || data.id || data.name) return [data]
  return []
}

function splitCliColumns (line) {
  return String(line || '')
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/\s{2,}|\t+|\s*\|\s*/)
    .map(part => part.trim())
    .filter(Boolean)
}

function isExpirationText (value) {
  const text = cleanCliValue(value).toLowerCase()
  return /^(?:\d+\s*(?:days?|day|d|hours?|hour|h|minutes?|minute|m)|expired|never|none|session)$/.test(text)
}

function tunnelFromListColumns (columns) {
  const tunnelId = normalizeTunnelId(columns[0])
  if (!tunnelId) return null
  const rest = columns.slice(1)
  let description = ''
  let expiration = ''
  if (rest.length === 1) {
    if (isExpirationText(rest[0])) expiration = cleanCliValue(rest[0])
    else description = cleanCliValue(rest[0])
  } else if (rest.length > 1) {
    const last = rest[rest.length - 1]
    const previous = rest[rest.length - 2]
    if (isExpirationText(previous)) {
      expiration = cleanCliValue(previous)
      description = cleanCliValue(last)
    } else if (isExpirationText(last)) {
      expiration = cleanCliValue(last)
    } else {
      description = cleanCliValue(last)
    }
  }
  return { tunnelId, description, expiration, ports: [] }
}

function parseKeyValueLines (text) {
  const values = {}
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    const match = line.match(/^([^:=：]{1,40})\s*[:=：]\s*(.*)$/)
    if (!match) continue
    const key = match[1].trim().toLowerCase().replace(/\s+/g, '')
    values[key] = cleanCliValue(match[2])
  }
  return values
}

function parseTunnelDetailBlock (text) {
  const values = parseKeyValueLines(text)
  const tunnelId = normalizeTunnelId(values.tunnelid || values['隧道id'])
  if (!tunnelId) return null
  const access = values.accesscontrol || values.access || values['访问控制'] || values['访问'] || ''
  return normalizeTunnel({
    tunnelId,
    description: values.description || values.desc || values['描述'] || '',
    labels: values.labels || values['标签'] || '',
    access,
    anonymous: hasAnonymousConnectAccess(access),
    expiration: values.tunnelexpiration || values.expiration || values.expires || values['过期时间'] || '',
    ports: parsePortsFromText(text)
  })
}

function parseTunnelDetailBlocks (text) {
  const blocks = []
  let current = []
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (/^\s*(?:tunnel\s*id|隧道\s*id)\s*[:=：]/i.test(line)) {
      if (current.length) blocks.push(current.join('\n'))
      current = [line]
      continue
    }
    if (current.length) current.push(line)
  }
  if (current.length) blocks.push(current.join('\n'))
  return blocks.map(parseTunnelDetailBlock).filter(Boolean)
}

function parseTunnelsFromText (text) {
  const input = String(text || '')
  try {
    const data = extractJson(input)
    const tunnels = getObjectArray(data)
    return tunnels.map(normalizeTunnel).filter(t => t.tunnelId)
  } catch (e) {}

  const detailBlocks = parseTunnelDetailBlocks(input)
  if (detailBlocks.length) return detailBlocks

  const seen = new Set()
  const tunnels = []
  const addTunnel = (id, description = '') => {
    const tunnelId = normalizeTunnelId(id)
    if (!tunnelId || seen.has(tunnelId)) return
    seen.add(tunnelId)
    tunnels.push({ tunnelId, description: cleanCliValue(description), ports: [] })
  }

  const urlRegex = /https:\/\/([a-z0-9-]+?)(?:-\d+)?(?:\.([a-z0-9-]+))?\.devtunnels\.ms/gi
  let match
  while ((match = urlRegex.exec(input))) addTunnel(match[2] ? `${match[1]}.${match[2]}` : match[1])

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || isCliNoiseLine(line) || isTunnelListHeaderLine(line)) continue
    const columns = splitCliColumns(line)
    const tableTunnel = columns.length > 1 && !line.includes(':') ? tunnelFromListColumns(columns) : null
    if (tableTunnel) {
      addTunnel(tableTunnel.tunnelId, tableTunnel.description)
      const current = tunnels[tunnels.length - 1]
      if (current) current.expiration = tableTunnel.expiration
      continue
    }
    const id = columns.length <= 1 ? extractTunnelIdFromText(line) : ''
    if (id) {
      const description = line.replace(id, '').trim().replace(/^[:|\s-]+/, '')
      addTunnel(id, description)
    }
  }

  return tunnels
}

function normalizeTunnel (tunnel) {
  if (!tunnel) return { tunnelId: '', ports: [] }
  const tunnelId = normalizeTunnelId(tunnel.tunnelId || tunnel.tunnel_id || tunnel.id || extractTunnelIdFromText(tunnel.name || ''))
  const ports = Array.isArray(tunnel.ports) ? tunnel.ports.map(normalizePort).filter(Boolean) : []
  return {
    ...tunnel,
    tunnelId,
    description: tunnel.description || tunnel.desc || tunnel.descriptionText || '',
    ports
  }
}

function parsePortsFromText (text) {
  const input = String(text || '')
  try {
    const data = extractJson(input)
    if (Array.isArray(data)) return data.map(normalizePort).filter(Boolean)
    if (data && Array.isArray(data.ports)) return data.ports.map(normalizePort).filter(Boolean)
    if (data && (data.portNumber || data.port)) return [normalizePort(data)].filter(Boolean)
  } catch (e) {}

  const ports = []
  const seen = new Set()
  const addPort = (portNumber, protocol = 'auto') => {
    const num = Number(portNumber)
    if (!Number.isInteger(num) || num < 1 || num > 65535 || seen.has(num)) return
    seen.add(num)
    ports.push({ portNumber: num, protocol: protocol || 'auto' })
  }

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || /^[-=]+$/.test(line) || /^---/i.test(line)) continue
    const protocolMatch = line.match(/\b(http|https|auto)\b/i)
    const labeledMatch = line.match(/^(?:port|portnumber|port\s*number|端口|端口号)\s*[:=：]\s*(\d{1,5})\b/i)
    const portsMatch = line.match(/^(?:ports|端口列表)\s*[:=：]\s*(.+)$/i)
    const rowMatch = line.replace(/^\|/, '').trim().match(/^(\d{1,5})(?=\s|$|,|\||\)|\()/)

    if (labeledMatch) {
      addPort(labeledMatch[1], protocolMatch ? protocolMatch[1].toLowerCase() : 'auto')
      continue
    }
    if (portsMatch) {
      const value = portsMatch[1].trim()
      if (/^\d+$/.test(value)) continue
      const numbers = value.match(/\b\d{1,5}\b/g) || []
      numbers.forEach(num => addPort(num, protocolMatch ? protocolMatch[1].toLowerCase() : 'auto'))
      continue
    }
    if (!rowMatch) continue
    addPort(rowMatch[1], protocolMatch ? protocolMatch[1].toLowerCase() : 'auto')
  }

  const urlRegex = /https:\/\/[a-z0-9-]+-(\d+)(?:\.[a-z0-9-]+)?\.devtunnels\.ms/gi
  let match
  while ((match = urlRegex.exec(input))) addPort(match[1], 'http')

  return ports
}

function normalizePort (port) {
  const portNumber = Number(port.portNumber || port.port || port.number)
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return null
  return { ...port, portNumber, protocol: port.protocol || 'auto' }
}

function parseTunnelDetailFromText (text, fallbackTunnelId = '') {
  const parsed = normalizeTunnel(parseTunnelsFromText(text)[0] || {})
  const values = parseKeyValueLines(text)
  const tunnelId = normalizeTunnelId(
    values.tunnelid ||
    values.id ||
    values['隧道id'] ||
    fallbackTunnelId ||
    parsed.tunnelId ||
    extractTunnelIdFromText(text)
  )
  const description = values.description || values.desc || values['描述'] || parsed.description || ''
  const ports = parsePortsFromText(text)
  const access = values.accesscontrol || values.access || values['访问控制'] || values['访问'] || parsed.access
  return normalizeTunnel({
    ...parsed,
    tunnelId,
    description,
    cluster: values.cluster || values['群集'] || parsed.cluster,
    access,
    anonymous: hasAnonymousConnectAccess(access),
    expiration: values.expiration || values.expires || values.tunnelexpiration || values['过期时间'] || parsed.expiration,
    ports: ports.length ? ports : parsed.ports
  })
}

async function setAnonymousAccess (tunnelId, allow) {
  const id = normalizeTunnelId(tunnelId)
  if (!id) throw new Error('缺少有效的隧道 ID')
  const listArgs = ['access', 'list', id]
  addLog('system', formatCommand('devtunnel', listArgs))
  const listResult = await runCommand(listArgs)
  if (listResult) addLog('stdout', listResult)

  if (allow) {
    if (hasAnonymousConnectAccess(listResult)) return
    const args = ['access', 'create', id, '--anonymous', '--scopes', 'connect']
    addLog('system', formatCommand('devtunnel', args))
    const result = await runCommand(args)
    if (result) addLog('stdout', result)
    return
  }

  const anonymousIndexes = []
  for (const line of String(listResult || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+):\s*\+Anonymous\s*\[[^\]]*\bconnect\b[^\]]*\]/i)
    if (match) anonymousIndexes.push(Number(match[1]))
  }
  anonymousIndexes.sort((a, b) => b - a)
  for (const index of anonymousIndexes) {
    const args = ['access', 'delete', id, '--index', String(index)]
    addLog('system', formatCommand('devtunnel', args))
    const result = await runCommand(args)
    if (result) addLog('stdout', result)
  }
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
      const result = await runCommand(['list'])
      addLog('stdout', result)
      const tunnels = parseTunnelsFromText(result)

      // 并发获取每个隧道的端口详情
      const detailed = await Promise.all(tunnels.map(async (t) => {
        try {
          const ports = await this.listPorts(t.tunnelId)
          return { ...normalizeTunnel(t), ports: Array.isArray(ports) ? ports : [] }
        } catch (e) {
          return { ...normalizeTunnel(t), ports: [] }
        }
      }))

      // 从日志中提取运行中隧道的URL
      if (hostProcess && window.__runningTunnelId) {
        const logs = logBuffer.slice(-50)
        for (let i = logs.length - 1; i >= 0; i--) {
          const text = logs[i].text
          const url = pickConnectUrl(text)
          if (url) {
            this.tunnelUrlCache[window.__runningTunnelId] = url
            break
          }
        }
      }

      return detailed
    } catch (e) {
      addLog('error', '获取隧道列表失败: ' + e.message)
      return []
    }
  },

  async getTunnelWithPorts (tunnelId) {
    try {
      const detail = await this.showTunnel(tunnelId)
      const ports = await this.listPorts(tunnelId)
      const parsedPorts = Array.isArray(ports) && ports.length ? ports : (Array.isArray(detail?.ports) ? detail.ports : [])
      return normalizeTunnel({ ...detail, ports: parsedPorts })
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
        try {
          await runCommand(['delete', tunnelId, '--force'])
          addLog('system', '已回滚删除未完成配置的隧道: ' + tunnelId)
        } catch (deleteErr) {
          addLog('error', '回滚删除隧道失败: ' + deleteErr.message)
        }
        throw new Error('隧道已创建，但端口添加失败: ' + e.message)
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
      if (hostProcess && window.__runningTunnelId === id) {
        this.stopHost()
        window.__runningTunnelId = null
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
      return parsePortsFromText(result)
    } catch (e) {
      addLog('error', '获取端口列表失败: ' + e.message)
      return []
    }
  },

  async addPort (tunnelId, port, protocol) {
    try {
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

  tunnelUrlCache: {}, // 存储隧道URL

  startHost (tunnelId, port, allowAnonymous) {
    if (hostProcess) return { success: false, message: '已有隧道在运行中，请先停止' }

    const args = ['host']
    if (tunnelId) args.push(tunnelId)
    else if (port) args.push('-p', String(port))
    if (allowAnonymous) args.push('--allow-anonymous')

    const devtunnelPath = getDevTunnelPath()
    addLog('system', formatCommand('devtunnel', args))

    try {
      hostProcess = spawn(devtunnelPath, args, { windowsHide: true })
      hostPid = hostProcess.pid
      const currentProcess = hostProcess
      const currentPid = hostPid

      currentProcess.stdout.on('data', (data) => {
        const text = decodeOutput(data).trim()
        if (text) {
          addLog('stdout', text)
          window.dispatchEvent(new CustomEvent('tunnel-log', { detail: text }))
          // 提取可访问 URL，排除 inspect 调试页（调试页通常需要登录）
          const url = pickConnectUrl(text, port)
          if (url) {
            const cacheKey = tunnelId || window.__runningTunnelId || ''
            if (cacheKey) this.tunnelUrlCache[cacheKey] = url
            window.dispatchEvent(new CustomEvent('tunnel-url', { detail: { tunnelId: cacheKey, url } }))
          }
        }
      })

      currentProcess.stderr.on('data', (data) => {
        const text = decodeOutput(data).trim()
        if (text) {
          addLog('stderr', text)
          window.dispatchEvent(new CustomEvent('tunnel-error', { detail: text }))
        }
      })

      currentProcess.on('close', (code) => {
        addLog('system', '进程退出 (code: ' + code + ')')
        if (hostProcess === currentProcess && hostPid === currentPid) {
          window.dispatchEvent(new CustomEvent('tunnel-exit', { detail: code }))
          hostProcess = null
          hostPid = null
        }
      })

      currentProcess.on('error', (err) => {
        addLog('error', '启动失败: ' + err.message)
        if (hostProcess === currentProcess && hostPid === currentPid) {
          window.dispatchEvent(new CustomEvent('tunnel-error', { detail: err.message }))
          hostProcess = null
          hostPid = null
        }
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
      const pid = hostPid
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
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
      'frp-token',
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

  startFileServer (dirPath, port = 3000, mode) {
    if (fileServer) return Promise.resolve({ success: false, message: '文件服务器已在运行中' })
    if (!fs.existsSync(dirPath)) return Promise.resolve({ success: false, message: '目录不存在' })
    const rootDir = path.resolve(dirPath)
    let rootRealPath
    try {
      rootRealPath = fs.realpathSync.native(rootDir)
      if (!fs.statSync(rootRealPath).isDirectory()) {
        return Promise.resolve({ success: false, message: '请选择有效目录' })
      }
    } catch (e) {
      return Promise.resolve({ success: false, message: '目录不可访问: ' + e.message })
    }

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
        return `<tr><td>${icon}</td><td><a href="${escapeHtml(href)}">${escapeHtml(name)}</a></td><td>${escapeHtml(size)}</td><td>${escapeHtml(mtime)}</td></tr>`
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
<title>📂 ${escapeHtml(dirUrl)}</title>
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
    <span class="path">${escapeHtml(dirUrl)}</span>
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

    function getParentUrlPath (dirUrl) {
      const trimmed = String(dirUrl || '/').replace(/\/+$/, '')
      if (!trimmed) return null
      const index = trimmed.lastIndexOf('/')
      return index <= 0 ? '/' : trimmed.slice(0, index + 1)
    }

    return new Promise((resolve) => {
      try {
        fileServer = http.createServer((req, res) => {
          try {
            const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
            let reqPath
            try {
              reqPath = decodeURIComponent(requestUrl.pathname || '/')
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('400 请求路径无效')
              return
            }
            const normalizedReqPath = reqPath.replace(/^[/\\]+/, '')

            // 安全检查：防止目录遍历
            const fullPath = path.resolve(path.join(rootDir, normalizedReqPath))
            if (!isPathInside(rootDir, fullPath)) {
              res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('403 禁止访问')
              return
            }

            if (!fs.existsSync(fullPath)) {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('404 文件不存在')
              return
            }

            const realPath = fs.realpathSync.native(fullPath)
            if (!isPathInside(rootRealPath, realPath)) {
              res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('403 禁止访问')
              return
            }

            const stat = fs.statSync(realPath)

            if (stat.isDirectory()) {
              let entries = fs.readdirSync(realPath, { withFileTypes: true })
              entries.sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
                return a.name.localeCompare(b.name)
              })
              entries = entries.map(e => {
                try {
                  const entryPath = path.join(realPath, e.name)
                  const entryRealPath = fs.realpathSync.native(entryPath)
                  if (!isPathInside(rootRealPath, entryRealPath)) return null
                  const s = fs.statSync(entryRealPath)
                  return { name: e.name, isDirectory: s.isDirectory(), size: s.size, mtime: s.mtimeMs }
                } catch (err) {
                  return { name: e.name, isDirectory: false, size: 0, mtime: 0 }
                }
              }).filter(Boolean)

              const dirUrl = requestUrl.pathname.endsWith('/') ? requestUrl.pathname : requestUrl.pathname + '/'
              const parentPath = dirUrl !== '/' ? getParentUrlPath(dirUrl) : null
              const html = renderDirPage(dirUrl, entries, parentPath)
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              res.end(html)
            } else {
              const mime = getMimeType(realPath)
              res.writeHead(200, {
                'Content-Type': mime,
                'Content-Length': stat.size,
                'Content-Disposition': 'inline'
              })
              fs.createReadStream(realPath).pipe(res)
            }
          } catch (err) {
            if (mode === 'frp') addFrpcLog('error', '文件服务器请求失败: ' + err.message, 'proxydir')
            else addLog('error', '文件服务器请求失败: ' + err.message)
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('500 服务器错误')
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
      if (!doc) return null
      return {
        server: { ...(doc.server || {}), token: getLocal('frp-token', '') },
        proxies: doc.proxies || []
      }
    } catch (e) {
      return null
    }
  },

  async saveFrpConfig (config) {
    try {
      const server = { ...(config.server || {}) }
      if (Object.prototype.hasOwnProperty.call(server, 'token')) {
        if (server.token) setLocal('frp-token', server.token)
        else removeLocal('frp-token')
        delete server.token
      }
      const doc = { _id: 'frp-config', server, proxies: config.proxies }
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

  generateFrpcConfig (serverConfig, proxies) {
    let toml = `serverAddr = ${tomlString(serverConfig.serverAddr)}\n`
    toml += `serverPort = ${toPortNumber(serverConfig.serverPort, 7000)}\n`
    if (serverConfig.token) toml += `auth.token = ${tomlString(serverConfig.token)}\n`
    toml += '\n'

    for (const p of proxies) {
      toml += '[[proxies]]\n'
      toml += `name = ${tomlString(p.name)}\n`
      toml += `type = ${tomlString(p.type)}\n`
      toml += `localPort = ${toPortNumber(p.localPort)}\n`
      if (p.type === 'tcp' && p.remotePort) toml += `remotePort = ${toPortNumber(p.remotePort)}\n`
      if (p.type === 'http' && p.customDomain) toml += `customDomains = [${tomlString(p.customDomain)}]\n`
      toml += '\n'
    }
    return toml
  },

  startFrpc (serverConfig, proxies, source) {
    if (frpcProcess) return { success: false, message: 'frpc 已在运行中' }
    frpcSource = source || 'frp'

    const frpcPath = this.getFrpcPath()
    if (!fs.existsSync(frpcPath)) {
      frpcSource = ''
      return { success: false, message: 'frpc 未找到: ' + frpcPath + '\n请在「设置」页面配置 frpc 路径' }
    }

    // 生成临时配置文件
    let configContent
    try {
      configContent = this.generateFrpcConfig(serverConfig, proxies)
    } catch (e) {
      frpcSource = ''
      return { success: false, message: '生成配置失败: ' + e.message }
    }
    const configPath = path.join(require('os').tmpdir(), 'frpc-tunnel-plugin.toml')
    try {
      fs.writeFileSync(configPath, configContent, 'utf-8')
    } catch (e) {
      frpcSource = ''
      return { success: false, message: '写入配置文件失败: ' + e.message }
    }

    addFrpcLog('system', '配置文件: ' + configPath, frpcSource)
    addFrpcLog('system', '配置内容:\n' + maskFrpcConfig(configContent), frpcSource)

    const args = ['-c', configPath]
    addFrpcLog('system', formatCommand('frpc', args), frpcSource)

    addFrpcLog('system', '可执行文件: ' + frpcPath, frpcSource)

    try {
      frpcProcess = spawn(frpcPath, args, { windowsHide: true })
      frpcPid = frpcProcess.pid
      const currentProcess = frpcProcess
      const currentPid = frpcPid
      const currentSource = frpcSource
      let stderrBuf = ''
      let errorFired = false

      currentProcess.stdout.on('data', (data) => {
        const text = data.toString().trim()
        if (text) addFrpcLog('stdout', text, currentSource)
      })

      currentProcess.stderr.on('data', (data) => {
        const text = data.toString().trim()
        if (text) {
          stderrBuf += text + '\n'
          addFrpcLog('stderr', text, currentSource)
        }
      })

      currentProcess.on('close', (code) => {
        const errMsg = stderrBuf.trim()
        const wasStopping = currentProcess.__stopping === true

        // 主动停止时不显示错误
        if (code !== 0 && !errorFired && !wasStopping) {
          const detail = errMsg || ('frpc 退出码: ' + code)
          addFrpcLog('error', detail, currentSource)
          if (frpcProcess === currentProcess && frpcPid === currentPid) {
            dispatchFrpcEvent('frpc-error', { message: detail }, currentSource)
          }
        }

        addFrpcLog('system', 'frpc 进程退出 (code: ' + code + ')', currentSource)
        if (frpcProcess === currentProcess && frpcPid === currentPid) {
          dispatchFrpcEvent('frpc-exit', { code }, currentSource)
          frpcProcess = null
          frpcPid = null
          frpcSource = ''
        }
        try { fs.unlinkSync(configPath) } catch (e) {}
      })

      currentProcess.on('error', (err) => {
        errorFired = true
        addFrpcLog('error', err.message, currentSource)
        if (frpcProcess === currentProcess && frpcPid === currentPid) {
          dispatchFrpcEvent('frpc-error', { message: err.message }, currentSource)
          dispatchFrpcEvent('frpc-exit', { code: -1 }, currentSource)
          frpcProcess = null
          frpcPid = null
          frpcSource = ''
        }
        try { fs.unlinkSync(configPath) } catch (e) {}
      })

      return { success: true, pid: frpcPid, source: frpcSource }
    } catch (e) {
      frpcProcess = null
      frpcPid = null
      frpcSource = ''
      return { success: false, message: e.message }
    }
  },

  stopFrpc () {
    if (!frpcProcess) return { success: false, message: 'frpc 未在运行' }
    try {
      const currentProcess = frpcProcess
      const currentSource = frpcSource
      const pid = frpcPid
      currentProcess.__stopping = true
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
      addFrpcLog('system', '正在停止 frpc...', currentSource)
      frpcProcess = null
      frpcPid = null
      frpcSource = ''
      return { success: true, source: currentSource }
    } catch (e) {
      return { success: false, message: e.message }
    }
  },

  getFrpcStatus () {
    return { running: frpcProcess !== null, pid: frpcPid, source: frpcSource }
  },

  async testFrpConnection (serverAddr, serverPort) {
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
