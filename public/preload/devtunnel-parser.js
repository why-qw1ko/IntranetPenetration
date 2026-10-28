function hasAnonymousConnectAccess (text) {
  return /\+Anonymous\s*\[[^\]]*\bconnect\b[^\]]*\]/i.test(String(text || ''))
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

  const createdMatch = input.match(new RegExp('(?:^|\\n)\\s*(?:(?:created|updated|deleted|hosting)\\s+(?:tunnel\\s+)?|set\\s+default\\s+tunnel\\s+to\\s+)["\'`]*' + idPattern + '(?=\\s|$|[,"\'`]|\\.(?:\\s|$))', 'i'))
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
    description: tunnel.description ?? tunnel.desc ?? tunnel.descriptionText ?? '',
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

function isEmptyList (text, fields, label) {
  const input = String(text || '').trim()
  try {
    const data = JSON.parse(input)
    return Array.isArray(data) ? data.length === 0 : fields.some(field => Array.isArray(data?.[field]) && data[field].length === 0)
  } catch (error) {}
  if (new RegExp('^(?:you have )?no ' + label + '\\b', 'i').test(input)) return true
  const lines = input.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^[-=\s|]+$/.test(line))
  return lines.length === 1 && (label === 'tunnels' ? /^(?:tunnel\s+id|id|隧道\s*id)(?:\s|$)/i : /^(?:port(?:\s+number)?|端口号)(?:\s|$)/i).test(lines[0])
}

function parseTunnelList (text) {
  const tunnels = parseTunnelsFromText(text)
  if (!tunnels.length && !isEmptyList(text, ['tunnels', 'value', 'items'], 'tunnels')) throw new Error('无法识别隧道列表，请检查 CLI 输出或版本')
  return tunnels
}

function parsePortList (text) {
  const ports = parsePortsFromText(text)
  if (!ports.length && !isEmptyList(text, ['ports'], 'ports')) throw new Error('无法识别端口列表，请检查 CLI 输出或版本')
  return ports
}

module.exports = { normalizeTunnelId, normalizeTunnel, extractTunnelIdFromText, parseTunnelsFromText, parseTunnelDetailFromText, parsePortsFromText, parseTunnelList, parsePortList, pickConnectUrl }
