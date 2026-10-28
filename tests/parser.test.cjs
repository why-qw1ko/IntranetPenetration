const test = require('node:test')
const assert = require('node:assert/strict')
const { extractTunnelIdFromText, parseTunnelsFromText, parseTunnelDetailFromText, parsePortsFromText, parseTunnelList, parsePortList } = require('../public/preload/devtunnel-parser')

// 支持格式的代表性样例，不冒充真实 CLI 采集记录。
test('文本兼容解析覆盖完整 ID、引号、标点和集群后缀', () => {
  for (const text of ['Created tunnel sample-tunnel', 'Created tunnel "sample-tunnel".', 'Hosting tunnel sample-tunnel.', 'Set default tunnel to sample-tunnel']) {
    assert.equal(extractTunnelIdFromText(text), 'sample-tunnel')
  }
  assert.equal(extractTunnelIdFromText('Created tunnel sample-tunnel.use.'), 'sample-tunnel.use')
  assert.equal(extractTunnelIdFromText('Tunnel ID: abc123.use'), 'abc123.use')
  assert.equal(extractTunnelIdFromText('Created an unknown result'), '')
})

test('兼容 JSON、表格和详情文本格式，详情和端口解析不互相污染', () => {
  const detail = 'Tunnel ID: abc123.use\nDescription: 示例目录\nAccess control: +Anonymous [connect]\nPort: 3000 http'
  assert.equal(parseTunnelDetailFromText(detail).description, '示例目录')
  assert.equal(parseTunnelDetailFromText(detail).anonymous, true)
  assert.equal(parsePortsFromText(detail)[0].portNumber, 3000)
  assert.equal(parseTunnelsFromText('Tunnel ID    Description\nabc123.use    My tunnel')[0].tunnelId, 'abc123.use')
  assert.equal(parseTunnelsFromText(JSON.stringify([{ tunnelId: 'abc123.use', ports: [{ portNumber: 3000 }] }]))[0].ports.length, 1)
})

test('空列表与未知输出严格区分，避免 CLI 格式变化后误创建资源', () => {
  for (const text of ['[]', '{"tunnels":[]}', 'No tunnels found.', 'Tunnel ID    Description\n---------']) assert.equal(parseTunnelList(text).length, 0)
  for (const text of ['[]', '{"ports":[]}', 'No ports found.', 'Port Number    Protocol\n---------']) assert.equal(parsePortList(text).length, 0)
  for (const text of ['', 'unrecognized output', '{"error":"offline"}']) {
    assert.throws(() => parseTunnelList(text), /无法识别/)
    assert.throws(() => parsePortList(text), /无法识别/)
  }
})
