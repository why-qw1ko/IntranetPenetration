const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const createStorage = require('../public/preload/storage')

function database () {
  const values = new Map()
  const docs = new Map()
  const utools = {
    getNativeId: () => 'device-a',
    dbStorage: {
      getItem: key => values.get(key),
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    },
    db: {
      get: id => docs.has(id) ? structuredClone(docs.get(id)) : null,
      put: doc => { docs.set(doc._id, structuredClone(doc)); return { ok: true } },
      remove: doc => docs.delete(doc._id)
    }
  }
  return { values, docs, utools }
}

test('同账号的两台电脑各自保留可执行文件路径', () => {
  const { utools } = database()
  const first = createStorage(utools)
  const second = createStorage({ ...utools, getNativeId: () => 'device-b' })
  first.setLocal('frpc-path', 'C:/first/frpc.exe')
  second.setLocal('frpc-path', 'D:/second/frpc.exe')
  assert.equal(first.getLocal('frpc-path'), 'C:/first/frpc.exe')
  assert.equal(second.getLocal('frpc-path'), 'D:/second/frpc.exe')
})

test('迁移有效旧路径，拒绝其他设备的失效路径，不覆盖本机设置', () => {
  const { utools, values } = database()
  const storage = createStorage(utools)
  values.set('frpc-path', path.join(__dirname, 'nonexistent-frpc.exe'))
  assert.equal(storage.getLocal('frpc-path', ''), '')
  values.set('frpc-path', __filename)
  assert.equal(storage.getLocal('frpc-path'), __filename)
  values.set('frpc-path', 'D:/other.exe')
  assert.equal(storage.getLocal('frpc-path'), __filename)
})

test('本机写入和同步文档失败必须上报', () => {
  const { utools } = database()
  const storage = createStorage(utools)
  utools.dbStorage.setItem = () => { throw new Error('disk full') }
  assert.throws(() => storage.setLocal('frpc-path', 'test'), /disk full/)
  utools.db.put = () => ({ error: true, message: 'conflict' })
  assert.throws(() => storage.putDocument('frp-config', {}), /conflict/)
})

function services () {
  const db = database()
  const storage = createStorage(db.utools)
  const context = {
    require: name => name === './storage' ? () => storage : name === './frp' ? require('../public/preload/frp') : require(name),
    window: { utools: db.utools, dispatchEvent () {} },
    setTimeout,
    clearTimeout,
    TextDecoder,
    Buffer,
    process
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/preload/services.js'), 'utf8'), context)
  return { ...db, api: context.window.services }
}

test('默认值同步更新立即可见，按字段保存保留其他设置', () => {
  const { api, docs } = services()
  assert.equal(api.saveConfig({ defaultPort: '3000', defaultAnonymous: false }).success, true)
  assert.equal(api.saveConfig({ path: 'C:/local/devtunnel.exe' }).success, true)
  assert.equal(api.getConfig().defaultAnonymous, false)
  docs.set('devtunnel-config', { _id: 'devtunnel-config', defaultPort: '9000' })
  assert.equal(api.getConfig().defaultPort, '9000')
  assert.equal(api.getConfig().path, 'C:/local/devtunnel.exe')
  assert.equal(docs.get('devtunnel-config').path, undefined)
  assert.equal(api.saveConfig({ defaultPort: '1.5' }).success, false)
})

test('FRP 服务器与规则独立保存，不丢 Token，不覆盖代理列表', async () => {
  const { api } = services()
  await api.saveFrpConfig({ server: { serverAddr: 'example.com', token: 'test-token' } })
  const proxy = { name: 'web', type: 'tcp', localPort: 3000, remotePort: 6000 }
  assert.equal((await api.saveFrpConfig({ proxies: [proxy] })).success, true)
  assert.equal((await api.saveFrpConfig({ server: { serverPort: '7001' } })).success, true)
  const result = await api.getFrpConfig()
  assert.equal(result.server.token, 'test-token')
  assert.equal(result.proxies[0].name, 'web')
  assert.equal((await api.saveFrpConfig({ proxies: [proxy, { ...proxy, name: 'duplicate' }] })).success, false)
  assert.equal((await api.getFrpConfig()).proxies.length, 1)
})

test('文档 updater 单次读取并保留同一快照的版本和未修改字段', () => {
  const { utools, docs } = database()
  const storage = createStorage(utools)
  docs.set('frp-config', { _id: 'frp-config', _rev: '1', server: { serverPort: '7000', token: 'kept-token' }, proxies: [{ name: 'kept' }] })
  const get = utools.db.get
  let reads = 0
  utools.db.get = id => { reads++; return get(id) }
  storage.putDocument('frp-config', existing => ({ server: { ...existing.server, serverPort: '7001' } }))
  assert.equal(reads, 1)
  const saved = docs.get('frp-config')
  assert.equal(saved._rev, '1')
  assert.equal(saved.server.serverPort, '7001')
  assert.equal(saved.server.token, 'kept-token')
  assert.equal(saved.proxies[0].name, 'kept')
  storage.putDocument('new-document', existing => {
    assert.equal(existing, null)
    return { value: 'created' }
  })
  assert.equal(docs.get('new-document').value, 'created')
  assert.throws(() => storage.putDocument('new-document', () => { throw new Error('invalid fields') }), /invalid fields/)
  assert.equal(docs.get('new-document').value, 'created')
})

test('FRP 合并期间发生同步更新必须保留更新并报告版本冲突', async () => {
  const { api, docs, utools } = services()
  docs.set('frp-config', { _id: 'frp-config', _rev: '1', server: { serverAddr: 'server-a', serverPort: '7000', token: 'old-token' }, proxies: [] })
  const get = utools.db.get
  let reads = 0
  utools.db.get = id => {
    const snapshot = get(id)
    if (id === 'frp-config' && ++reads === 1) {
      docs.set(id, { ...snapshot, _rev: '2', server: { ...snapshot.server, serverAddr: 'server-b', token: 'new-token' } })
    }
    return snapshot
  }
  utools.db.put = doc => {
    if (doc._rev !== docs.get(doc._id)?._rev) return { error: true, message: 'conflict' }
    docs.set(doc._id, structuredClone(doc))
    return { ok: true }
  }
  const result = await api.saveFrpConfig({ server: { serverPort: '7001' } })
  assert.equal(result.success, false)
  assert.match(result.message, /conflict/)
  assert.equal(reads, 1)
  assert.equal(docs.get('frp-config').server.serverAddr, 'server-b')
  assert.equal(docs.get('frp-config').server.token, 'new-token')
  assert.equal(docs.get('frp-config').server.serverPort, '7000')
})

test('数据库冲突不会被当作保存成功', async () => {
  const { api, utools } = services()
  utools.db.put = () => ({ error: true, message: 'conflict' })
  assert.equal(api.saveConfig({ defaultPort: '3000' }).success, false)
  assert.equal((await api.saveFrpConfig({ server: { serverAddr: 'example.com' } })).success, false)
})
