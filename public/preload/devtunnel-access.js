// 只调整匿名 connect 授权，保留用户、组织及其他权限；未知输出必须阻止启动。
module.exports = async function syncAnonymousAccess (runCommand, tunnelId, allowed) {
  const parseEntries = text => {
    const data = JSON.parse(text)
    const entries = Array.isArray(data) ? data : data?.entries || data?.accessControl?.entries
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.type !== 'string' || !Array.isArray(entry.scopes) || entry.scopes.some(scope => typeof scope !== 'string'))) {
      throw new Error('无法识别访问控制列表，请检查 devtunnel CLI 版本')
    }
    return entries
  }
  const list = async port => parseEntries(await runCommand(['access', 'list', tunnelId, ...port, '-j']))
  const anonymousConnect = entry => entry.type.toLowerCase() === 'anonymous' && entry.scopes.includes('connect')
  const tunnelEntries = await list([])
  const data = JSON.parse(await runCommand(['port', 'list', tunnelId, '-j']))
  const ports = Array.isArray(data) ? data : data?.ports || (data?.portNumber ? [data] : null)
  if (!Array.isArray(ports) || ports.some(port => !/^\d+$/.test(String(port?.portNumber)) || Number(port.portNumber) < 1 || Number(port.portNumber) > 65535)) {
    throw new Error('无法读取隧道端口，已取消匿名权限修改')
  }
  const lists = [{ port: [], entries: tunnelEntries }]
  for (const port of ports) lists.push({ port: ['--port', String(port.portNumber)], entries: await list(['--port', String(port.portNumber)]) })
  if (allowed) {
    if (lists.some(({ entries }) => entries.some(entry => anonymousConnect(entry) && entry.isDeny))) throw new Error('隧道或端口存在匿名访问拒绝规则，请先在 CLI 中确认权限')
    if (!tunnelEntries.some(entry => anonymousConnect(entry) && !entry.isDeny)) {
      await runCommand(['access', 'create', tunnelId, '--anonymous'])
    }
    const verified = await list([])
    if (!verified.some(entry => anonymousConnect(entry) && !entry.isDeny) || verified.some(entry => anonymousConnect(entry) && entry.isDeny)) {
      throw new Error('未能确认匿名访问已开启，已取消启动')
    }
    for (const { port } of lists.slice(1)) {
      if ((await list(port)).some(entry => anonymousConnect(entry) && entry.isDeny)) throw new Error('端口存在匿名访问拒绝规则，已取消启动')
    }
    return
  }

  for (const { entries } of lists) {
    if (entries.some(entry => anonymousConnect(entry) && !entry.isDeny && !entry.isInherited && entry.scopes.some(scope => scope !== 'connect'))) {
      throw new Error('匿名规则包含其他权限，请先在 CLI 中拆分规则，已取消启动')
    }
  }
  for (const { port } of lists) {
    // 上级授权删除后，端口继承项及索引可能变化，必须重新读取。
    const entries = await list(port)
    if (entries.some(entry => anonymousConnect(entry) && !entry.isDeny && !entry.isInherited && entry.scopes.some(scope => scope !== 'connect'))) throw new Error('匿名规则已变化，请在 CLI 中确认权限，已取消启动')
    // 倒序删除，避免删除前面的条目后导致后续索引错位。
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      if (anonymousConnect(entry) && !entry.isDeny && !entry.isInherited) {
        await runCommand(['access', 'delete', tunnelId, ...port, '--index', String(index)])
      }
    }
  }
  for (const { port } of lists) {
    if ((await list(port)).some(entry => anonymousConnect(entry) && !entry.isDeny)) throw new Error('匿名访问仍有授权，已取消启动，请检查隧道及端口权限')
  }
}
