const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { Readable } = require('node:stream')
const { once, EventEmitter } = require('node:events')
const createFileServer = require('../public/preload/file-server')

async function fixture (t, filesystem = fs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-file-test-'))
  const share = path.join(root, 'share')
  fs.mkdirSync(share)
  const logs = []
  const events = new EventEmitter()
  const server = createFileServer({ log: (...args) => { logs.push(args); events.emit('entry', args) }, filesystem })
  t.after(() => {
    server.stopFileServer()
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'tunnel-file-test-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const result = await server.startFileServer(share, 0)
  assert.equal(result.success, true)
  const request = (url = '/', method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: result.port, path: url, method }, res => {
      let body = ''
      res.on('data', data => { body += data })
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
  return { root, share, server, request, logs, events, port: result.port }
}

test('异步文件服务保留目录浏览、HTML 转义、文件读取和 HEAD 行为', async t => {
  const env = await fixture(t)
  fs.writeFileSync(path.join(env.share, 'a&b.txt'), 'hello')
  const listing = await env.request()
  assert.equal(listing.status, 200)
  assert.match(listing.body, /a&amp;b.txt/)
  assert.match(listing.body, /a%26b.txt/)
  const file = await env.request('/a%26b.txt')
  assert.equal(file.body, 'hello')
  assert.equal(file.headers['x-content-type-options'], 'nosniff')
  const head = await env.request('/a%26b.txt', 'HEAD')
  assert.equal(head.body, '')
  assert.equal(head.headers['content-length'], '5')
  assert.equal((await env.request('/', 'POST')).status, 405)
})

test('拒绝非法编码、目录穿越和指向分享目录外部的链接', async t => {
  const env = await fixture(t)
  fs.writeFileSync(path.join(env.root, 'secret.txt'), 'private')
  assert.equal((await env.request('/%FF')).status, 400)
  assert.equal((await env.request('/%00')).status, 400)
  assert.equal((await env.request('/' + encodeURIComponent('..' + path.sep + 'secret.txt'))).status, 403)
  assert.equal((await env.request('/missing')).status, 404)
  fs.mkdirSync(path.join(env.root, 'outside'))
  fs.writeFileSync(path.join(env.root, 'outside', 'secret.txt'), 'private')
  fs.symlinkSync(path.join(env.root, 'outside'), path.join(env.share, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await env.request('/link/secret.txt')).status, 403)
  assert.doesNotMatch((await env.request()).body, /href="\/link\//)
  fs.writeFileSync(path.join(env.share, '..notes'), 'valid name')
  assert.equal((await env.request('/..notes')).body, 'valid name')
})

test('打开文件失败返回 403，后续请求仍可正常处理', async t => {
  const filesystem = { promises: { ...fs.promises, open: async () => { throw Object.assign(new Error('read denied'), { code: 'EACCES' }) } } }
  const env = await fixture(t, filesystem)
  fs.writeFileSync(path.join(env.share, 'file.txt'), 'hello')
  assert.equal((await env.request('/file.txt')).status, 403)
  assert.equal((await env.request()).status, 200)
})

test('读取流异步报错后释放句柄，错误不会逸出请求处理器', async t => {
  let handle
  const filesystem = { promises: { ...fs.promises, open: async (...args) => {
    handle = await fs.promises.open(...args)
    const opened = handle
    return {
      stat: () => opened.stat(),
      close: () => opened.close(),
      createReadStream: () => new Readable({
        read () { this.destroy(Object.assign(new Error('disk read failed'), { code: 'EIO' })) },
        destroy (error, done) { opened.close().then(() => done(error), done) }
      })
    }
  } } }
  const env = await fixture(t, filesystem)
  fs.writeFileSync(path.join(env.share, 'file.txt'), 'hello')
  const errorLogged = once(env.events, 'entry')
  await assert.rejects(env.request('/file.txt'), /socket|aborted|reset/i)
  await errorLogged
  assert.equal(handle.fd, -1)
  assert.ok(env.logs.some(args => args[1].includes('disk read failed')))
  assert.equal((await env.request()).status, 200)
})

test('客户端取消下载会关闭读取句柄', async t => {
  let handle
  let closed
  const filesystem = { promises: { ...fs.promises, open: async (...args) => {
    handle = await fs.promises.open(...args)
    closed = once(handle, 'close')
    return handle
  } } }
  const env = await fixture(t, filesystem)
  fs.writeFileSync(path.join(env.share, 'large.bin'), Buffer.alloc(4 * 1024 * 1024))
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: env.port, path: '/large.bin' }, res => {
      res.once('data', () => { req.destroy(); resolve() })
      res.on('error', () => {})
    })
    req.on('error', reject)
  })
  await closed
  assert.equal(handle.fd, -1)
})

test('启动预约阻止并发监听，取消启动后允许重试', async t => {
  const env = await fixture(t)
  env.server.stopFileServer()
  const first = env.server.startFileServer(env.share, 0)
  const second = await env.server.startFileServer(env.share, 0)
  assert.equal(second.success, false)
  assert.equal(env.server.stopFileServer().success, true)
  assert.equal((await first).success, false)
  assert.equal((await env.server.startFileServer(env.share, 0)).success, true)
})

test('目录元数据并发读取有上限', async t => {
  let pending = 0
  let maximum = 0
  const filesystem = { promises: { ...fs.promises, stat: async (...args) => {
    maximum = Math.max(maximum, ++pending)
    try { return await fs.promises.stat(...args) } finally { pending-- }
  } } }
  const env = await fixture(t, filesystem)
  for (let i = 0; i < 24; i++) fs.writeFileSync(path.join(env.share, 'entry-' + i), 'ok')
  assert.equal((await env.request()).status, 200)
  assert.ok(maximum <= 8)
  assert.equal(pending, 0)
})
