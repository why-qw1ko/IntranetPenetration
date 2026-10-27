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

module.exports = { isPort, validateServer, validateProxies, generateFrpcConfig }
