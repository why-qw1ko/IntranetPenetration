const test = require('node:test')
const assert = require('node:assert/strict')
const { mount, deferred, tick } = require('./helpers/proxydir-ui.cjs')
const existing = (port = 3000, description = '代理目录: C:/files') => ({ tunnelId: 'existing', description, ports: [{ portNumber: port }] })
async function ready (overrides, settings) { const ui = mount(overrides, settings); await ui.settle(); return ui }
async function confirm (ui) { const modal = ui.modal(); assert.ok(modal); await modal.props.onConfirm(); await ui.settle() }

test('目录设置通过失焦和选项变更保存并在重挂载后恢复', async () => {
  const ui = await ready({}, { dirPath: 'C:/initial', port: '3000', mode: 'devtunnel', allowAnonymous: true })
  ui.change('text', 'C:/manual')
  ui.blur('选择或输入要分享的本地目录路径')
  assert.equal(ui.savedSettings.dirPath, 'C:/manual')
  ui.change('number', '8080')
  ui.blur('端口号')
  assert.equal(ui.savedSettings.port, '8080')
  await ui.setMode('frp')
  assert.equal(ui.savedSettings.mode, 'frp')
  assert.equal(ui.savedSettings.mode, 'frp')
  const restored = await ready({}, ui.savedSettings)
  assert.equal(restored.input('选择或输入要分享的本地目录路径').props.value, 'C:/manual')
  assert.equal(restored.input('端口号').props.value, '8080')
})

test('FRP 启动使用最新服务器快照，读取失败时不触碰现有服务', async t => {
  await t.test('uses the startup snapshot', async () => {
    let reads = 0
    let started
    const ui = await ready({
      getFrpConfig: async () => ({ server: { serverAddr: ++reads === 1 ? 'old.example' : 'new.example', serverPort: reads === 1 ? 7000 : 8000 } }),
      startFrpc: async (...args) => { started = args; return { success: true } }
    }, { mode: 'frp' })
    await ui.click('启动代理')
    assert.equal(started[0].serverAddr, 'new.example')
    assert.equal(started[0].serverPort, 8000)
  })
  await t.test('does not stop or start anything after a failed preflight', async () => {
    let reads = 0
    const ui = await ready({
      getFrpConfig: async () => { if (++reads === 1) return { server: { serverAddr: 'cached.example' } }; throw new Error('read denied') }
    }, { mode: 'frp' })
    await ui.click('启动代理')
    assert.equal(ui.calls.some(call => ['stopHost', 'stopFrpc', 'file', 'startFrpc'].includes(call[0])), false)
    assert.match(ui.text, /read denied/)
  })
})

test('invalid numeric syntax is rejected before any start or tunnel write', async t => {
  for (const port of ['1e3', '0x50', '1.5', ' 3000 ', '0', '65536', '-1', '']) {
    await t.test(JSON.stringify(port), async () => {
      const ui = await ready({}, { port })
      await ui.click('启动代理')
      assert.equal(ui.calls.length, 0)
      assert.match(ui.text, /有效端口/)
    })
  }
})

test('same tick double start is serialized and pending fields/modes are disabled', async () => {
  const wait = deferred()
  let listed = 0
  const ui = await ready({ listTunnels: () => { listed++; return wait.promise } })
  const start = ui.button('启动代理').props.onClick
  const first = start(), second = start()
  await tick()
  ui.render()
  assert.equal(listed, 1)
  assert.ok(ui.button('Frp（自建服务器）').props.disabled)
  assert.ok(ui.nodes(n => n.type === 'input').every(n => n.props.disabled))
  ui.emit('tunnel-exit', { tunnelId: 'old' })
  ui.render()
  assert.ok(ui.button('启动中').props.disabled, 'old process exit cannot unlock pending start')
  wait.resolve([])
  await Promise.all([first, second]); await ui.settle()
  assert.equal(ui.calls.filter(c => c[0] === 'startHost').length, 1)
})

test('await stopHost before local server and await host startup before success', async () => {
  const stop = deferred(), start = deferred()
  let stopped = false
  const ui = await ready({
    getHostStatus: () => ({ running: !stopped, tunnelId: 'other' }),
    stopHost: () => stop.promise,
    startHost: () => start.promise
  })
  const pending = ui.button('启动代理').props.onClick()
  await tick()
  assert.equal(ui.calls.some(c => c[0] === 'file'), false)
  stopped = true; stop.resolve({ success: true }); await tick(); ui.render()
  assert.ok(ui.button('启动中').props.disabled)
  assert.equal(ui.text.includes('停止代理'), false)
  start.resolve({ success: true }); await pending; await ui.settle()
  assert.ok(ui.button('停止代理'))
  assert.equal(ui.idWrites, 0)
})

test('stop failure aborts startup and does not clean up another running file server', async () => {
  const ui = await ready({ getHostStatus: () => ({ running: true, tunnelId: 'other' }), stopHost: async () => ({ success: false, message: 'stop denied' }) })
  await ui.click('启动代理')
  assert.equal(ui.calls.length, 0)
  assert.match(ui.text, /stop denied/)
})

test('same-directory port replacement adds before deleting and rolls back on deletion failure', async () => {
  const deleted = []
  const ui = await ready({
    listTunnels: async () => [existing(2000)],
    deletePort: async (_id, port) => { deleted.push(port); if (port === 2000) throw new Error('delete denied'); return { success: true } }
  })
  await ui.click('启动代理')
  assert.ok(ui.button('Frp（自建服务器）').props.disabled)
  assert.ok(ui.button('启动代理').props.disabled)
  await confirm(ui)
  assert.deepEqual(deleted, [2000, 3000])
  assert.equal(ui.calls.some(c => c[0] === 'startHost'), false)
  assert.match(ui.text, /delete denied/)
  assert.ok(!ui.button('启动代理').props.disabled)
})

test('failed add does not delete old port and never starts host', async () => {
  const ui = await ready({ listTunnels: async () => [existing(2000)], addPort: async () => { throw new Error('add denied') } })
  await ui.click('启动代理'); await confirm(ui)
  assert.equal(ui.calls.some(c => c[0] === 'delete' || c[0] === 'startHost'), false)
  assert.match(ui.text, /add denied/)
})

test('reuse permission and description failures do not start hosting', async t => {
  for (const description of ['代理目录: C:/files', 'other directory']) {
    await t.test(description, async () => {
      const ui = await ready({ listTunnels: async () => [existing(3000, description)], updateTunnel: async () => { throw new Error('policy denied') } })
      await ui.click('启动代理')
      if (ui.modal()) await confirm(ui)
      assert.equal(ui.calls.some(c => c[0] === 'startHost'), false)
      assert.match(ui.text, /policy denied/)
    })
  }
})

test('current tunnel URL only; never restore an address from historical logs', async () => {
  const ui = await ready({ getLogBuffer: () => [{ text: 'https://stale.devtunnels.ms' }] })
  ui.setStatus({ host: { running: true, tunnelId: 'current' }, file: { running: true, port: 3000, dir: 'C:/files', mode: 'devtunnel' } })
  ui.emit('tunnel-host-status', { running: true, tunnelId: 'current' }); await ui.settle()
  assert.ok(ui.button('停止代理'))
  assert.doesNotMatch(ui.text, /stale/)
  ui.emit('tunnel-url', { tunnelId: 'other', url: 'https://wrong.devtunnels.ms' }); await ui.settle()
  assert.doesNotMatch(ui.text, /wrong/)
  ui.emit('tunnel-url', { tunnelId: 'current', url: 'https://current.devtunnels.ms' }); await ui.settle()
  assert.match(ui.text, /https:\/\/current.devtunnels.ms/)
  ui.emit('frpc-exit', { source: 'frp' }); ui.emit('tunnel-exit', { tunnelId: 'other' }); await ui.settle()
  assert.ok(ui.button('停止代理'))
})

test('fresh mount restores only matching tunnel cache, not history', async () => {
  const ui = await ready({
    getHostStatus: () => ({ running: true, tunnelId: 'current' }),
    getFileServerStatus: () => ({ running: true, port: 4000, dir: 'C:/actual', mode: 'devtunnel' }),
    getLogBuffer: () => [{ text: 'https://stale.devtunnels.ms' }],
    getTunnelUrl: id => id === 'current' ? 'https://cached.devtunnels.ms' : ''
  })
  assert.match(ui.text, /C:\/actual/)
  assert.match(ui.text, /cached/)
  assert.doesNotMatch(ui.text, /stale/)
})

test('stop waits for captured running backend, keeps failure visible while running', async () => {
  const stop = deferred()
  const ui = await ready({ stopFrpc: () => stop.promise })
  ui.setStatus({ frpc: { running: true, source: 'proxydir' }, file: { running: true, dir: 'C:/actual', port: 3000, mode: 'frp' } })
  ui.emit('frpc-status', { running: true, source: 'proxydir' }); await ui.settle()
  const first = ui.button('停止代理').props.onClick()
  const second = ui.button('停止代理').props.onClick()
  ui.render()
  assert.ok(ui.button('停止代理').props.disabled)
  assert.equal(ui.calls.some(c => c[0] === 'stopFile'), false)
  stop.resolve({ success: false, message: 'cannot stop' })
  await Promise.all([first, second]); await ui.settle()
  assert.ok(ui.button('停止代理'))
  assert.match(ui.text, /cannot stop/)
  assert.equal(ui.calls.some(c => c[0] === 'stopHost'), false)
})

test('frpc events require proxydir source and running errors remain visible', async () => {
  const ui = await ready({}, { mode: 'frp' })
  await ui.click('启动代理')
  ui.emit('frpc-error', { source: 'frp', message: 'unrelated' }); await ui.settle()
  assert.doesNotMatch(ui.text, /unrelated/)
  ui.emit('frpc-error', { source: 'proxydir', message: 'runtime failure' }); await ui.settle()
  assert.match(ui.text, /runtime failure/)
  assert.ok(ui.button('停止代理'))
})

test('canceling confirmation releases the operation lock', async () => {
  const ui = await ready({ listTunnels: async () => [existing(2000)] })
  await ui.click('启动代理')
  ui.modal().props.onCancel(); await ui.settle()
  assert.ok(!ui.button('启动代理').props.disabled)
  await ui.click('启动代理')
  assert.ok(ui.modal())
})

test('new tunnel permission verification failure aborts startup and permits retry', async () => {
  let failures = 1
  const ui = await ready({ updateTunnel: async () => { if (failures--) throw new Error('verification failed'); return { success: true } } })
  await ui.click('启动代理')
  assert.equal(ui.calls.some(call => call[0] === 'startHost'), false)
  assert.match(ui.text, /verification failed/)
  assert.equal(ui.button('启动代理').props.disabled, false)
})

test('existing tunnel policy failure releases the confirmation operation lock', async () => {
  const ui = await ready({ listTunnels: async () => [existing(3000, 'other directory')], updateTunnel: async () => { throw new Error('policy denied') } })
  await ui.click('启动代理')
  await confirm(ui)
  assert.equal(ui.button('启动代理').props.disabled, false)
  await ui.click('启动代理')
  assert.ok(ui.modal())
})

test('FRP mount restores actual backend and never reuses saved URL before registration', async () => {
  let frpStops = 0
  let hostStops = 0
  const ui = await ready({
    getFrpcStatus: () => ({ running: true, source: 'proxydir', state: 'starting', proxies: [] }),
    getFileServerStatus: () => ({ running: true, mode: 'frp', port: 4000, dir: 'C:/actual' }),
    getProxyDirFrpSettings: () => ({ url: 'https://stale.example' }),
    stopFrpc: async () => { frpStops++; return { success: true } },
    stopHost: async () => { hostStops++; return { success: true } }
  })
  assert.doesNotMatch(ui.text, /stale\.example/)
  assert.match(ui.text, /C:\/actual/)
  await ui.click('停止代理')
  assert.equal(frpStops, 1)
  assert.equal(hostStops, 0)
})

test('ordinary DevTunnel host events cannot replace an active FRP directory service', async () => {
  const ui = await ready({}, { mode: 'frp' })
  ui.setStatus({ file: { running: true, mode: 'frp', port: 4000, dir: 'C:/frp' }, host: { running: true, tunnelId: 'unrelated' } })
  ui.emit('frpc-status', { running: true, source: 'proxydir', state: 'starting', proxies: [] })
  ui.emit('tunnel-host-status', { running: true, tunnelId: 'unrelated' })
  await ui.settle()
  await ui.click('停止代理')
  assert.equal(ui.calls.some(call => call[0] === 'stopHost'), false)
})

test('取消复用确认保留当前运行的隧道和文件服务', async () => {
  const ui = await ready({ listTunnels: async () => [existing(2000)] })
  ui.setStatus({ host: { running: true, tunnelId: 'working' } })
  await ui.click('启动代理')
  assert.ok(ui.modal())
  assert.equal(ui.calls.some(call => call[0] === 'stopHost'), false)
  ui.modal().props.onCancel()
  await ui.settle()
  assert.equal(ui.services.getHostStatus().running, true)
  assert.equal(ui.calls.length, 0)
})

test('目录或隧道列表预检失败不停止旧进程、不创建资源', async () => {
  for (const overrides of [
    { listTunnels: async () => { throw new Error('list unavailable') } },
    { validateFileServerDirectory: async () => ({ success: false, message: 'directory unavailable' }) }
  ]) {
    const ui = await ready(overrides)
    ui.setStatus({ host: { running: true, tunnelId: 'working' } })
    await ui.click('启动代理')
    assert.equal(ui.calls.length, 0)
    assert.match(ui.text, /unavailable/)
  }
})

test('复用确认期间隧道配置发生变化时中止，保留原运行进程', async () => {
  const ui = await ready({ listTunnels: async () => [existing(2000)], getTunnelWithPorts: async () => existing(4000) })
  ui.setStatus({ host: { running: true, tunnelId: 'working' } })
  await ui.click('启动代理')
  await confirm(ui)
  assert.equal(ui.calls.length, 0)
  assert.match(ui.text, /配置已变化/)
})

test('FRP 配置冲突和目录校验失败都不能停止当前 DevTunnel', async () => {
  for (const overrides of [
    { getProxyDirFrpSettings: () => ({ remotePort: '7000' }) },
    { validateFileServerDirectory: async () => ({ success: false, message: 'directory unavailable' }) }
  ]) {
    const ui = await ready(overrides, { mode: 'frp' })
    ui.setStatus({ host: { running: true, tunnelId: 'working' } })
    await ui.click('启动代理')
    assert.equal(ui.calls.length, 0)
    assert.match(ui.text, /冲突|unavailable/)
  }
})

test('FRP 预检遇到其他页面的进程时，不误显示为目录代理运行中', async () => {
  const ui = await ready({ getFrpcStatus: () => ({ running: true, source: 'frp' }) }, { mode: 'frp' })
  await ui.click('启动代理')
  assert.equal(ui.calls.length, 0)
  assert.ok(ui.button('启动代理'))
  assert.match(ui.text, /frpc 已在运行/)
})

test('FRP 目录恢复和事件更新均生成带 HTTP 协议的 URL，支持 IPv6', async () => {
  const runtime = { running: true, state: 'running', source: 'proxydir', serverAddr: '2001:db8::1', proxies: [{ name: 'directory', type: 'tcp', remotePort: 8080, status: 'running' }] }
  const ui = await ready({ getFrpcStatus: () => runtime })
  assert.match(ui.text, /http:\/\/\[2001:db8::1\]:8080/)
  ui.emit('frpc-status', { ...runtime, serverAddr: 'example.com' })
  await ui.settle()
  assert.match(ui.text, /http:\/\/example.com:8080/)
})
