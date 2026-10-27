function parseEntries (text) {
  const input = String(text || '').trim()
  if (!input || input === '[]' || /^no access control entries(?: found)?\.?$/i.test(input)) return []
  if (input.startsWith('[') || input.startsWith('{')) {
    const data = JSON.parse(input)
    const entries = Array.isArray(data) ? data : data?.entries || data?.accessControl?.entries
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.type !== 'string' || !Array.isArray(entry.scopes) || entry.scopes.some(scope => typeof scope !== 'string'))) throw new Error('无法解析访问权限列表')
    return entries.map((entry, index) => ({ ...entry, index, anonymous: entry.type.toLowerCase() === 'anonymous' }))
  }
  return input.split(/\r?\n/).filter(line => line.trim()).filter(line => !/^(?:(?:tunnel|port)\s+)?access control entries\s*:?$/i.test(line.trim())).map(line => {
    const match = line.match(/^\s*(\d+):\s*([+-])([^\s[]+)(.*?)\[([^\]]+)\](?:\s+\(inherited\))?\s*$/i)
    if (!match) throw new Error('无法解析访问权限列表，已拒绝修改')
    return { index: Number(match[1]), anonymous: match[3].toLowerCase() === 'anonymous', isDeny: match[2] === '-', isInherited: /\(inherited\)\s*$/i.test(line), scopes: match[5].split(',').map(scope => scope.trim().toLowerCase()) }
  })
}

module.exports = async function syncAnonymousAccess (run, parsePorts, id, allow) {
  const list = async port => parseEntries(await run(['access', 'list', id, ...port]))
  const tunnel = await list([])
  const output = await run(['port', 'list', id])
  const ports = parsePorts(output)
  if (!ports.length && !/^\s*(?:\[\s*\]|\{\s*"ports"\s*:\s*\[\s*\]\s*\}|no ports\b)/i.test(output)) throw new Error('无法读取端口列表，已取消权限修改')
  const scopes = [{ port: [], entries: tunnel }]
  for (const port of ports) scopes.push({ port: ['--port', String(port.portNumber)], entries: await list(['--port', String(port.portNumber)]) })
  const connects = entry => entry.anonymous && entry.scopes.includes('connect')
  if (allow) {
    if (scopes.some(({ entries }) => entries.some(entry => connects(entry) && entry.isDeny))) throw new Error('隧道或端口存在匿名访问拒绝规则，请先确认权限')
    if (!tunnel.some(entry => connects(entry) && !entry.isDeny)) await run(['access', 'create', id, '--anonymous', '--scopes', 'connect'])
    const verified = await list([])
    if (!verified.some(entry => connects(entry) && !entry.isDeny) || verified.some(entry => connects(entry) && entry.isDeny)) throw new Error('匿名访问授权后未能验证 connect 权限')
    for (const { port } of scopes.slice(1)) {
      if ((await list(port)).some(entry => connects(entry) && entry.isDeny)) throw new Error('端口存在匿名访问拒绝规则，已取消启动')
    }
    return
  }
  const mixed = entries => entries.some(entry => connects(entry) && !entry.isDeny && !entry.isInherited && entry.scopes.some(scope => scope !== 'connect'))
  if (scopes.some(({ entries }) => mixed(entries))) throw new Error('匿名规则包含其他权限 scope，已拒绝撤销')
  for (const { port } of scopes) {
    // 隧道权限删除后，端口继承项及其索引会变化，需要重新读取。
    const entries = await list(port)
    if (mixed(entries)) throw new Error('匿名规则已变化，已取消权限修改')
    for (const entry of entries.filter(entry => connects(entry) && !entry.isDeny && !entry.isInherited).sort((a, b) => b.index - a.index)) {
      await run(['access', 'delete', id, ...port, '--index', String(entry.index)])
    }
  }
  for (const { port } of scopes) {
    if ((await list(port)).some(entry => connects(entry) && !entry.isDeny)) throw new Error('撤销匿名访问后仍检测到 connect 权限，已取消启动')
  }
}
