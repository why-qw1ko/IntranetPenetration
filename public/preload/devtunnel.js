const { watchOutput, stopProcess } = require('./process-utils')

module.exports = function createDevTunnelController ({ spawn, platform, getPath, decodeOutput, pickConnectUrl, formatCommand, log, emit, fileController, onRunningTunnel }) {
  let hostProcess = null
  let hostPid = null
  let hostTunnelId = null
  let hostStopping = null
  const tunnelUrlCache = {}

  async function startHost (tunnelId, port, allowAnonymous) {
    if (hostProcess || hostStopping) return { success: false, message: '已有隧道在运行或停止中，请先停止' }
    const args = ['host']
    if (tunnelId) args.push(tunnelId)
    else if (port) args.push('-p', String(port))
    if (allowAnonymous === true) args.push('--allow-anonymous')
    const ownedFile = fileController.getFileServerStatus()
    const cleanupFile = () => {
      const current = fileController.getFileServerStatus()
      if (ownedFile.running && ownedFile.mode === 'devtunnel' && Number(ownedFile.port) === Number(port) && current.id === ownedFile.id) fileController.stopFileServer('devtunnel')
    }
    log('system', formatCommand('devtunnel', args))
    try {
      const child = spawn(getPath(), args, { windowsHide: true })
      hostProcess = child
      hostPid = child.pid
      hostTunnelId = tunnelId || null
      let spawned = false
      let closed = false
      let settleStart
      const flushStdout = watchOutput(child.stdout, decodeOutput, text => {
        if (closed || hostProcess !== child) return
        log('stdout', text)
        emit('tunnel-log', text)
        const url = pickConnectUrl(text, port)
        if (url && tunnelId) {
          tunnelUrlCache[tunnelId] = url
          emit('tunnel-url', { tunnelId, url })
        }
      })
      const flushStderr = watchOutput(child.stderr, decodeOutput, text => {
        if (closed || hostProcess !== child) return
        log('stderr', text)
        emit('tunnel-error', text)
      })
      const finish = (code, message) => {
        if (closed || hostProcess !== child) return
        flushStdout()
        flushStderr()
        closed = true
        hostProcess = null
        hostPid = null
        hostTunnelId = null
        onRunningTunnel(null)
        if (tunnelId) delete tunnelUrlCache[tunnelId]
        cleanupFile()
        log('system', '进程退出 (code: ' + code + ')')
        emit('tunnel-host-status', getHostStatus())
        emit('tunnel-exit', { code, tunnelId })
        if (!spawned) settleStart?.({ success: false, message: message || 'devtunnel 已在启动时退出 (code: ' + code + ')' })
      }
      child.once('close', code => finish(code))
      return await new Promise(resolve => {
        settleStart = resolve
        child.once('spawn', () => {
          if (closed || hostProcess !== child) return
          spawned = true
          onRunningTunnel(tunnelId || null)
          emit('tunnel-host-status', getHostStatus())
          resolve({ success: true, pid: child.pid })
        })
        child.on('error', err => {
          if (closed || hostProcess !== child) return
          log('error', '进程错误: ' + err.message)
          emit('tunnel-error', err.message)
          if (!spawned) finish(-1, err.message)
        })
      })
    } catch (err) {
      cleanupFile()
      return { success: false, message: err.message }
    }
  }

  async function stopHost () {
    if (hostStopping) return hostStopping
    if (!hostProcess) return { success: false, message: '没有运行中的隧道' }
    const child = hostProcess
    log('system', '正在停止...')
    hostStopping = stopProcess(child, spawn, platform).finally(() => { hostStopping = null })
    return hostStopping
  }

  function getHostStatus () {
    return { running: hostProcess !== null, pid: hostPid, tunnelId: hostTunnelId }
  }

  function getTunnelUrl (tunnelId) {
    return tunnelUrlCache[tunnelId] || ''
  }

  return { startHost, stopHost, getHostStatus, getTunnelUrl, tunnelUrlCache }
}
