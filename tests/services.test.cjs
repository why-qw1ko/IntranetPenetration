const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const createStorage = require('../public/preload/storage')

function services (execute = () => ({ stdout: '[]' }), modules = {}) {
  const docs = new Map()
  const local = new Map()
  const events = []
  const commands = []
  const children = []
  const timers = new Map()
  const utools = {
    getNativeId: () => 'test-device',
    dbStorage: { getItem: key => local.get(key), setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) },
    db: {
      get: id => docs.get(id) || null,
      put: doc => { docs.set(doc._id, doc); return { ok: true } },
      remove: doc => docs.delete(doc._id)
    }
  }
  const childProcess = {
    execFile (file, args, options, callback) {
      commands.push([...args])
      const result = execute(args, options)
      callback(result.error || null, Buffer.from(result.stdout || ''), Buffer.from(result.stderr || ''))
    },
    spawn () {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.pid = 100 + children.length
      child.kill = () => true
      children.push(child)
      return child
    }
  }
  const window = { utools, dispatchEvent: event => events.push(event) }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/preload/services.js'), 'utf8'), {
    window, Buffer, TextDecoder, process,
    CustomEvent: class { constructor (type, { detail }) { this.type = type; this.detail = detail } },
    setTimeout: fn => { const id = {}; timers.set(id, fn); return id },
    clearTimeout: id => timers.delete(id),
    require: name => name === './storage' ? () => createStorage(utools) : name === './frp' ? require('../public/preload/frp') : name === './devtunnel-access' ? require('../public/preload/devtunnel-access') : name === 'child_process' ? { ...childProcess, ...modules.child_process } : modules[name] || require(name)
  })
  return { api: window.services, window, events, commands, children }
}

async function start (fixture, id) {
  const pending = fixture.api.startHost(id, 3000)
  const child = fixture.children.at(-1)
  child.emit('spawn')
  assert.equal((await pending).success, true)
  return child
}

test('命令输出优先 UTF-8 解码并保留 GBK 错误兼容', async () => {
  const { api } = services(args => {
    if (args[0] === 'show') return { stdout: JSON.stringify({ tunnelId: 't1', description: '代理目录: 示例' }) }
    if (args[0] === 'delete') return { error: new Error('failed'), stderr: '删除失败：无权限' }
    if (args[0] === 'update') return { error: new Error('failed'), stderr: Buffer.from([0xb4, 0xed, 0xce, 0xf3]) }
    return { stdout: '[]' }
  })
  const tunnel = await api.getTunnelWithPorts('t1')
  assert.equal(tunnel.description, '代理目录: 示例')
  assert.equal((await api.deleteTunnel('t1')).message, '删除失败：无权限')
  await assert.rejects(api.updateTunnel('t1', { description: 'x' }), /错误/)
})

test('创建隧道端口失败向调用方报告部分完成，不返回伪成功或删除云端隧道', async () => {
  const fixture = services(args => {
    if (args[0] === 'create') return { stdout: '{"tunnelId":"created"}' }
    if (args[0] === 'port' && args[1] === 'create') return { error: new Error('port rejected'), stderr: '端口创建失败' }
    return { stdout: '[]' }
  })
  await assert.rejects(fixture.api.createTunnel({ port: 3000 }), /created.*端口.*失败/)
  assert.equal(fixture.commands.some(args => args[0] === 'show' || args[0] === 'delete'), false)
})

test('创建成功但详情读取失败时返回非空创建结果，普通详情读取仍返回 null', async () => {
  const fixture = services(args => {
    if (args[0] === 'create') return { stdout: '{"tunnelId":"created","description":"中文"}' }
    if (args[0] === 'show') return { error: new Error('offline') }
    return { stdout: '[]' }
  })
  const tunnel = await fixture.api.createTunnel({ port: 3000, protocol: 'http' })
  assert.ok(tunnel)
  assert.equal(tunnel.tunnelId, 'created')
  assert.equal(tunnel.description, '中文')
  assert.equal(tunnel.ports[0].portNumber, 3000)
  assert.equal(tunnel.ports[0].protocol, 'http')
  assert.equal(await fixture.api.getTunnelWithPorts('created'), null)
  assert.equal((await fixture.api.createTunnel()).ports.length, 0)
})

test('隧道 URL 仅来自所属进程，不继承历史地址或被列表 JSON 覆盖', async () => {
  const fixture = services(args => ({ stdout: args[0] === 'list' ? '[{"tunnelId":"other","url":"https://other.devtunnels.ms"}]' : '[]' }))
  const first = await start(fixture, 'A')
  first.stdout.emit('data', Buffer.from('https://a.devtunnels.ms\n'))
  first.emit('close', 0)
  const second = await start(fixture, 'B')
  await fixture.api.listTunnels()
  assert.equal(fixture.api.getTunnelUrl('B'), '')
  second.stdout.emit('data', Buffer.from('https://b.devtunnels.ms\n'))
  first.stdout.emit('data', Buffer.from('https://late-a.devtunnels.ms\n'))
  await fixture.api.listTunnels()
  assert.equal(fixture.api.getTunnelUrl('B'), 'https://b.devtunnels.ms')
  second.emit('close', 0)
  assert.equal(fixture.api.getTunnelUrl('B'), '')
})

test('取消匿名时按索引删除隧道及端口的匿名授权，保留其他访问规则', async () => {
  const entries = new Map([
    ['tunnel', [{ type: 'Anonymous', scopes: ['connect'] }, { type: 'Users', scopes: ['connect'] }, { type: 'Anonymous', scopes: ['connect'] }]],
    ['3000', [{ type: 'Anonymous', scopes: ['connect'] }]]
  ])
  const fixture = services(args => {
    if (args[0] === 'port') return { stdout: '[{"portNumber":3000}]' }
    if (args[0] === 'access') {
      const portIndex = args.indexOf('--port')
      const key = portIndex === -1 ? 'tunnel' : args[portIndex + 1]
      if (args[1] === 'list') return { stdout: JSON.stringify({ entries: entries.get(key) }) }
      if (args[1] === 'delete') entries.get(key).splice(Number(args[args.indexOf('--index') + 1]), 1)
      return { stdout: '{}' }
    }
    if (args[0] === 'show') return { stdout: '{"tunnelId":"t1"}' }
    return { stdout: '{}' }
  })
  await fixture.api.updateTunnel('t1', { anonymous: false })
  assert.equal(entries.get('tunnel').length, 1)
  assert.equal(entries.get('tunnel')[0].type, 'Users')
  assert.equal(entries.get('3000').length, 0)
  assert.equal(fixture.commands.some(args => args[0] === 'update'), false)
  assert.deepEqual(fixture.commands.filter(args => args[1] === 'delete').map(args => args[args.indexOf('--index') + 1]), ['2', '0', '0'])
})

test('匿名授权使用 access create，并在权限读取失败或格式未知时拒绝继续', async () => {
  let allowed = false
  const fixture = services(args => {
    if (args[0] === 'access' && args[1] === 'create') allowed = true
    if (args[0] === 'access' && args[1] === 'list') return { stdout: JSON.stringify(allowed ? [{ type: 'Anonymous', scopes: ['connect'] }] : []) }
    if (args[0] === 'show') return { stdout: '{"tunnelId":"t1"}' }
    return { stdout: '[]' }
  })
  await fixture.api.updateTunnel('t1', { anonymous: true })
  assert.ok(fixture.commands.some(args => args.join(' ') === 'access create t1 --anonymous'))
  assert.equal(fixture.commands.some(args => args.includes('--allow-anonymous') || args.includes('--deny-anonymous')), false)
  const unknown = services(() => ({ stdout: '{"unexpected":true}' }))
  await assert.rejects(unknown.api.updateTunnel('t1', { anonymous: false }), /访问控制|端口/)
  assert.equal(unknown.commands.some(args => args[1] === 'delete' || args[1] === 'create'), false)
})

test('撤销上级匿名规则后重新读取端口索引，避免误删其他授权', async () => {
  let tunnelAllowed = true
  const ownPortEntries = [{ type: 'Users', scopes: ['connect'] }, { type: 'Anonymous', scopes: ['connect'] }]
  const fixture = services(args => {
    if (args[0] === 'port') return { stdout: '[{"portNumber":3000}]' }
    if (args[0] === 'show') return { stdout: '{"tunnelId":"t1"}' }
    const isPort = args.includes('--port')
    const entries = isPort ? [...(tunnelAllowed ? [{ type: 'Anonymous', scopes: ['connect'], isInherited: true }] : []), ...ownPortEntries] : tunnelAllowed ? [{ type: 'Anonymous', scopes: ['connect'] }] : []
    if (args[1] === 'list') return { stdout: JSON.stringify(entries) }
    if (args[1] === 'delete') {
      if (isPort) ownPortEntries.splice(Number(args.at(-1)), 1)
      else tunnelAllowed = false
    }
    return { stdout: '{}' }
  })
  await fixture.api.updateTunnel('t1', { anonymous: false })
  assert.deepEqual(ownPortEntries, [{ type: 'Users', scopes: ['connect'] }])
})

test('启动失败清理所属文件服务，停止命令失败保留真实 host 状态', async () => {
  const fixture = services()
  const pending = fixture.api.startHost('missing', 3000)
  fixture.children[0].emit('error', new Error('ENOENT'))
  const failed = await pending
  assert.equal(failed.success, false)
  assert.equal(failed.message, 'ENOENT')
  assert.equal(fixture.api.getHostStatus().running, false)
  const child = await start(fixture, 'running')
  let stopped
  if (process.platform === 'win32') {
    stopped = fixture.api.stopHost()
    fixture.children.at(-1).emit('error', new Error('permission denied'))
  } else {
    child.kill = () => { throw new Error('permission denied') }
    stopped = fixture.api.stopHost()
  }
  assert.equal((await stopped).success, false)
  assert.equal(fixture.api.getHostStatus().running, true)
  assert.equal((await fixture.api.startHost('other', 3000)).success, false)
  child.emit('close', 0)
})

test('本地目录服务阻止越界和 junction，转义列表并在 host 启动失败时清理', async t => {
  const http = require('node:http')
  const os = require('node:os')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-review-'))
  const root = path.join(base, 'shared')
  const outside = path.join(base, 'shared-private')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(root, "report'&.txt"), 'public file')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'private file')
  let server
  const fixture = services(undefined, {
    http: {
      createServer (handler) {
        server = http.createServer(handler)
        const listen = server.listen
        server.listen = function (port, host, callback) { return listen.call(this, 0, host, callback) }
        return server
      }
    }
  })
  t.after(() => { fixture.api.stopFileServer(); fs.rmSync(base, { recursive: true, force: true }) })
  assert.equal((await fixture.api.startFileServer(root, 3000)).success, true)
  const request = pathname => new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: pathname }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
  })
  assert.match((await request('/')).body, /report&#39;&amp;\.txt/)
  assert.equal((await request('/report%27%26.txt')).body, 'public file')
  assert.equal((await request('/%2e%2e/shared-private/secret.txt')).status, 403)
  assert.equal((await request('/%E0%A4%A')).status, 400)
  await t.test('外部 junction 不出现在列表且不可读取', async t => {
    try { fs.symlinkSync(outside, path.join(root, 'external'), 'junction') } catch (error) { t.skip(error.message); return }
    assert.equal((await request('/external/secret.txt')).status, 403)
    assert.equal((await request('/')).body.includes('external'), false)
  })
  assert.equal(fixture.api.stopFileServer('frp').success, false)
  assert.equal(fixture.api.getFileServerStatus().running, true)
  const pending = fixture.api.startHost('missing', 3000)
  fixture.children[0].emit('error', new Error('ENOENT'))
  assert.equal((await pending).success, false)
  assert.equal(fixture.api.getFileServerStatus().running, false)
})

test('启动和真实退出通知页面统一的 host 状态', async () => {
  const fixture = services()
  const child = await start(fixture, 'A')
  const started = fixture.events.find(event => event.type === 'tunnel-host-status' && event.detail.running)
  assert.ok(started)
  assert.equal(started.detail.tunnelId, 'A')
  child.emit('close', 0)
  const stopped = fixture.events.filter(event => event.type === 'tunnel-host-status').at(-1)
  assert.equal(stopped.detail.running, false)
  assert.equal(fixture.window.__runningTunnelId, null)
})

test('非法端口在后端创建、增删端口和文件服务写入前被拒绝', async () => {
  for (const port of ['', 0, -1, 65536, 1.5, '1e3', '80abc', null]) {
    const fixture = services()
    await assert.rejects(fixture.api.createTunnel({ port }), /端口/)
    await assert.rejects(fixture.api.addPort('t1', port), /端口/)
    await assert.rejects(fixture.api.deletePort('t1', port), /端口/)
    assert.equal((await fixture.api.startFileServer(__dirname, port)).success, false)
    assert.equal(fixture.commands.length, 0)
  }
})

test('host 按完整行处理跨块的中文和 URL，退出时保留无换行日志', async () => {
  const fixture = services()
  const child = await start(fixture, 't1')
  const output = Buffer.from('代理目录已启动 https://example.devtunnels.ms\n')
  for (const byte of output) child.stdout.emit('data', Buffer.from([byte]))
  const error = Buffer.from('错误：没有权限')
  for (const byte of error) child.stderr.emit('data', Buffer.from([byte]))
  child.emit('close', 1)
  const entries = fixture.api.getLogBuffer().map(entry => entry.text)
  assert.ok(entries.includes('代理目录已启动 https://example.devtunnels.ms'))
  assert.ok(entries.includes('错误：没有权限'))
  assert.ok(fixture.events.some(event => event.type === 'tunnel-url' && event.detail.url === 'https://example.devtunnels.ms'))
})

test('登录输出跨块时保留完整中文和设备验证码', () => {
  const fixture = services()
  fixture.api.login()
  const child = fixture.children[0]
  const output = Buffer.from('请登录：open the page https://microsoft.com/devicelogin and enter the code ABCD1234\n')
  for (const byte of output) child.stdout.emit('data', Buffer.from([byte]))
  const code = fixture.events.find(event => event.type === 'tunnel-login-code')
  assert.equal(code.detail.code, 'ABCD1234')
  assert.ok(fixture.api.getLogBuffer().some(entry => entry.text.startsWith('请登录：')))
})

test('host 未产生 spawn 事件就退出时结束启动等待并释放状态', async () => {
  const fixture = services()
  const pending = fixture.api.startHost('t1', 3000)
  fixture.children[0].emit('close', 1)
  assert.equal((await pending).success, false)
  assert.equal(fixture.api.getHostStatus().running, false)
})

test('同步抛出的启动错误清理本次文件服务', async () => {
  let closed = false
  const fixture = services(undefined, {
    child_process: { spawn () { throw new Error('spawn rejected') } },
    http: { createServer () {
      const server = new EventEmitter()
      server.listen = (port, host, callback) => callback()
      server.close = () => { closed = true }
      return server
    } }
  })
  assert.equal((await fixture.api.startFileServer(__dirname, 3000)).success, true)
  assert.equal((await fixture.api.startHost('t1', 3000)).success, false)
  assert.equal(fixture.api.getFileServerStatus().running, false)
  assert.equal(closed, true)
})

test('开启匿名前拒绝端口上的匿名拒绝规则，不修改已有权限', async () => {
  const fixture = services(args => {
    if (args[0] === 'port') return { stdout: '[{"portNumber":3000}]' }
    if (args[0] === 'access' && args[1] === 'list') return { stdout: JSON.stringify(args.includes('--port')
      ? [{ type: 'Anonymous', scopes: ['connect'], isDeny: true }]
      : [{ type: 'Anonymous', scopes: ['connect'] }]) }
    return { stdout: '{}' }
  })
  await assert.rejects(fixture.api.updateTunnel('t1', { anonymous: true }), /端口.*拒绝/)
  assert.equal(fixture.commands.some(args => args[1] === 'create' || args[1] === 'delete'), false)
})
