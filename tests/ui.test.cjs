const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

// Run the actual JSX with deterministic hooks, without requiring uTools or a DOM.
function mount (file, services, props = {}) {
  const slots = []
  const pendingEffects = []
  const imports = new Map()
  const events = new EventTarget()
  const notices = []
  let cursor = 0
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const hooks = {
    useState (initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef (value) {
      const index = cursor++
      return slots[index] || (slots[index] = { current: value })
    },
    useCallback (fn, deps) {
      const index = cursor++
      if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { fn, deps }
      return slots[index].fn
    },
    useEffect (fn, deps) {
      const index = cursor++
      if (!slots[index] || !same(slots[index].deps, deps)) {
        const previous = slots[index]
        slots[index] = { deps }
        pendingEffects.push(() => {
          previous?.cleanup?.()
          slots[index].cleanup = fn()
        })
      }
    }
  }
  const jsx = (type, props) => ({ type, props: props || {} })
  const window = {
    services,
    __runningTunnelId: null,
    utools: { onPluginEnter (fn) { this.enter = fn }, onPluginOut () {} },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events)
  }
  const module = { exports: {} }
  const requireStub = name => {
    if (name === 'react') return hooks
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
    if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => key })
    if (name.endsWith('.css')) return {}
    if (!imports.has(name)) imports.set(name, Object.assign(() => null, { source: name }))
    return imports.get(name)
  }
  const code = transformSync(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code
  vm.runInNewContext(code, {
    module, exports: module.exports, require: requireStub, window, document: {}, console,
    setTimeout: () => 0, clearTimeout () {}
  })
  const componentProps = { showToast: (...args) => notices.push(args), onBack () {}, ...props }
  return {
    window,
    notices,
    render () {
      cursor = 0
      const tree = module.exports.default(componentProps)
      pendingEffects.splice(0).forEach(effect => effect())
      return tree
    },
    unmount () { slots.forEach(slot => slot?.cleanup?.()) },
    emit (type, detail) {
      const event = new Event(type)
      event.detail = detail
      window.dispatchEvent(event)
    }
  }
}

function nodes (tree, predicate, found = []) {
  if (Array.isArray(tree)) tree.forEach(child => nodes(child, predicate, found))
  else if (tree && typeof tree === 'object') {
    if (predicate(tree)) found.push(tree)
    nodes(tree.props?.children, predicate, found)
  }
  return found
}
const text = node => node == null ? '' : typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props?.children) : String(node)
const button = (tree, label) => nodes(tree, node => node.type === 'button' && text(node).trim() === label)[0]
const field = (tree, type) => nodes(tree, node => node.type === 'input' && node.props.type === type)[0]
const component = (tree, source) => nodes(tree, node => node.type?.source === source)[0]
async function flush () { for (let index = 0; index < 20; index++) await Promise.resolve() }
function deferred () { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const original = () => ({ tunnelId: 't1', description: 'original', ports: [{ portNumber: 3000, protocol: 'auto' }] })

function detailFixture (overrides = {}) {
  let tunnel = original()
  const writes = []
  const services = {
    getHostStatus: () => ({ running: false }),
    getTunnelUrl: () => '',
    getLogBuffer: () => [],
    getTunnelWithPorts: async () => structuredClone(tunnel),
    updateTunnel: async (id, patch) => {
      writes.push(['update', patch.description])
      if (patch.description !== undefined) tunnel.description = patch.description
    },
    addPort: async (id, port, protocol) => {
      writes.push(['add', port, protocol])
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port')
      if (tunnel.ports.some(item => item.portNumber === port)) throw new Error('port exists')
      tunnel.ports.push({ portNumber: port, protocol })
    },
    deletePort: async (id, port) => {
      writes.push(['delete', port])
      tunnel.ports = tunnel.ports.filter(item => item.portNumber !== port)
    },
    ...overrides
  }
  const app = mount('src/TunnelDetail/index.jsx', services, { tunnel: original() })
  return { app, services, writes, get tunnel () { return tunnel } }
}
async function editDetail (fixture) {
  fixture.app.render()
  await flush()
  const tree = fixture.app.render()
  assert.equal(Boolean(button(tree, '编辑').props.disabled), false)
  button(tree, '编辑').props.onClick()
  return fixture.app.render()
}
async function saveDetail (fixture) {
  await button(fixture.app.render(), '保存').props.onClick()
  await flush()
  return fixture.app.render()
}

test('详情严格验证端口后才执行任何写入', async t => {
  for (const value of ['', '-1', '65536', '1.5', '1e3', '80abc']) {
    await t.test(value || 'empty', async () => {
      const fixture = detailFixture()
      field(await editDetail(fixture), 'number').props.onChange({ target: { value } })
      await saveDetail(fixture)
      assert.deepEqual(fixture.writes, [])
      assert.equal(fixture.tunnel.ports[0].portNumber, 3000)
      assert.ok(fixture.app.notices.some(([message, type]) => type === 'error' && /端口/.test(message)))
    })
  }
})

test('更换端口先添加新端口，再删除原端口', async () => {
  const fixture = detailFixture()
  field(await editDetail(fixture), 'number').props.onChange({ target: { value: '4000' } })
  await saveDetail(fixture)
  assert.deepEqual(fixture.writes.filter(([kind]) => kind !== 'update'), [['add', 4000, 'auto'], ['delete', 3000]])
  assert.deepEqual(fixture.tunnel.ports, [{ portNumber: 4000, protocol: 'auto' }])
})

test('添加新端口失败不删除原端口、不修改描述', async () => {
  const fixture = detailFixture({ addPort: async () => { throw new Error('cannot add') } })
  field(await editDetail(fixture), 'number').props.onChange({ target: { value: '4000' } })
  await saveDetail(fixture)
  assert.deepEqual(fixture.writes, [])
  assert.deepEqual(fixture.tunnel, original())
})

test('删除原端口失败时撤回新端口并保留原配置', async () => {
  const fixture = detailFixture()
  const remove = fixture.services.deletePort
  fixture.services.deletePort = async (id, port) => {
    if (port === 3000) throw new Error('cannot delete original')
    return remove(id, port)
  }
  field(await editDetail(fixture), 'number').props.onChange({ target: { value: '4000' } })
  await saveDetail(fixture)
  assert.deepEqual(fixture.tunnel, original())
  assert.ok(fixture.app.notices.some(([message, type]) => type === 'error' && /cannot delete original/.test(message)))
})

test('相同端口更改协议失败时恢复原协议', async () => {
  const fixture = detailFixture()
  const add = fixture.services.addPort
  fixture.services.addPort = async (id, port, protocol) => {
    if (protocol === 'https') throw new Error('cannot change protocol')
    return add(id, port, protocol)
  }
  const tree = await editDetail(fixture)
  nodes(tree, node => node.type === 'select')[0].props.onChange({ target: { value: 'https' } })
  await saveDetail(fixture)
  assert.deepEqual(fixture.tunnel, original())
})

test('回滚失败明确报告且不伪装保存成功', async () => {
  const fixture = detailFixture()
  fixture.services.addPort = async (id, port, protocol) => {
    if (protocol === 'https') throw new Error('cannot change protocol')
    throw new Error('cannot restore original')
  }
  const tree = await editDetail(fixture)
  nodes(tree, node => node.type === 'select')[0].props.onChange({ target: { value: 'https' } })
  await saveDetail(fixture)
  assert.ok(fixture.app.notices.some(([message, type]) => type === 'error' && /cannot change protocol/.test(message) && /cannot restore original/.test(message)))
  assert.equal(fixture.app.notices.some(([, type]) => type === 'success'), false)
})

test('读取当前配置失败不写入任何元数据或端口', async () => {
  const fixture = detailFixture()
  field(await editDetail(fixture), 'number').props.onChange({ target: { value: '4000' } })
  fixture.services.getTunnelWithPorts = async () => null
  await saveDetail(fixture)
  assert.deepEqual(fixture.writes, [])
  assert.equal(fixture.app.notices.some(([, type]) => type === 'success'), false)
})

test('清空描述传递空字符串并持久化', async () => {
  const fixture = detailFixture()
  field(await editDetail(fixture), 'text').props.onChange({ target: { value: '' } })
  await saveDetail(fixture)
  assert.equal(fixture.tunnel.description, '')
  assert.deepEqual(fixture.writes, [['update', '']])
})

test('取消编辑后再次编辑恢复已保存的字段', async () => {
  const fixture = detailFixture()
  let tree = await editDetail(fixture)
  field(tree, 'number').props.onChange({ target: { value: '4000' } })
  field(tree, 'text').props.onChange({ target: { value: 'cancelled' } })
  nodes(tree, node => node.type === 'select')[0].props.onChange({ target: { value: 'https' } })
  button(fixture.app.render(), '取消').props.onClick()
  button(fixture.app.render(), '编辑').props.onClick()
  tree = fixture.app.render()
  assert.equal(field(tree, 'number').props.value, '3000')
  assert.equal(field(tree, 'text').props.value, 'original')
  assert.equal(nodes(tree, node => node.type === 'select')[0].props.value, 'auto')
})

test('初始详情加载完成前禁用编辑，卸载后忽略迟到响应', async () => {
  const request = deferred()
  const fixture = detailFixture({ getTunnelWithPorts: () => request.promise })
  fixture.app.render()
  assert.equal(button(fixture.app.render(), '编辑').props.disabled, true)
  fixture.app.unmount()
  request.resolve({ ...original(), description: 'late' })
  await flush()
  assert.equal(button(fixture.app.render(), '编辑').props.disabled, true)
})

test('详情返回列表强制刷新最新端口和描述', async () => {
  let tunnel = original()
  let requests = 0
  const app = mount('src/App.jsx', {
    getLoginStatus: async () => ({ loggedIn: true }),
    listTunnels: async () => { requests++; return [structuredClone(tunnel)] }
  })
  app.render()
  app.window.utools.enter()
  await flush()
  component(app.render(), './Dashboard').props.onSelectTunnel(tunnel)
  tunnel = { ...tunnel, description: 'updated', ports: [{ portNumber: 4000, protocol: 'http' }] }
  component(app.render(), './TunnelDetail').props.onBack()
  await flush()
  assert.equal(requests, 2)
  assert.deepEqual(component(app.render(), './Dashboard').props.tunnels[0], tunnel)
})

for (const page of ['Dashboard', 'TunnelDetail']) {
  test(page + ' 监听跨页启动/退出并以真实 host 状态为准，卸载取消订阅', async () => {
    let running = false
    let reads = 0
    const tunnel = original()
    const app = mount('src/' + page + '/index.jsx', {
      getHostStatus: () => { reads++; return { running } },
      getTunnelWithPorts: async () => tunnel,
      getTunnelUrl: () => '',
      getLogBuffer: () => [],
      getTabMemory: () => '',
      saveTabMemory () {}
    }, { tunnels: [tunnel], tunnel, loginInfo: { loggedIn: true }, onLogin () {} })
    app.render()
    await flush()
    app.render()
    running = true
    app.window.__runningTunnelId = 't1'
    app.emit('tunnel-host-status', { running: true })
    let tree = app.render()
    const stopButtons = () => page === 'Dashboard' ? nodes(tree, node => node.type === 'button' && node.props.title === '停止') : [button(tree, '停止')].filter(Boolean)
    assert.equal(stopButtons().length, 1)
    running = false
    app.window.__runningTunnelId = null
    app.emit('tunnel-host-status', { running: false })
    tree = app.render()
    assert.equal(stopButtons().length, 0)
    app.unmount()
    const before = reads
    app.emit('tunnel-host-status', { running: true })
    assert.equal(reads, before)
  })
}

function proxyFixture (tunnel, overrides = {}) {
  const calls = []
  let hostRunning = false
  const services = {
    getProxyDirSettings: () => ({ dirPath: 'C:/shared', port: '4000', allowAnonymous: false }),
    getProxyDirLastTunnel: () => null,
    getFrpConfig: async () => ({ server: { serverAddr: 'example.com', serverPort: '7000' } }),
    getFileServerStatus: () => ({ running: false }),
    getHostStatus: () => ({ running: hostRunning }),
    getFrpcStatus: () => ({ running: false, proxies: [] }),
    getLogBuffer: () => [],
    listTunnels: async () => [tunnel],
    updateTunnel: async (id, patch) => { calls.push(['update', id, { ...patch }]) },
    addPort: async (id, port) => { calls.push(['add', port]) },
    deletePort: async (id, port) => { calls.push(['delete', port]) },
    startFileServer: async () => ({ success: true }),
    stopFileServer: () => { calls.push(['stopFile']); return { success: true } },
    startHost: async (id, port) => { hostRunning = true; app.window.__runningTunnelId = id; calls.push(['startHost', id, port]); return { success: true } },
    stopHost: async () => { hostRunning = false; return { success: true } },
    stopFrpc: async () => { calls.push(['stopFrpc']); return { success: true } },
    ...overrides
  }
  const app = mount('src/ProxyDir/index.jsx', services)
  return { app, calls, services }
}
async function startProxy (fixture) {
  fixture.app.render()
  await flush()
  const pending = button(fixture.app.render(), '启动代理').props.onClick()
  return { pending }
}
const directoryTunnel = port => ({ tunnelId: 't1', description: '代理目录: C:/shared', ports: [{ portNumber: port, protocol: 'auto' }] })

test('目录代理复用前同步匿名权限；权限更新失败不得启动', async () => {
  const fixture = proxyFixture(directoryTunnel(4000))
  await (await startProxy(fixture)).pending
  assert.deepEqual(fixture.calls.find(([kind]) => kind === 'update'), ['update', 't1', { anonymous: false }])
  assert.equal(fixture.calls.some(([kind]) => kind === 'startHost'), true)
  const failed = proxyFixture(directoryTunnel(4000), { updateTunnel: async () => { throw new Error('access rejected') } })
  await (await startProxy(failed)).pending
  assert.equal(failed.calls.some(([kind]) => kind === 'startHost'), false)
  assert.equal(failed.calls.some(([kind]) => kind === 'stopFile'), true)
  assert.match(text(failed.app.render()), /access rejected/)
})

test('目录代理端口更新失败保留旧端口并停止启动流程', async () => {
  const fixture = proxyFixture(directoryTunnel(3000), { addPort: async () => { throw new Error('add rejected') } })
  await (await startProxy(fixture)).pending
  await component(fixture.app.render(), '../ConfirmModal').props.onConfirm()
  assert.equal(fixture.calls.some(([kind]) => kind === 'delete' || kind === 'startHost'), false)
  assert.equal(fixture.calls.some(([kind]) => kind === 'stopFile'), true)
  assert.match(text(fixture.app.render()), /add rejected/)
})

test('目录代理删除旧端口失败时撤回新端口，不继续启动', async () => {
  const fixture = proxyFixture(directoryTunnel(3000))
  const remove = fixture.services.deletePort
  fixture.services.deletePort = async (id, port) => {
    if (port === 3000) throw new Error('delete rejected')
    return remove(id, port)
  }
  await (await startProxy(fixture)).pending
  await component(fixture.app.render(), '../ConfirmModal').props.onConfirm()
  assert.deepEqual(fixture.calls.filter(([kind]) => kind === 'add' || kind === 'delete'), [['add', 4000], ['delete', 4000]])
  assert.equal(fixture.calls.some(([kind]) => kind === 'startHost'), false)
})

test('目录代理描述更新失败不会误报启动成功', async () => {
  const fixture = proxyFixture({ ...directoryTunnel(4000), description: '代理目录: C:/other' }, { updateTunnel: async () => { throw new Error('description rejected') } })
  await (await startProxy(fixture)).pending
  await component(fixture.app.render(), '../ConfirmModal').props.onConfirm()
  assert.equal(fixture.calls.some(([kind]) => kind === 'startHost'), false)
  assert.match(text(fixture.app.render()), /description rejected/)
})

test('代理目录页面接收跨页完成的启动，只显示所属隧道 URL', async () => {
  let started = false
  const fixture = proxyFixture(directoryTunnel(4000), {
    getFileServerStatus: () => ({ running: started, mode: 'devtunnel', dir: 'C:/shared', port: 4000 }),
    getHostStatus: () => ({ running: started }),
    getTunnelUrl: () => ''
  })
  fixture.app.render()
  await flush()
  fixture.app.render()
  started = true
  fixture.app.window.__runningTunnelId = 't1'
  fixture.app.emit('tunnel-host-status', { running: true, tunnelId: 't1' })
  fixture.app.render()
  fixture.app.emit('tunnel-url', { tunnelId: 't1', url: 'https://correct.devtunnels.ms' })
  assert.ok(button(fixture.app.render(), '停止代理'))
  assert.match(text(fixture.app.render()), /correct\.devtunnels/)
  fixture.app.emit('tunnel-url', { tunnelId: 'other', url: 'https://wrong.devtunnels.ms' })
  assert.equal(text(fixture.app.render()).includes('wrong.devtunnels'), false)
})

test('代理目录页面接收跨页完成的 FRP 启动，停止使用实际后端', async () => {
  let started = false
  const fixture = proxyFixture(directoryTunnel(4000), {
    getFileServerStatus: () => ({ running: started, mode: 'frp', dir: 'C:/shared', port: 4000 })
  })
  fixture.app.render()
  await flush()
  fixture.app.render()
  started = true
  fixture.app.emit('frpc-status', { running: true, source: 'proxydir', state: 'running', serverAddr: 'example.com', proxies: [{ status: 'running', type: 'tcp', remotePort: 8080 }] })
  await button(fixture.app.render(), '停止代理').props.onClick()
  assert.equal(fixture.calls.some(([kind]) => kind === 'stopFrpc'), true)
})

test('启动检查期间及旧 host 退出后保持模式和配置锁定', async () => {
  const request = deferred()
  const fixture = proxyFixture(directoryTunnel(4000), { listTunnels: () => request.promise })
  const { pending } = await startProxy(fixture)
  const assertLocked = () => {
    const tree = fixture.app.render()
    assert.equal(nodes(tree, node => node.type === 'button' && node.props.className?.startsWith('mode-option')).every(node => node.props.disabled), true)
    assert.equal(field(tree, 'number').props.disabled, true)
    assert.equal(field(tree, 'checkbox').props.disabled, true)
  }
  assertLocked()
  fixture.app.emit('tunnel-exit', 0)
  assertLocked()
  request.resolve([directoryTunnel(4000)])
  await pending
  await button(fixture.app.render(), '停止代理').props.onClick()
  assert.equal(fixture.calls.some(([kind]) => kind === 'stopFrpc'), false)
})

test('强制刷新后的列表不会被较早请求的迟到响应覆盖', async () => {
  const oldRequest = deferred()
  const updated = { ...original(), description: 'updated' }
  let requests = 0
  const app = mount('src/App.jsx', {
    getLoginStatus: async () => ({ loggedIn: true }),
    listTunnels: () => ++requests === 1 ? oldRequest.promise : Promise.resolve([updated])
  })
  app.render()
  app.window.utools.enter()
  await component(app.render(), './Dashboard').props.onRefresh()
  oldRequest.resolve([original()])
  await flush()
  assert.deepEqual(component(app.render(), './Dashboard').props.tunnels[0], updated)
})

test('从侧边栏返回隧道列表也强制刷新详情修改后的配置', async () => {
  let tunnel = original()
  let requests = 0
  const app = mount('src/App.jsx', {
    getLoginStatus: async () => ({ loggedIn: true }),
    listTunnels: async () => { requests++; return [structuredClone(tunnel)] }
  })
  app.render()
  app.window.utools.enter()
  await flush()
  component(app.render(), './Dashboard').props.onSelectTunnel(tunnel)
  tunnel = { ...tunnel, description: 'updated' }
  component(app.render(), './Sidebar').props.onSelect('devtunnel')
  await flush()
  assert.equal(requests, 2)
  assert.deepEqual(component(app.render(), './Dashboard').props.tunnels[0], tunnel)
})

test('详情保存期间禁用字段，避免保存响应覆盖新输入', async () => {
  const fixture = detailFixture()
  await editDetail(fixture)
  const request = deferred()
  fixture.services.getTunnelWithPorts = () => request.promise
  const pending = button(fixture.app.render(), '保存').props.onClick()
  const tree = fixture.app.render()
  assert.ok(nodes(tree, node => ['input', 'select'].includes(node.type)).every(node => node.props.disabled))
  assert.equal(button(tree, '取消').props.disabled, true)
  request.resolve(original())
  await pending
})

test('新建目录隧道也必须在启动前核验匿名权限，核验失败清理文件服务', async () => {
  const fixture = proxyFixture(null, {
    listTunnels: async () => [],
    createTunnel: async () => directoryTunnel(4000),
    updateTunnel: async () => { throw new Error('verification failed') }
  })
  await (await startProxy(fixture)).pending
  assert.equal(fixture.calls.some(([kind]) => kind === 'startHost'), false)
  assert.equal(fixture.calls.some(([kind]) => kind === 'stopFile'), true)
  assert.match(text(fixture.app.render()), /verification failed/)
})

test('端口替换完成后再核验最终端口上的匿名权限', async () => {
  const fixture = proxyFixture(directoryTunnel(3000))
  await (await startProxy(fixture)).pending
  await component(fixture.app.render(), '../ConfirmModal').props.onConfirm()
  assert.deepEqual(fixture.calls.filter(([kind]) => ['add', 'delete', 'update', 'startHost'].includes(kind)).map(([kind]) => kind), ['add', 'delete', 'update', 'startHost'])
})

test('FRP 文件服务先启动、frpc 尚未启动时重新进入页面仍使用 FRP 停止', async () => {
  let hostStops = 0
  const fixture = proxyFixture(directoryTunnel(4000), {
    getFileServerStatus: () => ({ running: true, mode: 'frp', port: 4000, dir: 'C:/actual' }),
    getHostStatus: () => ({ running: true }),
    stopHost: async () => { hostStops++; return { success: true } }
  })
  fixture.app.render()
  await flush()
  const tree = fixture.app.render()
  assert.match(text(tree), /C:\/actual/)
  await button(tree, '停止代理').props.onClick()
  assert.equal(hostStops, 0)
  assert.equal(fixture.calls.some(([kind]) => kind === 'stopFrpc'), true)
})

test('跨页启动状态与 URL 在同一轮事件到达时不会因旧模式丢失 URL', async () => {
  let started = false
  const fixture = proxyFixture(directoryTunnel(4000), {
    getProxyDirSettings: () => ({ mode: 'frp' }),
    getFileServerStatus: () => ({ running: started, mode: 'devtunnel', port: 4000, dir: 'C:/shared' }),
    getHostStatus: () => ({ running: started }),
    getTunnelUrl: () => ''
  })
  fixture.app.render()
  await flush()
  fixture.app.render()
  started = true
  fixture.app.window.__runningTunnelId = 't1'
  fixture.app.emit('tunnel-host-status', { running: true, tunnelId: 't1' })
  fixture.app.emit('tunnel-url', { tunnelId: 't1', url: 'https://correct.devtunnels.ms' })
  assert.match(text(fixture.app.render()), /correct\.devtunnels/)
})
