const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { EventEmitter } = require('node:events')
const { createRequire } = require('node:module')

const servicePath = path.resolve(__dirname, '../public/preload/services.js')
function setup (command = () => '', options = {}) {
  const calls = []
  const children = []
  const docs = new Map()
  const local = new Map()
  const events = []
  const realRequire = createRequire(servicePath)
  const window = {
    utools: {
      getNativeId: () => 'test-device',
      db: {
        get: id => { if (options.getError) throw new Error('读取失败'); return structuredClone(docs.get(id) || null) },
        put: doc => {
          const result = Object.hasOwn(options, 'putResult') ? options.putResult : { ok: true }
          if (result?.ok) docs.set(doc._id, structuredClone(doc))
          return result
        },
        remove: doc => docs.delete(doc._id)
      },
      dbStorage: {
        getItem: key => local.get(key),
        setItem: (key, val) => { if (options.localError) throw new Error('本地写入失败'); local.set(key, val) },
        removeItem: key => local.delete(key)
      }
    },
    dispatchEvent: event => { events.push(event); options.onEvent?.(event, window.services) }
  }
  const childProcess = {
    execFile (bin, args, config, callback) {
      calls.push([...args])
      try {
        const output = command(args)
        callback(null, Buffer.isBuffer(output) ? output : Buffer.from(output || ''), Buffer.alloc(0))
      } catch (err) { callback(err, Buffer.alloc(0), options.stderr || Buffer.from(err.message)) }
    },
    spawn (bin, args) {
      if (options.spawnThrow) throw new Error('同步启动失败')
      const child = new EventEmitter()
      child.pid = 100 + children.length
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.bin = bin
      child.args = args
      children.push(child)
      queueMicrotask(() => {
        if (bin === 'taskkill') {
          if (options.killHandler) options.killHandler(child, children)
          else if (options.killError) child.emit('error', new Error('拒绝终止'))
          else { children[0].emit('close', 0); child.emit('close', 0) }
        } else if (options.spawnError) child.emit('error', new Error('找不到程序'))
        else child.emit('spawn')
      })
      return child
    }
  }
  vm.runInNewContext(fs.readFileSync(servicePath, 'utf8'), {
    require: name => name === 'child_process' ? childProcess : realRequire(name),
    window, Buffer, TextDecoder, URL, process: { platform: 'win32' },
    CustomEvent: class { constructor (type, init) { this.type = type; this.detail = init.detail } },
    setTimeout: (fn, delay) => { if (delay === 1000) return null; return setTimeout(fn, delay) },
    clearTimeout, console
  }, { filename: servicePath })
  return { services: window.services, window, calls, children, docs, local, events }
}

const tunnel = { tunnelId: 'test-tunnel', description: '代理目录: 示例', ports: [{ portNumber: 3000, protocol: 'auto' }] }
function creationCommand (args) {
  if (args[0] === 'list') return '[]'
  if (args[0] === 'create') return JSON.stringify(tunnel)
  if (args[0] === 'show') return JSON.stringify(tunnel)
  if (args[0] === 'port' && args[1] === 'list') return JSON.stringify(tunnel.ports)
  return ''
}

test('默认值按字段合并，保留同步快照和未知字段；仅改路径不写云端', () => {
  const env = setup()
  const original = { _id: 'devtunnel-config', _rev: '2', defaultPort: '80', defaultProtocol: 'https', defaultAnonymous: true, extra: 'preserved' }
  env.docs.set('devtunnel-config', original)
  assert.equal(env.services.saveConfig({ defaultAnonymous: false }).success, true)
  assert.deepEqual(env.docs.get('devtunnel-config'), { ...original, defaultAnonymous: false })
  const snapshot = structuredClone(env.docs.get('devtunnel-config'))
  assert.equal(env.services.saveConfig({ path: ' C:/bin/devtunnel.exe ' }).success, true)
  assert.deepEqual(env.docs.get('devtunnel-config'), snapshot)
  assert.equal(env.local.get('test-device/devtunnel-path'), 'C:/bin/devtunnel.exe')
  assert.equal(env.services.saveConfig({ defaultPort: '65535' }).success, true)
  assert.equal(env.services.getConfig().defaultProtocol, 'https')
})

test('云保存无明确成功或读取失败时，配置保存失败且本机路径不变', () => {
  for (const putResult of [null, undefined, {}, { ok: false }, { error: true, message: 'conflict' }]) {
    const env = setup(undefined, { putResult })
    env.local.set('test-device/devtunnel-path', 'old')
    assert.equal(env.services.saveConfig({ defaultPort: '80', path: 'new' }).success, false)
    assert.equal(env.local.get('test-device/devtunnel-path'), 'old')
  }
  const failed = setup(undefined, { getError: true })
  assert.equal(failed.services.saveConfig({ defaultPort: '80', path: 'new' }).success, false)
  assert.equal(failed.docs.size, 0)
  assert.equal(failed.local.has('test-device/devtunnel-path'), false)
  assert.equal(failed.services.saveConfig({ path: 'local-only' }).success, true)
})

test('配置校验拒绝非法字段及端口，不把路径或 Token 混入同步文档', async () => {
  for (const defaultPort of ['1e3', '0x50', '1.5', ' 80 ', '', null, '0', '65536']) {
    const env = setup()
    assert.equal(env.services.saveConfig({ defaultPort, path: 'new' }).success, false)
    assert.equal((await env.services.saveFrpConfig({ server: { serverPort: defaultPort, token: 'private' } })).success, false)
    assert.equal(env.docs.size, 0)
    assert.equal(env.local.size, 0)
  }
  const env = setup()
  for (const patch of [{ defaultProtocol: 'ftp' }, { defaultAnonymous: 'false' }, { path: 123 }, { unexpected: true }]) {
    assert.equal(env.services.saveConfig(patch).success, false)
  }
  assert.equal(env.services.saveFrpcPath('').success, true)
  assert.equal(env.local.get('test-device/frpc-path'), '')
  assert.equal((await env.services.saveFrpConfig({ server: { serverPort: '7000' } })).success, true)
  assert.equal((await env.services.saveFrpConfig({ server: { token: 'private' } })).success, true)
  assert.equal(env.docs.get('frp-config').server.token, undefined)
  assert.equal(env.local.get('test-device/frp-token'), 'private')
})

test('UTF-8 中文优先解码，GBK 错误仍可识别', async () => {
  const env = setup(creationCommand)
  assert.equal((await env.services.showTunnel(tunnel.tunnelId)).description, tunnel.description)
  const gbk = setup(() => { throw new Error('unused') }, { stderr: Buffer.from([0xb4, 0xed, 0xce, 0xf3]) })
  assert.match((await gbk.services.logout()).message, /错误/)
})

test('创建后详情不可用仍返回隧道 ID，而不是 null', async () => {
  const env = setup(args => {
    if (args[0] === 'show') throw new Error('读取失败')
    return creationCommand(args)
  })
  const result = await env.services.createTunnel({ port: 3000 })
  assert.equal(result?.tunnelId, tunnel.tunnelId)
  assert.equal(result.ports[0].portNumber, 3000)
})

test('添加端口失败报告部分创建结果，不擅自删除云资源', async () => {
  const env = setup(args => {
    if (args[0] === 'port' && args[1] === 'create') throw new Error('配额已满')
    return creationCommand(args)
  })
  await assert.rejects(env.services.createTunnel({ port: 3000 }), /test-tunnel.*配额已满/)
  assert.equal(env.calls.some(args => args[0] === 'delete'), false)
})

test('历史日志不能污染当前进程所属隧道 URL', async () => {
  const env = setup(creationCommand)
  env.services.getLogBuffer().push({ text: 'https://other.devtunnels.ms', time: Date.now() })
  await env.services.startHost('test-tunnel', 3000)
  await env.services.listTunnels()
  assert.equal(env.services.getTunnelUrl('test-tunnel'), '')
  env.children[0].stdout.emit('data', Buffer.from('https://test-tunnel-3000.devtunnels.ms\n'))
  assert.equal(env.services.getTunnelUrl('test-tunnel'), 'https://test-tunnel-3000.devtunnels.ms')
  env.children[0].emit('close', 0)
})

test('Host spawn 后由后端设置归属，退出事件读取到已停止状态', async () => {
  const env = setup()
  const starting = env.services.startHost('test-tunnel', 3000)
  const result = await starting
  assert.equal(result.success, true)
  assert.equal(env.window.__runningTunnelId, 'test-tunnel')
  assert.equal(env.events.some(e => e.type === 'tunnel-host-status' && e.detail.running), true)
  env.children[0].emit('close', 0)
  assert.equal(env.services.getHostStatus().running, false)
  assert.equal(env.window.__runningTunnelId, null)
  assert.equal(env.events.filter(e => e.type === 'tunnel-host-status').at(-1).detail.running, false)
})

test('spawn 异步失败不会返回伪成功', async () => {
  const env = setup(undefined, { spawnError: true })
  const result = await env.services.startHost('test-tunnel', 3000)
  assert.equal(result.success, false)
  assert.match(result.message, /找不到程序/)
  assert.equal(env.services.getHostStatus().running, false)
})

test('停止失败保留真实运行状态与 URL', async () => {
  const env = setup(undefined, { killError: true })
  await env.services.startHost('test-tunnel', 3000)
  env.children[0].stdout.emit('data', Buffer.from('https://test-tunnel.devtunnels.ms\n'))
  assert.equal((await env.services.stopHost()).success, false)
  assert.equal(env.services.getHostStatus().running, true)
  assert.equal(env.window.__runningTunnelId, 'test-tunnel')
  assert.ok(env.services.getTunnelUrl('test-tunnel'))
  env.children[0].emit('close', 0)
})

test('停止成功必须等待 close，旧进程重复事件不影响新进程', async () => {
  const env = setup()
  await env.services.startHost('test-tunnel', 3000)
  const stopping = env.services.stopHost()
  assert.equal(env.services.getHostStatus().running, true)
  assert.equal((await stopping).success, true)
  await env.services.startHost('next-tunnel', 4000)
  env.children[0].emit('close', 0)
  assert.equal(env.window.__runningTunnelId, 'next-tunnel')
  env.children[2].emit('close', 0)
})

test('保存配置检查 DB 返回错误；本地写失败不可伪成功', async () => {
  const conflict = setup(undefined, { putResult: { error: true, message: 'conflict' } })
  assert.equal(conflict.services.saveConfig({ defaultPort: '80' }).success, false)
  assert.equal((await conflict.services.saveFrpConfig({ server: {}, proxies: [] })).success, false)
  const failed = setup(undefined, { localError: true })
  assert.equal(failed.services.saveFrpcPath('/frpc').success, false)
})

test('云同步默认配置不被永久缓存', () => {
  const env = setup()
  env.docs.set('devtunnel-config', { defaultPort: '80' })
  assert.equal(env.services.getConfig().defaultPort, '80')
  env.docs.set('devtunnel-config', { defaultPort: '8080' })
  assert.equal(env.services.getConfig().defaultPort, '8080')
})

test('FRP 部分配置更新保留其他字段，Token 仍只存本地', async () => {
  const env = setup()
  env.docs.set('frp-config', { _id: 'frp-config', _rev: '1', server: { serverAddr: 'server', serverPort: 7000 }, proxies: [] })
  await env.services.saveFrpConfig({ proxies: [{ name: 'web' }] })
  assert.equal((await env.services.getFrpConfig()).server.serverAddr, 'server')
  await env.services.saveFrpConfig({ server: { token: 'private' } })
  assert.equal(env.local.get('test-device/frp-token'), 'private')
  assert.equal(env.docs.get('frp-config').server.token, undefined)
  assert.equal(env.docs.get('frp-config').server.serverAddr, 'server')
})

test('匿名访问撤销应覆盖端口规则，并在未知格式时拒绝继续', async () => {
  let portAllowed = true
  const env = setup(args => {
    if (args[0] === 'access' && args[1] === 'list') return args.includes('--port') && portAllowed ? '0: +Anonymous [connect]' : '[]'
    if (args[0] === 'access' && args[1] === 'delete') { portAllowed = false; return '' }
    return creationCommand(args)
  })
  await env.services.updateTunnel('test-tunnel', { anonymous: false })
  assert.equal(portAllowed, false)
  assert.ok(env.calls.some(a => a.includes('--port') && a[1] === 'delete'))
  const invalid = setup(args => args[0] === 'access' ? 'unrecognized output' : creationCommand(args))
  await assert.rejects(invalid.services.updateTunnel('test-tunnel', { anonymous: false }), /权限|访问|识别|解析/)
})

test('匿名授权创建后必须读回核验，混合 scope 不得被直接删除', async () => {
  const env = setup(args => args[0] === 'access' ? '[]' : creationCommand(args))
  await assert.rejects(env.services.updateTunnel('test-tunnel', { anonymous: true }), /匿名|访问/)
  const mixed = setup(args => args[0] === 'access' ? '0: +Anonymous [connect, host]' : creationCommand(args))
  await assert.rejects(mixed.services.updateTunnel('test-tunnel', { anonymous: false }), /scope|权限|范围/)
  assert.equal(mixed.calls.some(a => a[0] === 'access' && a[1] === 'delete'), false)
})

test('Host 关闭清理所属文件服务器，HTTP 安全修复保持有效', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-regression-'))
  const env = setup()
  t.after(() => { env.services.stopFileServer(); fs.rmSync(root, { recursive: true, force: true }) })
  fs.writeFileSync(path.join(root, 'a&b.txt'), 'ok')
  const result = await env.services.startFileServer(root, 0)
  assert.equal(result.success, true)
  const port = env.services.getFileServerStatus().port
  const request = url => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    }).on('error', reject)
  })
  assert.equal((await request('/%FF')).status, 400)
  assert.match((await request('/')).body, /a&amp;b.txt/)
  await env.services.startHost('test-tunnel', port)
  env.children[0].emit('close', 0)
  assert.equal(env.services.getFileServerStatus().running, false)
})

test('后端在所有远程写入前拒绝非法端口', async () => {
  for (const port of [0, -1, 65536, 1.5, '1e3', '0x50', null]) {
    const env = setup(creationCommand)
    await assert.rejects(env.services.createTunnel({ port }), /端口/)
    await assert.rejects(env.services.addPort('test-tunnel', port), /端口/)
    await assert.rejects(env.services.deletePort('test-tunnel', port), /端口/)
    assert.equal(env.calls.length, 0)
  }
})

test('Host 中文与 URL 跨数据块不损坏，旧进程迟到日志不覆盖新缓存', async () => {
  const env = setup()
  await env.services.startHost('test-tunnel', 3000)
  const first = env.children[0]
  for (const byte of Buffer.from('代理目录启动 https://correct.devtunnels.ms\n')) first.stdout.emit('data', Buffer.from([byte]))
  assert.equal(env.services.getTunnelUrl('test-tunnel'), 'https://correct.devtunnels.ms')
  assert.ok(env.services.getLogBuffer().some(entry => entry.text.startsWith('代理目录启动')))
  first.emit('close', 0)
  await env.services.startHost('test-tunnel', 3000)
  const second = env.children[1]
  second.stdout.emit('data', Buffer.from('https://new.devtunnels.ms\n'))
  first.stdout.emit('data', Buffer.from('https://late.devtunnels.ms\n'))
  assert.equal(env.services.getTunnelUrl('test-tunnel'), 'https://new.devtunnels.ms')
  second.emit('close', 0)
})

test('退出通知发出时进程和所属 URL 已清理', async () => {
  let atExit
  const env = setup(undefined, { onEvent: (event, services) => {
    if (event.type === 'tunnel-exit') atExit = services.getHostStatus()
  } })
  await env.services.startHost('test-tunnel', 3000)
  env.children[0].emit('close', 0)
  assert.equal(atExit.running, false)
  assert.equal(atExit.tunnelId, null)
})

test('同步和异步启动失败均清理本次文件服务器', async t => {
  for (const options of [{ spawnError: true }, { spawnThrow: true }]) {
    const env = setup(undefined, options)
    t.after(() => env.services.stopFileServer())
    const file = await env.services.startFileServer(__dirname, 0)
    assert.equal(file.success, true)
    const result = await env.services.startHost('test-tunnel', file.port)
    assert.equal(result.success, false)
    assert.equal(env.services.getFileServerStatus().running, false)
  }
})

test('启动后的信号错误不伪装成进程已经退出', async () => {
  const env = setup()
  await env.services.startHost('test-tunnel', 3000)
  env.children[0].emit('error', new Error('signal rejected'))
  assert.equal(env.services.getHostStatus().running, true)
  assert.equal((await env.services.startHost('other-tunnel', 3000)).success, false)
  env.children[0].emit('close', 0)
})

test('匿名权限逐端口查询；删除上级授权后重新读取端口索引并保留用户规则', async () => {
  let parent = true
  const own = ['+Users someone [connect]', '+Anonymous [connect]']
  const env = setup(args => {
    if (args[0] !== 'access') return creationCommand(args)
    const offset = args.indexOf('--port')
    if (offset !== -1) assert.equal(args[offset + 1], '3000')
    if (args[1] === 'list') {
      const entries = offset === -1 ? (parent ? ['+Anonymous [connect]'] : []) : [...(parent ? ['+Anonymous [connect] (inherited)'] : []), ...own]
      return entries.map((entry, index) => index + ': ' + entry).join('\n') || '[]'
    }
    if (args[1] === 'delete') {
      if (offset === -1) parent = false
      else own.splice(Number(args[args.indexOf('--index') + 1]), 1)
    }
    return ''
  })
  await env.services.updateTunnel('test-tunnel', { anonymous: false })
  assert.deepEqual(own, ['+Users someone [connect]'])
})

test('开启匿名时端口拒绝规则阻止启动，撤销后的未知输出也不得通过核验', async () => {
  const denied = setup(args => args[0] === 'access' ? (args.includes('--port') ? '0: -Anonymous [connect]' : '0: +Anonymous [connect]') : creationCommand(args))
  await assert.rejects(denied.services.updateTunnel('test-tunnel', { anonymous: true }), /拒绝/)
  let deleted = false
  const unknown = setup(args => {
    if (args[0] !== 'access') return creationCommand(args)
    if (args[1] === 'delete') { deleted = true; return '' }
    return deleted ? 'unrecognized output' : '0: +Anonymous [connect]'
  })
  await assert.rejects(unknown.services.updateTunnel('test-tunnel', { anonymous: false }), /解析/)
})

test('FRP 同一快照合并并报告版本冲突，失败不能提前改动本地 Token', async () => {
  const env = setup()
  env.docs.set('frp-config', { _id: 'frp-config', _rev: '1', server: { serverAddr: 'old', serverPort: 7000 }, proxies: [{ name: 'old' }] })
  env.local.set('test-device/frp-token', 'kept')
  const db = env.window.utools.db
  const get = db.get
  let reads = 0
  db.get = id => {
    const snapshot = get(id)
    if (++reads === 1) env.docs.set(id, { ...snapshot, _rev: '2', server: { ...snapshot.server, serverAddr: 'synced' } })
    return snapshot
  }
  db.put = doc => doc._rev !== env.docs.get(doc._id)._rev ? { error: true, message: 'conflict' } : { ok: true }
  const result = await env.services.saveFrpConfig({ server: { serverPort: 7001, token: 'changed' } })
  assert.equal(result.success, false)
  assert.equal(reads, 1)
  assert.equal(env.docs.get('frp-config').server.serverAddr, 'synced')
  assert.equal(env.local.get('test-device/frp-token'), 'kept')
})

const frpServer = { serverAddr: 'example.test', serverPort: 7000 }
const proxy = (name, remotePort = 6000) => ({ name, type: 'tcp', localPort: 3000, remotePort })
async function frp (options = {}, proxies = [proxy('web')]) {
  const env = setup(undefined, options)
  env.services.getFrpcPath = () => __filename
  const result = await env.services.startFrpc(frpServer, proxies, 'frp')
  assert.equal(result.success, true)
  return env
}

test('FRP 按完整名称更新代理，中文跨块不乱码，失败原因中的名称不串用', async () => {
  const env = await frp({}, [proxy('web'), proxy('中文 [web]', 6001)])
  const child = env.children[0]
  for (const byte of Buffer.from('[中文 [web]] start proxy success\n')) child.stdout.emit('data', Buffer.from([byte]))
  assert.deepEqual(Array.from(env.services.getFrpcStatus().proxies, item => item.status), ['starting', 'running'])
  child.stdout.emit('data', Buffer.from('[web] start proxy success\n[中文 [web]] start error: conflict with [web] start proxy success\n'))
  assert.deepEqual(Array.from(env.services.getFrpcStatus().proxies, item => item.status), ['running', 'error'])
  assert.equal(env.services.getFrpcStatus().state, 'error')
  child.emit('close', 0)
})

test('FRP 停止失败后根据停止期间到达的注册结果重算状态', async () => {
  const env = await frp({ killHandler: (killer, children) => {
    children[0].stdout.emit('data', Buffer.from('[web] start proxy success\n'))
    killer.emit('error', new Error('permission denied'))
  } })
  const result = await env.services.stopFrpc('frp')
  assert.equal(result.success, false)
  assert.equal(env.services.getFrpcStatus().running, true)
  assert.equal(env.services.getFrpcStatus().state, 'running')
  assert.equal((await env.services.stopFrpc('proxydir')).success, false)
  env.children[0].emit('close', 0)
})

test('FRP 退出事件先清理状态；旧进程迟到日志和退出不影响新进程', async () => {
  let stopped
  const env = await frp({ onEvent: (event, services) => {
    if (event.type === 'frpc-exit') stopped = services.getFrpcStatus().running
  } })
  const old = env.children[0]
  old.emit('close', 0)
  assert.equal(stopped, false)
  await env.services.startFrpc(frpServer, [proxy('web')], 'frp')
  old.stdout.emit('data', Buffer.from('[web] start proxy success\n'))
  old.emit('close', 0)
  assert.equal(env.services.getFrpcStatus().proxies[0].status, 'starting')
  assert.equal(env.services.getFrpcStatus().running, true)
  env.children[1].emit('close', 0)
})

test('FRP 旧列表版本不能覆盖同步后的代理规则', async () => {
  const env = setup()
  env.docs.set('frp-config', { _id: 'frp-config', _rev: '2', server: {}, proxies: [{ name: 'synced' }] })
  const result = await env.services.saveFrpConfig({ proxies: [], expectedRevision: '1' })
  assert.equal(result.success, false)
  assert.equal(env.docs.get('frp-config').proxies[0].name, 'synced')
})

test('FRP 停止成功等到进程真实关闭，启动失败清理所属文件服务', async t => {
  const env = await frp({ killHandler: () => {} })
  const pending = env.services.stopFrpc('frp')
  assert.equal(env.services.getFrpcStatus().running, true)
  assert.equal(env.services.getFrpcStatus().state, 'stopping')
  env.children[0].emit('close', 0)
  assert.equal((await pending).success, true)
  assert.equal(env.services.getFrpcStatus().running, false)
  const failed = setup(undefined, { spawnError: true })
  failed.services.getFrpcPath = () => __filename
  t.after(() => failed.services.stopFileServer())
  assert.equal((await failed.services.startFileServer(__dirname, 0, 'frp')).success, true)
  assert.equal((await failed.services.startFrpc(frpServer, [proxy('web')], 'proxydir')).success, false)
  assert.equal(failed.services.getFileServerStatus().running, false)
})

test('停止超时会结束等待并移除监听，调用方可以重试', async () => {
  const { stopProcess } = require('../public/preload/process-utils')
  const child = new EventEmitter()
  child.pid = 1
  const result = await stopProcess(child, () => new EventEmitter(), 'win32', 5)
  assert.equal(result.success, false)
  assert.match(result.message, /超时/)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.listenerCount('error'), 0)
})
