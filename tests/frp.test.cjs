const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { isPort, validateServer, validateProxies, generateFrpcConfig } = require('../public/preload/frp')

const server = { serverAddr: 'example.com', serverPort: '7000', token: 'private-token' }
const tcp = (name, remotePort = 6000) => ({ name, type: 'tcp', localPort: 3000, remotePort })

test('端口必须为范围内的整数，本地端口允许复用', () => {
  for (const port of ['', 0, -1, 65536, 1.5, '80abc', '1e3']) assert.equal(isPort(port), false)
  for (const port of [1, 65535, '3000']) assert.equal(isPort(port), true)
  assert.equal(validateProxies([tcp('web'), tcp('api', 6001)], server), '')
  assert.match(validateProxies([tcp('web', 65536)], server), /远程端口/)
  assert.match(validateServer({ ...server, serverPort: '7000oops' }), /服务器端口/)
})

test('阻止代理名称、远程端口、规范化域名重复和服务器监听端口冲突', () => {
  assert.match(validateProxies([tcp('web'), tcp('web', 6001)], server), /名称.*已存在/)
  assert.match(validateProxies([tcp('web'), tcp('api', '06000')], server), /6000.*web/)
  assert.match(validateProxies([tcp('web', 7000)], server), /监听端口冲突/)
  const http = (name, customDomain) => ({ name, type: 'http', localPort: 3000, customDomain })
  assert.match(validateProxies([http('a', 'EXAMPLE.com.'), http('b', 'example.com')], server), /域名.*已被/)
  assert.match(validateProxies([http('a', 'http://example.com')], server), /有效域名/)
})

test('TOML 转义名称和 Token，拒绝非法配置', () => {
  const output = generateFrpcConfig({ ...server, token: 'secret"\nserverPort = 1' }, [tcp('web"')])
  assert.ok(output.includes('auth.token = "secret\\"\\nserverPort = 1"'))
  assert.ok(output.includes('name = "web\\""'))
  assert.throws(() => generateFrpcConfig(server, [tcp('a'), tcp('b')]), /已被/)
})

function controller () {
  const children = []
  const events = []
  const logs = []
  const fakeSpawn = (executable, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 100 + children.length
    child.args = args
    child.executable = executable
    child.kill = () => { child.emit('close', 0); return true }
    children.push(child)
    process.nextTick(() => child.emit('spawn'))
    return child
  }
  const context = {
    require: name => name === 'child_process' ? { spawn: fakeSpawn } : require(name),
    module: { exports: {} },
    process,
    setTimeout,
    clearTimeout
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/preload/frp.js'), 'utf8'), context)
  const service = context.module.exports.createFrpcController({
    getFrpcPath: () => __filename,
    addFrpcLog: (...args) => logs.push(args),
    emitEvent: (type, detail, source) => events.push({ type, detail, source })
  })
  const close = () => { for (const child of children) if (child.executable !== 'taskkill') child.emit('close', 0) }
  return { service, children, events, logs, close }
}

test('等待各代理注册成功，处理跨数据块日志、失败原因和来源', async t => {
  const { service, children, events, logs, close } = controller()
  t.after(close)
  assert.equal((await service.startFrpc(server, [tcp('web'), tcp('api', 6001)], 'frp')).success, true)
  assert.equal(service.getFrpcStatus().proxies[0].status, 'starting')
  children[0].stdout.emit('data', Buffer.from('[web] start pro'))
  assert.equal(service.getFrpcStatus().proxies[0].status, 'starting')
  children[0].stdout.emit('data', Buffer.from('xy success\n[api] start error: port already used private-token\n'))
  const state = service.getFrpcStatus()
  assert.equal(state.state, 'error')
  assert.equal(state.proxies[0].status, 'running')
  assert.equal(state.proxies[1].status, 'error')
  assert.match(state.proxies[1].message, /port already used/)
  assert.ok(!JSON.stringify(state).includes(server.token))
  assert.ok(!JSON.stringify(logs).includes(server.token))
  assert.ok(events.filter(e => e.type === 'frpc-status').every(e => e.source === 'frp'))
  state.proxies[0].status = 'modified'
  assert.equal(service.getFrpcStatus().proxies[0].status, 'running')
})

test('重复启动和错误页面停止均被拒绝，真实退出后才释放进程', async t => {
  const { service, children, close } = controller()
  t.after(close)
  await service.startFrpc(server, [tcp('web')], 'proxydir')
  assert.match((await service.startFrpc(server, [tcp('api')], 'frp')).message, /代理目录/)
  assert.equal((await service.stopFrpc('frp')).success, false)
  assert.equal(service.getFrpcStatus().running, true)
  const stop = service.stopFrpc('proxydir')
  if (process.platform === 'win32') {
    assert.equal(service.getFrpcStatus().state, 'stopping')
    children[0].emit('close', 0)
  }
  assert.equal((await stop).success, true)
  assert.equal(service.getFrpcStatus().running, false)
})

test('启动前校验且错误进程的迟到退出不会覆盖新进程状态', async t => {
  const { service, children, close } = controller()
  t.after(close)
  assert.equal((await service.startFrpc(server, [tcp('a'), tcp('b')])).success, false)
  assert.equal(children.length, 0)
  const failedStart = service.startFrpc(server, [tcp('a')])
  const configPath = children[0].args[1]
  children[0].emit('error', new Error('ENOENT'))
  assert.equal((await failedStart).success, false)
  assert.equal(fs.existsSync(configPath), false)
  await service.startFrpc(server, [tcp('b')])
  children[0].emit('close', -1)
  assert.equal(service.getFrpcStatus().running, true)
  assert.equal(service.getFrpcStatus().proxies[0].name, 'b')
})

test('中文名称跨 UTF-8 数据块仍能识别注册成功', async t => {
  const { service, children, close } = controller()
  t.after(close)
  await service.startFrpc(server, [tcp('测试代理')])
  const output = Buffer.from('[测试代理] start proxy success\n')
  children[0].stdout.emit('data', output.subarray(0, 3))
  children[0].stdout.emit('data', output.subarray(3))
  assert.equal(service.getFrpcStatus().proxies[0].status, 'running')
})

test('带方括号的代理名称只更新精确匹配的代理', async t => {
  const { service, children, close } = controller()
  t.after(close)
  await service.startFrpc(server, [tcp('web'), tcp('api[web]', 6001)])
  children[0].stdout.emit('data', Buffer.from('[2026-10-26] [I] [proxy/proxy.go:120] [session] [api[web]] start proxy success\n'))
  assert.equal(service.getFrpcStatus().proxies[0].status, 'starting')
  assert.equal(service.getFrpcStatus().proxies[1].status, 'running')
  assert.equal(service.getFrpcStatus().state, 'starting')
  children[0].stdout.emit('data', Buffer.from('[web] start proxy success\n[api[web]] start error: registration failed for [web]\n'))
  assert.equal(service.getFrpcStatus().proxies[0].status, 'running')
  assert.equal(service.getFrpcStatus().proxies[0].message, '')
  assert.equal(service.getFrpcStatus().proxies[1].status, 'error')
  assert.equal(service.getFrpcStatus().proxies[1].message, 'registration failed for [web]')
})

test('停止失败后按等待期间到达的注册结果恢复整体状态', async t => {
  for (const expected of ['running', 'error']) {
    await t.test(expected, async t => {
      const { service, children, close } = controller()
      t.after(close)
      await service.startFrpc(server, [tcp('web')])
      if (expected === 'error') children[0].stdout.emit('data', Buffer.from('[web] start proxy success\n'))
      const output = expected === 'running' ? '[web] start proxy success\n' : '[web] start error: registration rejected\n'
      children[0].kill = () => {
        children[0].stdout.emit('data', Buffer.from(output))
        throw new Error('permission denied')
      }
      const stop = service.stopFrpc('frp')
      if (process.platform === 'win32') {
        children[0].stdout.emit('data', Buffer.from(output))
        children[1].emit('error', new Error('permission denied'))
      }
      assert.equal((await stop).success, false)
      const status = service.getFrpcStatus()
      assert.equal(status.running, true)
      assert.equal(status.proxies[0].status, expected)
      assert.equal(status.state, expected)
    })
  }
})

test('停止命令失败时保留运行状态，不允许启动新进程', async t => {
  const { service, children, close } = controller()
  t.after(close)
  await service.startFrpc(server, [tcp('web')])
  children[0].kill = () => { throw new Error('permission denied') }
  const stop = service.stopFrpc('frp')
  if (process.platform === 'win32') children[1].emit('error', new Error('permission denied'))
  assert.equal((await stop).success, false)
  assert.equal(service.getFrpcStatus().running, true)
  assert.equal(service.getFrpcStatus().state, 'starting')
  assert.equal((await service.startFrpc(server, [tcp('new')])).success, false)
})
