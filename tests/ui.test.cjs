const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const sourceCache = new Map()
const tunnel = { tunnelId: 'test-tunnel', description: 'original', ports: [{ portNumber: 3000, protocol: 'http' }] }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

// A minimal hook host runs the real JSX, effects and event handlers without a DOM.
function mount (file, overrides = {}, suppliedProps = {}, environment = {}) {
  const slots = []
  const pendingEffects = []
  const listeners = new Map()
  const calls = []
  const toasts = []
  let cursor = 0
  let tree
  let disposed = false
  let stateWritesAfterUnmount = 0
  let hostRunning = false
  let hostId = null
  let hostIdWrites = 0
  let enter, out
  let blurCount = 0
  const services = {
    getTabMemory: () => 'tunnels', saveTabMemory: () => {},
    getLogBuffer: () => [], getTunnelUrl: () => '',
    getHostStatus: () => ({ running: hostRunning }),
    getTunnelWithPorts: async () => structuredClone(tunnel),
    updateTunnel: async (...args) => { calls.push(['update', ...args]); return { success: true } },
    addPort: async (...args) => { calls.push(['add', ...args]); return { success: true } },
    deletePort: async (...args) => { calls.push(['delete', ...args]); return { success: true } },
    startHost: async () => ({ success: true }), stopHost: async () => ({ success: true }),
    startFileServer: async () => ({ success: true }),
    stopFileServer: () => calls.push(['stopFileServer']),
    listTunnels: async () => { calls.push(['list']); return [structuredClone(tunnel)] },
    getLoginStatus: async () => ({ loggedIn: true }),
    ...overrides
  }
  const window = {
    services,
    utools: { onPluginEnter: cb => { enter = cb }, onPluginOut: cb => { out = cb } },
    addEventListener (name, cb) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(cb)
    },
    removeEventListener (name, cb) { listeners.get(name)?.delete(cb) }
  }
  Object.defineProperty(window, '__runningTunnelId', {
    get: () => hostId,
    set: value => { hostIdWrites++; hostId = value }
  })
  const hooks = {
    useId () { return 'test-id-' + cursor++ },
    useState (initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [slots[index].value, value => {
        if (disposed) { stateWritesAfterUnmount++; return }
        slots[index].value = typeof value === 'function' ? value(slots[index].value) : value
      }]
    },
    useRef (value) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: value }
      return slots[index]
    },
    useCallback (callback, deps) {
      const index = cursor++
      if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { value: callback, deps }
      return slots[index].value
    },
    useEffect (effect, deps) {
      const index = cursor++
      if (!slots[index] || changed(slots[index].deps, deps)) {
        const previous = slots[index]
        slots[index] = { deps, cleanup: previous?.cleanup }
        pendingEffects.push(() => {
          slots[index].cleanup?.()
          slots[index].cleanup = effect()
        })
      }
    }
  }
  const changed = (oldDeps, deps) => !oldDeps || !deps || deps.some((value, i) => !Object.is(value, oldDeps[i]))
  const h = (type, props, ...children) => ({ type, props: { ...props, children } })
  if (!sourceCache.has(file)) {
    sourceCache.set(file, transformSync(fs.readFileSync(path.join(root, file), 'utf8'), {
      loader: 'jsx', format: 'cjs', jsxFactory: 'h', jsxFragment: 'Fragment'
    }).code)
  }
  const sandbox = {
    module: { exports: {} }, exports: {}, window, h, Fragment: 'Fragment',
    document: environment.document || { activeElement: { blur: () => { blurCount++ } } },
    console, setTimeout: () => 0, clearTimeout: () => {},
    require: name => name === 'react' ? hooks : name === 'lucide-react' ? {} : { __esModule: true, default: name }
  }
  vm.runInNewContext(sourceCache.get(file), sandbox, { filename: file })
  const Component = sandbox.module.exports.default
  const props = { tunnel: structuredClone(tunnel), tunnels: [structuredClone(tunnel)], loginInfo: { loggedIn: true }, showToast: (...args) => toasts.push(args), onLogin: () => {}, ...suppliedProps }
  const api = {
    calls, toasts, window,
    render () { cursor = 0; tree = Component(props); return tree },
    effects () { while (pendingEffects.length) pendingEffects.shift()() },
    async settle () { await tick(); api.render(); api.effects(); await tick(); api.render() },
    nodes (predicate) {
      const result = []
      const visit = node => {
        if (Array.isArray(node)) return node.forEach(visit)
        if (!node || typeof node !== 'object') return
        if (predicate(node)) result.push(node)
        visit(node.props?.children)
      }
      visit(tree)
      return result
    },
    button (label) {
      const found = api.nodes(node => node.type === 'button' && (text(node) === label || node.props.title === label))[0]
      assert.ok(found, `button not found: ${label}`)
      return found
    },
    async click (label) {
      const button = api.button(label)
      assert.ok(!button.props.disabled, `button disabled: ${label}`)
      await button.props.onClick({ stopPropagation () {} })
      await api.settle()
    },
    change (type, value) {
      const input = api.nodes(node => type === 'select' ? node.type === 'select' : node.type === 'input' && node.props.type === type)[0]
      assert.ok(input, `input not found: ${type}`)
      input.props.onChange({ target: { value } })
      api.render()
    },
    async blur (type) { const input = api.field(type); await input.props.onBlur({ target: { value: input.props.value } }); await api.settle() },
    field (type) { return api.nodes(node => type === 'select' ? node.type === 'select' : node.type === 'input' && node.props.type === type)[0] },
    emit (name, detail) { for (const cb of listeners.get(name) || []) cb({ detail }) },
    setHost (running, id) { hostRunning = running; hostId = id },
    out () { out(); api.render(); api.effects() },
    get blurCount () { return blurCount },
    enter () { enter({}); api.render(); api.effects() },
    unmount () { disposed = true; for (const slot of slots) slot?.cleanup?.() },
    get lateWrites () { return stateWritesAfterUnmount },
    get hostIdWrites () { return hostIdWrites },
    get listenerCount () { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0) }
  }
  api.render()
  return api
}
function text (node) {
  if (Array.isArray(node)) return node.map(text).join('')
  if (!node || typeof node === 'boolean') return ''
  if (typeof node === 'object') return text(node.props?.children)
  return String(node).trim()
}

test('App 旧列表请求迟到时不能覆盖强制刷新结果，侧边栏返回也刷新', async () => {
  const pending = deferred()
  const updated = { ...tunnel, description: 'updated' }
  let requests = 0
  const ui = mount('src/App.jsx', { listTunnels: () => ++requests === 1 ? pending.promise : Promise.resolve([updated]) })
  ui.effects()
  ui.enter()
  const sidebar = ui.nodes(node => node.type === './Sidebar')[0]
  await ui.nodes(node => node.type === './Dashboard')[0].props.onRefresh()
  pending.resolve([tunnel])
  await ui.settle()
  assert.equal(ui.nodes(node => node.type === './Dashboard')[0].props.tunnels[0].description, 'updated')
  sidebar.props.onSelect('frp')
  ui.render()
  const frpPage = ui.nodes(node => node.type === './FrpPage')[0]
  assert.ok(frpPage)
  frpPage.props.onOpenSettings()
  ui.render()
  sidebar.props.onSelect('proxydir')
  ui.render()
  const proxyPage = ui.nodes(node => node.type === './ProxyDir')[0]
  assert.ok(proxyPage)
  proxyPage.props.onOpenSettings()
  ui.out()
  assert.equal(ui.blurCount, 1)
  sidebar.props.onSelect('devtunnel')
  await ui.settle()
  assert.equal(requests, 3)
})

test('详情保存后读取失败不会显示伪成功', async () => {
  const ui = await detail()
  let reads = 0
  ui.window.services.getTunnelWithPorts = async () => ++reads === 1 ? tunnel : null
  await ui.click('保存')
  assert.equal(ui.toasts.at(-1)[1], 'error')
  assert.match(ui.toasts.at(-1)[0], /读取最新详情失败/)
})

async function frpUi (overrides = {}) {
  const ui = mount('src/FrpPage/index.jsx', {
    getTabMemory: () => 'config',
    getFrpcStatus: () => ({ running: false }),
    getFrpConfig: async () => ({ revision: '1', server: { serverAddr: 'old.example', serverPort: 7000, token: 'old' }, proxies: [{ name: 'web', type: 'tcp', localPort: 3000, remotePort: 6000 }] }),
    getFrpcLogBuffer: () => [],
    ...overrides
  })
  ui.effects()
  await ui.settle()
  return ui
}

test('统一设置的 FRP 字段只提交本次改动，避免覆盖服务器其他字段和代理列表', async () => {
  let saved
  const ui = mount('src/Settings/FrpServerSettings.jsx', {
    getFrpConfig: async () => ({ server: { serverAddr: 'old.example', serverPort: 7000, token: 'old' } }),
    saveFrpConfig: async patch => { saved = patch; return { success: true, revision: '2' } }
  })
  ui.effects()
  await ui.settle()
  ui.change('password', 'new-token')
  await ui.blur('password')
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), { server: { token: 'new-token' } })
})

test('FRP 删除规则遇到版本冲突时保留列表并上报失败', async () => {
  let saved
  const ui = await frpUi({ saveFrpConfig: async patch => { saved = patch; return { success: false, message: 'conflict' } } })
  await ui.click('删除')
  const modal = ui.nodes(node => node.type === '../ConfirmModal')[0]
  await modal.props.onConfirm()
  await ui.settle()
  assert.equal(saved.expectedRevision, '1')
  assert.equal(ui.nodes(node => node.props?.className === 'frp-proxy-name').length, 1)
  assert.equal(ui.toasts.at(-1)[1], 'error')
})

test('FRP 来源和代理注册结果决定地址展示，停止失败保留真实运行状态', async () => {
  const runtime = { running: true, source: 'frp', state: 'starting', serverAddr: 'live.example', proxies: [{ name: 'web', type: 'tcp', localPort: 3000, remotePort: 6000, status: 'starting' }] }
  const ui = await frpUi({ getFrpcStatus: () => runtime, stopFrpc: async source => { assert.equal(source, 'frp'); return { success: false, message: 'stop denied' } } })
  assert.equal(ui.nodes(node => node.props?.className === 'frp-proxy-url').length, 0)
  runtime.state = 'running'
  runtime.proxies[0].status = 'running'
  ui.emit('frpc-status', structuredClone(runtime))
  await ui.settle()
  assert.equal(ui.nodes(node => node.props?.className === 'frp-proxy-url').length, 1)
  ui.emit('frpc-status', { running: false, source: 'proxydir' })
  await ui.settle()
  await ui.click('停止本次启动')
  assert.equal(ui.toasts.at(-1)[1], 'error')
  assert.ok(ui.button('停止本次启动'))
  assert.ok(ui.button('+ 新建代理').props.disabled)
})

test('设置字段失焦和选项变化自动保存，验证失败保留配置草稿', async () => {
  const saved = []
  const ui = mount('src/Settings/index.jsx', {
    getConfig: () => ({ path: 'C:/devtunnel.exe', defaultPort: '80', defaultProtocol: 'auto', defaultAnonymous: true }),
    getFrpcPath: () => 'C:/frpc.exe',
    saveConfig: patch => { saved.push(patch); return { success: true } },
    saveFrpcPath: value => { saved.push({ frpcPath: value }); return { success: true } }
  })
  ui.effects(); await ui.settle()
  ui.change('number', '8080'); await ui.blur('number')
  assert.deepEqual(JSON.parse(JSON.stringify(saved.at(-1))), { defaultPort: '8080' })
  const select = ui.field('select')
  select.props.onChange({ target: { value: 'https' } }); await ui.settle()
  assert.deepEqual(JSON.parse(JSON.stringify(saved.at(-1))), { defaultProtocol: 'https' })
  const path = ui.field('text')
  path.props.onChange({ target: { value: '' } }); await path.props.onBlur({ target: { value: '' } }); await ui.settle()
  assert.deepEqual(JSON.parse(JSON.stringify(saved.at(-1))), { path: '' })
  const check = ui.nodes(node => node.type === 'input' && node.props.type === 'checkbox')[0]
  check.props.onChange({ target: { checked: false } }); await ui.settle()
  assert.deepEqual(JSON.parse(JSON.stringify(saved.at(-1))), { defaultAnonymous: false })
})

test('FRP 初次加载前锁定输入，卸载后忽略迟到配置', async () => {
  const pending = deferred()
  const ui = mount('src/FrpPage/index.jsx', { getTabMemory: () => 'config', getFrpConfig: () => pending.promise, getFrpcStatus: () => ({ running: false }) })
  assert.equal(ui.button('+ 新建代理').props.disabled, true)
  ui.effects()
  ui.unmount()
  pending.resolve({ server: { serverAddr: 'late.example' } })
  await tick()
  assert.equal(ui.lateWrites, 0)
})

test('创建隧道和默认设置也拒绝科学计数法端口，保持所有入口一致', async () => {
  let writes = 0
  const create = mount('src/CreateTunnel/index.jsx', { getConfig: () => null, createTunnel: async () => { writes++ } })
  create.effects()
  create.change('number', '1e3')
  await create.nodes(node => node.type === 'form')[0].props.onSubmit({ preventDefault () {} })
  assert.equal(writes, 0)
  const settings = mount('src/Settings/index.jsx', { getConfig: () => ({ defaultPort: '80', defaultProtocol: 'auto' }), saveConfig: () => { writes++; return { success: true } } })
  settings.effects()
  await settings.settle()
  settings.change('number', '1e3')
  await settings.blur('number')
  assert.equal(writes, 0)
})
async function detail (overrides, props) {
  const ui = mount('src/TunnelDetail/index.jsx', overrides, props)
  ui.effects()
  await ui.settle()
  await ui.click('编辑')
  return ui
}

test('detail validates ports before all writes, including integer syntax and bounds', async t => {
  for (const value of ['0', '-1', '65536', '1.5', '1e3', '0x50', 'abc', ' ']) {
    await t.test(value, async () => {
      const ui = await detail()
      ui.change('number', value)
      await ui.click('保存')
      assert.equal(ui.calls.length, 0, 'invalid ports must not write descriptions or ports')
      assert.equal(ui.toasts.at(-1)[1], 'error')
    })
  }
})

test('empty description is sent as empty string; empty port preserves the configured port', async () => {
  const ui = await detail()
  ui.change('text', '')
  ui.change('number', '')
  ui.change('select', 'https')
  await ui.click('保存')
  assert.equal(ui.calls.length, 1)
  assert.equal(ui.calls[0][0], 'update')
  assert.equal(ui.calls[0][2].description, '')
})

test('new port is created before the old port is removed', async () => {
  const ui = await detail()
  ui.change('number', '65535')
  await ui.click('保存')
  assert.deepEqual(ui.calls.filter(c => c[0] !== 'update'), [
    ['add', 'test-tunnel', 65535, 'http'], ['delete', 'test-tunnel', 3000]
  ])
})

test('create failure leaves old port untouched', async () => {
  const ui = await detail({ addPort: async () => { throw new Error('create failed') } })
  ui.change('number', '4000')
  await ui.click('保存')
  assert.equal(ui.calls.some(c => c[0] === 'delete'), false)
  assert.match(ui.toasts.at(-1)[0], /create failed/)
})

test('failed old-port deletion rolls back the new port', async () => {
  const deleted = []
  const ui = await detail({ deletePort: async (_id, value) => { deleted.push(value); if (value === 3000) throw new Error('delete failed') } })
  ui.change('number', '4000')
  await ui.click('保存')
  assert.deepEqual(deleted, [3000, 4000])
  assert.match(ui.toasts.at(-1)[0], /delete failed/)
  assert.equal(ui.toasts.at(-1)[1], 'error')
})

test('failed protocol replacement restores the original protocol and reports the failure', async () => {
  const added = []
  const ui = await detail({ addPort: async (_id, value, protocol) => { added.push([value, protocol]); if (protocol === 'https') throw new Error('protocol failed') } })
  ui.change('select', 'https')
  await ui.click('保存')
  assert.deepEqual(added, [[3000, 'https'], [3000, 'http']])
  assert.match(ui.toasts.at(-1)[0], /protocol failed/)
  assert.equal(ui.toasts.at(-1)[1], 'error')
})

test('rollback errors are reported explicitly', async () => {
  const ui = await detail({ addPort: async () => { throw new Error('create failed') } })
  ui.change('select', 'https')
  await ui.click('保存')
  assert.match(ui.toasts.at(-1)[0], /恢复.*失败|回滚.*失败/)
})

test('port 1 can be created on a tunnel without configured ports', async () => {
  const empty = { ...tunnel, ports: [] }
  const ui = await detail({ getTunnelWithPorts: async () => empty })
  ui.change('number', '1')
  await ui.click('保存')
  assert.deepEqual(ui.calls.filter(c => c[0] !== 'update'), [['add', 'test-tunnel', 1, 'auto']])
})

test('same-port protocol changes rebuild the port without changing its number', async () => {
  const ui = await detail()
  ui.change('select', 'https')
  await ui.click('保存')
  assert.deepEqual(ui.calls.filter(c => c[0] !== 'update'), [
    ['delete', 'test-tunnel', 3000], ['add', 'test-tunnel', 3000, 'https']
  ])
  assert.equal(ui.toasts.at(-1)[1], 'success')
})

test('failed old-port deletion reports a failed rollback of the new port', async () => {
  const ui = await detail({ deletePort: async (_id, value) => { throw new Error(value === 3000 ? 'delete old failed' : 'rollback failed') } })
  ui.change('number', '4000')
  await ui.click('保存')
  assert.match(ui.toasts.at(-1)[0], /delete old failed.*回滚新增端口失败.*rollback failed/)
})

test('backend failure results are not mistaken for successful writes', async () => {
  const ui = await detail({ updateTunnel: async () => ({ success: false, message: 'update rejected' }) })
  ui.change('number', '4000')
  await ui.click('保存')
  assert.equal(ui.calls.length, 0, 'no port writes after a rejected description update')
  assert.match(ui.toasts.at(-1)[0], /update rejected/)
  assert.ok(ui.button('保存'), 'failed save stays in edit mode')
})

test('cancel restores description, port and protocol drafts', async () => {
  const ui = await detail()
  ui.change('text', 'draft')
  ui.change('number', '4000')
  ui.change('select', 'https')
  await ui.click('取消')
  await ui.click('编辑')
  assert.equal(ui.field('text').props.value, 'original')
  assert.equal(ui.field('number').props.value, '3000')
  assert.equal(ui.field('select').props.value, 'http')
})

test('initial loading disables editing before effects and ignores late data after unmount', async () => {
  const pending = deferred()
  const ui = mount('src/TunnelDetail/index.jsx', { getTunnelWithPorts: () => pending.promise })
  assert.equal(ui.button('编辑').props.disabled, true)
  ui.effects()
  ui.render()
  assert.equal(ui.button('编辑').props.disabled, true)
  ui.unmount()
  pending.resolve(structuredClone(tunnel))
  await tick()
  assert.equal(ui.lateWrites, 0)
  assert.equal(ui.listenerCount, 0)
})

test('saving locks fields and cancel until completion', async () => {
  const pending = deferred()
  const ui = await detail({ updateTunnel: () => pending.promise })
  const save = ui.button('保存').props.onClick()
  ui.render()
  assert.equal(ui.button('保存中...').props.disabled, true)
  assert.equal(ui.button('取消').props.disabled, true)
  for (const type of ['text', 'number', 'select']) assert.equal(ui.field(type).props.disabled, true)
  pending.resolve({ success: true })
  await save
})

test('App returning from detail forces a list reload despite recent cache', async () => {
  const ui = mount('src/App.jsx')
  ui.effects()
  ui.enter()
  await ui.settle()
  const dashboard = ui.nodes(node => node.type === './Dashboard')[0]
  dashboard.props.onSelectTunnel(structuredClone(tunnel))
  ui.render()
  const page = ui.nodes(node => node.type === './TunnelDetail')[0]
  const before = ui.calls.filter(c => c[0] === 'list').length
  await page.props.onBack()
  await ui.settle()
  assert.equal(ui.calls.filter(c => c[0] === 'list').length, before + 1)
  assert.equal(typeof ui.window.onerror, 'function', 'keep existing global error handler')
})

for (const file of ['src/Dashboard/index.jsx', 'src/TunnelDetail/index.jsx']) {
  test(`${file}: status events synchronize backend state without renderer global writes`, async () => {
    const ui = mount(file)
    ui.effects()
    await ui.settle()
    ui.setHost(true, 'test-tunnel')
    ui.emit('tunnel-host-status')
    ui.render()
    assert.ok(ui.button('停止'))
    ui.setHost(false, null)
    ui.emit('tunnel-host-status')
    ui.emit('tunnel-exit', 0)
    ui.render()
    assert.ok(ui.button('启动'))
    assert.equal(ui.hostIdWrites, 0)
    ui.unmount()
    assert.equal(ui.listenerCount, 0)
  })

  test(`${file}: start awaits promise, reads latest tunnel and does not claim success on failure`, async () => {
    const pending = deferred()
    const started = []
    const latest = { ...tunnel, anonymous: true, ports: [{ portNumber: 4321, protocol: 'http' }] }
    const ui = mount(file, {
      getTunnelWithPorts: async () => latest,
      startHost: (...args) => { started.push(args); return pending.promise }
    })
    ui.effects()
    await ui.settle()
    const action = ui.button('启动').props.onClick({ stopPropagation () {} })
    await tick()
    assert.deepEqual(started, [['test-tunnel', 4321]])
    assert.equal(ui.toasts.length, 0, 'pending start must not show failure or success')
    pending.resolve({ success: false, message: 'spawn failed' })
    await action
    assert.match(ui.toasts.at(-1)[0], /spawn failed/)
    assert.equal(ui.hostIdWrites, 0)
  })

  test(`${file}: successful start follows backend state and uses latest directory metadata`, async () => {
    const pending = deferred()
    const fileStarts = []
    const latest = { ...tunnel, description: '代理目录: C:/latest', ports: [{ portNumber: 4321, protocol: 'http' }] }
    const ui = mount(file, {
      getTunnelWithPorts: async () => latest,
      startFileServer: async (...args) => { fileStarts.push(args); return { success: true } },
      startHost: () => pending.promise
    })
    ui.effects()
    await ui.settle()
    const action = ui.button('启动').props.onClick({ stopPropagation () {} })
    await tick()
    assert.deepEqual(fileStarts, [['C:/latest', 4321]])
    ui.setHost(true, 'test-tunnel')
    pending.resolve({ success: true })
    await action
    ui.render()
    assert.ok(ui.button('停止'))
    assert.equal(ui.hostIdWrites, 0)
  })

  test(`${file}: failed directory start does not clean unrelated file servers in renderer`, async () => {
    const latest = { ...tunnel, description: '代理目录: C:/latest' }
    const ui = mount(file, {
      getTunnelWithPorts: async () => latest,
      startHost: async () => ({ success: false, message: 'already running' })
    })
    ui.effects()
    await ui.settle()
    await ui.click('启动')
    assert.equal(ui.calls.some(c => c[0] === 'stopFileServer'), false)
    assert.match(ui.toasts.at(-1)[0], /already running/)
  })

  test(`${file}: stop waits for backend and never stops file server early`, async () => {
    const pending = deferred()
    const directoryTunnel = { ...tunnel, description: '代理目录: C:/shared' }
    const ui = mount(file, { stopHost: () => pending.promise }, { tunnel: directoryTunnel, tunnels: [directoryTunnel] })
    ui.setHost(true, 'test-tunnel')
    ui.render()
    ui.effects()
    await ui.settle()
    ui.emit('tunnel-host-status')
    ui.render()
    const action = ui.button('停止').props.onClick({ stopPropagation () {} })
    await tick()
    assert.equal(ui.toasts.length, 0)
    assert.equal(ui.calls.some(c => c[0] === 'stopFileServer'), false)
    ui.setHost(false, null)
    pending.resolve({ success: true })
    await action
    ui.render()
    assert.ok(ui.button('启动'))
    assert.equal(ui.hostIdWrites, 0)
  })
}


for (const file of ['src/Dashboard/index.jsx', 'src/TunnelDetail/index.jsx']) {
  test(file + ': 启动前详情读取失败或无端口时拒绝旧配置，避免分享历史目录', async () => {
    for (const getTunnelWithPorts of [async () => null, async () => { throw new Error('offline') }, async () => ({ ...tunnel, ports: [] })]) {
      const starts = []
      const directory = { ...tunnel, description: '代理目录: C:/old' }
      const ui = mount(file, {
        getTunnelWithPorts,
        startFileServer: async () => { starts.push('file'); return { success: true } },
        startHost: async () => { starts.push('host'); return { success: true } }
      }, { tunnel: directory, tunnels: [directory] })
      ui.effects(); await ui.settle(); await ui.click('启动')
      assert.equal(starts.length, 0)
      assert.equal(ui.toasts.at(-1)[1], 'error')
    }
  })

  test(file + ': 持续日志限制为最新 500 条', async () => {
    const ui = mount(file)
    ui.effects(); await ui.settle()
    for (let i = 0; i < 1500; i++) ui.emit('tunnel-log-entry', { text: String(i), time: Date.now() })
    ui.render()
    if (file.includes('Dashboard')) {
      ui.nodes(node => node.type === 'button' && node.props.className?.startsWith('tab-item'))[1].props.onClick()
      await ui.settle()
    }
    assert.equal(ui.nodes(node => node.props.className?.startsWith('log-line ')).length, 500)
  })
}

test('App 刷新失败保留已加载列表，并报告失败', async () => {
  let reads = 0
  const ui = mount('src/App.jsx', { listTunnels: async () => { if (++reads > 1) throw new Error('offline'); return [tunnel] } })
  ui.effects(); ui.enter(); await ui.settle()
  await ui.nodes(node => node.type === './Dashboard')[0].props.onRefresh()
  await ui.settle()
  assert.equal(ui.nodes(node => node.type === './Dashboard')[0].props.tunnels.length, 1)
  assert.ok(ui.nodes(node => node.props.className === 'toast toast-error').length)
})

test('设置页不会把清除失败显示为成功', async () => {
  const ui = mount('src/Settings/index.jsx', {
    getConfig: () => ({ path: '', defaultPort: '80', defaultProtocol: 'auto', defaultAnonymous: true }),
    getFrpcPath: () => '', clearAllData: () => ({ success: false, message: '部分数据未清除：conflict' })
  })
  ui.effects(); await ui.settle(); await ui.click('清除所有数据')
  await ui.nodes(node => node.type === '../ConfirmModal')[0].props.onConfirm()
  await ui.settle()
  assert.equal(ui.toasts.at(-1)[1], 'error')
  assert.match(ui.toasts.at(-1)[0], /conflict/)
})

test('FRP 启动前重读服务器配置，代理版本变化时先刷新供用户确认', async () => {
  let revision = '1'
  const starts = []
  const ui = await frpUi({
    getFrpConfig: async () => ({ revision, server: { serverAddr: revision === '1' ? 'old.example' : 'new.example', serverPort: 7000 }, proxies: [{ name: 'web', type: 'tcp', localPort: 3000, remotePort: 6000 }] }),
    startFrpc: async (...args) => { starts.push(args); return { success: true } }
  })
  ui.nodes(node => node.type === 'input' && node.props['aria-label'] === '选择代理 web')[0].props.onChange({ target: { checked: true } })
  await ui.settle()
  revision = '2'
  await ui.click('启动选中 (1)')
  assert.equal(starts.length, 0)
  assert.match(ui.toasts.at(-1)[0], /同步更新/)
  await ui.click('启动选中 (1)')
  assert.equal(starts[0][0].serverAddr, 'new.example')
})

test('确认框支持焦点循环、Escape、恢复焦点和待处理状态防重入', async () => {
  let keydown, restored = 0, cancelled = 0, confirmed = 0
  const document = {
    activeElement: { isConnected: true, focus: () => { restored++ } },
    addEventListener: (_name, callback) => { keydown = callback },
    removeEventListener: () => { keydown = null }
  }
  const pending = deferred()
  const ui = mount('src/ConfirmModal/index.jsx', {}, {
    title: '删除配置', message: '确认删除', danger: true,
    onCancel: () => { cancelled++ }, onConfirm: async () => { confirmed++; await pending.promise }
  }, { document })
  const buttons = [{ focus () { document.activeElement = this } }, { focus () { document.activeElement = this } }]
  const dialog = ui.nodes(node => node.props.role === 'dialog')[0]
  dialog.props.ref.current = { querySelector: () => buttons[0], querySelectorAll: () => buttons, contains: value => buttons.includes(value) }
  ui.effects()
  assert.equal(document.activeElement, buttons[0])
  keydown({ key: 'Tab', shiftKey: true, preventDefault () {} })
  assert.equal(document.activeElement, buttons[1])
  keydown({ key: 'Tab', shiftKey: false, preventDefault () {} })
  assert.equal(document.activeElement, buttons[0])
  keydown({ key: 'Escape', preventDefault () {} })
  assert.equal(cancelled, 1)
  const confirm = ui.button('确定').props.onClick
  const first = confirm(), second = confirm()
  ui.render()
  keydown({ key: 'Escape', preventDefault () {} })
  assert.equal(cancelled, 1)
  assert.equal(confirmed, 1)
  assert.equal(ui.button('处理中…').props.disabled, true)
  pending.resolve(); await Promise.all([first, second])
  ui.unmount()
  assert.equal(restored, 1)
  assert.equal(keydown, null)
})
