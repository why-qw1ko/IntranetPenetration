const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const source = transformSync(fs.readFileSync(path.resolve(__dirname, '../../src/ProxyDir/index.jsx'), 'utf8'), {
  loader: 'jsx', format: 'cjs', jsxFactory: 'h', jsxFragment: 'Fragment'
}).code
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
function text (node) {
  if (Array.isArray(node)) return node.map(text).join('')
  if (node == null || typeof node === 'boolean') return ''
  return typeof node === 'object' ? text(node.props?.children) : String(node)
}
function mount (overrides = {}, settings = {}) {
  const slots = [], effects = [], listeners = new Map(), calls = [], toasts = []
  let cursor = 0, tree, host = { running: false }, file = { running: false }, frpc = { running: false }, idWrites = 0
  let savedSettings = { dirPath: 'C:/files', port: '3000', ...settings }
  let savedFrpSettings = null
  const services = {
    getProxyDirSettings: () => savedSettings,
    saveProxyDirSettings: value => { savedSettings = value },
    getHostStatus: () => host, getFileServerStatus: () => file, getFrpcStatus: () => frpc,
    getFrpConfig: async () => ({ server: { serverAddr: 'example.test', serverPort: 7000 } }),
    getProxyDirFrpSettings: () => savedFrpSettings, saveProxyDirFrpSettings: value => { savedFrpSettings = value },
    getTunnelUrl: () => '', getLogBuffer: () => [],
    listTunnels: async () => [],
    getTunnelWithPorts: async id => (await services.listTunnels()).find(tunnel => tunnel.tunnelId === id) || null,
    validateFileServerDirectory: async () => ({ success: true }),
    generateFrpcConfig: require('../../public/preload/frp').generateFrpcConfig,
    createTunnel: async options => { calls.push(['create', options]); return { tunnelId: 'new' } },
    updateTunnel: async (...args) => { calls.push(['update', ...args]); return { success: true } },
    addPort: async (...args) => { calls.push(['add', ...args]); return { success: true } },
    deletePort: async (...args) => { calls.push(['delete', ...args]); return { success: true } },
    startFileServer: async (dir, port, mode = 'devtunnel') => { calls.push(['file', dir, port, mode]); file = { running: true, dir, port, mode }; return { success: true } },
    stopFileServer: mode => { calls.push(['stopFile', mode]); if (file.mode === mode) file = { running: false } },
    startHost: async tunnelId => { calls.push(['startHost', tunnelId]); host = { running: true, tunnelId, pid: 1 }; return { success: true } },
    stopHost: async () => { calls.push(['stopHost']); host = { running: false }; file = { running: false }; return { success: true } },
    startFrpc: async (...args) => { calls.push(['startFrpc', ...args]); frpc = { running: true, source: 'proxydir' }; return { success: true } },
    stopFrpc: async () => { calls.push(['stopFrpc']); frpc = { running: false }; file = { running: false }; return { success: true } },
    ...overrides
  }
  const window = {
    services,
    addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn)
  }
  Object.defineProperty(window, '__runningTunnelId', { get: () => host.tunnelId, set: () => { idWrites++ } })
  const changed = (a, b) => !a || !b || b.some((v, i) => !Object.is(v, a[i]))
  const hooks = {
    useState (initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: initial }; return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value }] },
    useRef (value) { const i = cursor++; if (!(i in slots)) slots[i] = { current: value }; return slots[i] },
    useCallback (fn, deps) { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { value: fn, deps }; return slots[i].value },
    useEffect (fn, deps) { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) { const old = slots[i]; slots[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn() }) } }
  }
  const sandbox = {
    module: { exports: {} }, window, console, setTimeout: () => 0, clearTimeout: () => {},
    h: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: 'Fragment',
    require: name => name === 'react' ? hooks : name === 'lucide-react' ? {} : { __esModule: true, default: name }
  }
  vm.runInNewContext(source, sandbox)
  const Component = sandbox.module.exports.default
  const props = { showToast: (...args) => toasts.push(args), onToggleSidebar: () => {} }
  const api = {
    calls, toasts, services,
    render () { cursor = 0; tree = Component(props); return tree },
    effects () { while (effects.length) effects.shift()() },
    async settle () { await tick(); api.render(); api.effects(); await tick(); api.render() },
    nodes (predicate) { const found = []; const visit = n => { if (Array.isArray(n)) return n.forEach(visit); if (!n || typeof n !== 'object') return; if (predicate(n)) found.push(n); visit(n.props?.children) }; visit(tree); return found },
    button (label) { const n = api.nodes(n => n.type === 'button' && text(n).includes(label))[0]; assert.ok(n, `button missing: ${label}`); return n },
    input (placeholder) { const n = api.nodes(n => n.type === 'input' && (n.props.placeholder === placeholder || (placeholder === '端口号' && n.props.className?.includes('port-input'))))[0]; assert.ok(n, `input missing: ${placeholder}`); return n },
    async click (label) { const n = api.button(label); assert.ok(!n.props.disabled, `disabled: ${label}`); await n.props.onClick(); await api.settle() },
    change (placeholder, value) { const n = api.nodes(n => n.type === 'input' && (n.props.placeholder === placeholder || n.props.type === placeholder || (placeholder === 'number' && n.props.className?.includes('port-input'))))[0]; assert.ok(n); n.props.onChange({ target: { value } }); api.render(); api.effects() },
    blur (placeholder) { const n = api.nodes(n => n.type === 'input' && (n.props.placeholder === placeholder || n.props.type === placeholder || (placeholder === '端口号' && n.props.className?.includes('port-input'))))[0]; assert.ok(n); n.props.onBlur({ target: { value: n.props.value } }); api.render(); api.effects() },
    modal () { return api.nodes(n => n.type === '../ConfirmModal')[0] },
    emit (name, detail) { for (const fn of listeners.get(name) || []) fn({ detail }) },
    setStatus (next) { if (next.host) host = next.host; if (next.file) file = next.file; if (next.frpc) frpc = next.frpc },
    get text () { return text(tree) }, get idWrites () { return idWrites },
    get savedSettings () { return savedSettings }, get savedFrpSettings () { return savedFrpSettings },
    async setMode (value) {
      const label = value === 'frp' ? 'Frp（自建服务器）' : 'DevTunnel（免费）'
      const button = api.button(label)
      assert.ok(!button.props.disabled, `disabled: ${label}`)
      await button.props.onClick()
      api.render(); api.effects()
    },
    unmount () { for (const slot of slots) slot?.cleanup?.() }
  }
  api.render(); api.effects()
  return api
}
module.exports = { mount, deferred, tick }
