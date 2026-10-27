const fs = require('fs')

// dbStorage 同样参与同步；使用 uTools 设备 ID 隔离本机配置。
module.exports = function createStorage (utools) {
  const nativeId = utools.getNativeId()
  const localKey = key => nativeId + '/' + key

  function getLocal (key, defaultValue) {
    const current = utools.dbStorage.getItem(localKey(key))
    if (current !== null && current !== undefined) return current
    // 兼容旧版数据，但不把另一台机器的路径当成本机配置。
    let legacy = utools.dbStorage.getItem(key)
    if (legacy === null || legacy === undefined) return defaultValue
    if (['devtunnel-path', 'frpc-path'].includes(key) && (typeof legacy !== 'string' || !fs.existsSync(legacy))) return defaultValue
    if (key === 'proxydir-last-dir' && legacy.dirPath && !fs.existsSync(legacy.dirPath)) {
      legacy = { ...legacy, dirPath: '' }
    }
    setLocal(key, legacy)
    return legacy
  }

  function setLocal (key, value) {
    utools.dbStorage.setItem(localKey(key), value)
  }

  function removeLocal (key) {
    utools.dbStorage.removeItem(localKey(key))
    utools.dbStorage.removeItem(key)
  }

  function putDocument (id, fields) {
    const existing = utools.db.get(id)
    const patch = typeof fields === 'function' ? fields(existing) : fields
    const result = utools.db.put({ ...existing, ...patch, _id: id })
    if (!result?.ok) throw new Error(result?.message || '写入失败，请重试')
  }

  return { getLocal, setLocal, removeLocal, putDocument }
}
