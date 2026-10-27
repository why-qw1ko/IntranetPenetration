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

