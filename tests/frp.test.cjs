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

