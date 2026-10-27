// 等完整行到达后再解码，避免中文和 URL 被数据块边界截断。
function watchOutput (stream, decode, consume) {
  let pending = Buffer.alloc(0)
  const flush = () => {
    const text = decode(pending).trim()
    pending = Buffer.alloc(0)
    if (text) consume(text)
  }
  stream.on('data', data => {
    pending = Buffer.concat([pending, Buffer.isBuffer(data) ? data : Buffer.from(data)])
    let end
    while ((end = pending.indexOf(10)) !== -1) {
      const text = decode(pending.subarray(0, end)).trim()
      pending = pending.subarray(end + 1)
      if (text) consume(text)
    }
  })
  stream.on('end', flush)
  return flush
}

function stopProcess (child, spawn, platform = process.platform, timeout = 5000) {
  return new Promise(resolve => {
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('close', onClose)
      child.removeListener('error', onError)
      resolve(result)
    }
    const onClose = () => finish({ success: true })
    const onError = err => finish({ success: false, message: err.message })
    const timer = setTimeout(() => finish({ success: false, message: '停止超时，请重试' }), timeout)
    child.once('close', onClose)
    child.once('error', onError)
    try {
      if (platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        killer.once('error', onError)
        killer.once('close', code => {
          if (code) finish({ success: false, message: '停止失败，taskkill 退出码: ' + code })
        })
      } else if (!child.kill()) finish({ success: false, message: '无法发送停止信号' })
    } catch (err) { onError(err) }
  })
}

module.exports = { watchOutput, stopProcess }
