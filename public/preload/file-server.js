const fs = require('fs')
const path = require('path')
const http = require('http')
const { pipeline } = require('stream')

function escapeHtml (value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isPathInside (rootPath, targetPath) {
  const relativePath = path.relative(rootPath, targetPath)
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith('..' + path.sep) && !path.isAbsolute(relativePath))
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.wasm': 'application/wasm'
}

function getMimeType (filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

function getFileSize (size) {
  if (size < 1024) return size + ' B'
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
  if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB'
  return (size / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

function renderDirPage (dirUrl, entries, parentPath) {
  const items = entries.map(e => {
    const icon = e.isDirectory
      ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="#6C8EBF"><path d="M1.5 2h4.3l1.2 2H14.5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 16 16" fill="#999"><path d="M4 1h5.5L12 3.5V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm1 4h5v1H5V5zm0 3h5v1H5V8zm0 3h3v1H5v-1z"/></svg>'
    const name = e.name + (e.isDirectory ? '/' : '')
    const href = dirUrl + encodeURIComponent(e.name) + (e.isDirectory ? '/' : '')
    const size = e.isDirectory ? '-' : getFileSize(e.size)
    const mtime = e.mtime ? new Date(e.mtime).toLocaleString('zh-CN') : '-'
    return `<tr><td>${icon}</td><td><a href="${escapeHtml(href)}">${escapeHtml(name)}</a></td><td>${escapeHtml(size)}</td><td>${escapeHtml(mtime)}</td></tr>`
  }).join('\n')

  const parentIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="#6C8EBF"><path d="M1.5 2h4.3l1.2 2H14.5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/></svg>'
  const parentRow = parentPath
    ? `<tr><td>${parentIcon}</td><td><a href="${escapeHtml(parentPath)}">..</a></td><td>-</td><td>-</td></tr>`
    : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>📂 ${escapeHtml(dirUrl)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; color: #1a1a1a; padding: 24px; }
  .header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #e8ecf0; }
  .header h1 { font-size: 18px; font-weight: 600; color: #1a1a1a; }
  .header .path { font-size: 13px; color: #8a8a8a; font-family: 'Cascadia Code', 'Fira Code', monospace; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.04); }
  th { background: #f1f3f5; text-align: left; padding: 10px 16px; font-size: 12px; font-weight: 600; color: #8a8a8a; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 10px 16px; border-top: 1px solid #f1f3f5; font-size: 13px; }
  td:first-child { width: 32px; text-align: center; }
  td:nth-child(3), td:nth-child(4) { color: #8a8a8a; font-size: 12px; }
  a { color: #10B981; text-decoration: none; font-weight: 500; }
  a:hover { text-decoration: underline; }
  tr:hover { background: #f8f9fa; }
  .footer { margin-top: 16px; text-align: center; font-size: 11px; color: #b0b0b0; }
</style>
</head>
<body>
  <div class="header">
<h1>📂 目录浏览</h1>
<span class="path">${escapeHtml(dirUrl)}</span>
  </div>
  <table>
<thead><tr><th></th><th>名称</th><th>大小</th><th>修改时间</th></tr></thead>
<tbody>
  ${parentRow}
  ${items}
</tbody>
  </table>
  <div class="footer">由 devtunnel 内网穿透插件提供</div>
</body>
</html>`
}

function getParentUrlPath (dirUrl) {
  const trimmed = String(dirUrl || '/').replace(/\/+$/, '')
  if (!trimmed) return null
  const index = trimmed.lastIndexOf('/')
  return index <= 0 ? '/' : trimmed.slice(0, index + 1)
}

// 并发上限只限制目录元数据读取，避免大目录耗尽文件句柄。
async function mapEntries (entries, read) {
  const result = new Array(entries.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (cursor < entries.length) {
      const index = cursor++
      result[index] = await read(entries[index])
    }
  }))
  return result.filter(Boolean)
}

module.exports = function createFileServer ({ log, onStarted, filesystem = fs }) {
  const files = filesystem.promises
  let active = null
  let nextId = 0

  async function validateDirectory (dirPath) {
    if (typeof dirPath !== 'string' || !dirPath.trim()) throw new Error('请选择有效目录')
    const rootDir = path.resolve(dirPath)
    const rootRealPath = await files.realpath(rootDir)
    if (!(await files.stat(rootRealPath)).isDirectory()) throw new Error('请选择有效目录')
    return { rootDir, rootRealPath }
  }

  async function validateFileServerDirectory (dirPath) {
    try {
      await validateDirectory(dirPath)
      return { success: true }
    } catch (error) {
      return { success: false, message: '目录不可访问: ' + error.message }
    }
  }

  function reply (res, code, text) {
    if (res.destroyed || res.writableEnded) return
    if (res.headersSent) { res.destroy(); return }
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
    res.end(text)
  }

  async function serve (run, root, req, res) {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD')
      reply(res, 405, '405 不支持的请求方法')
      return
    }
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')
    let reqPath
    try { reqPath = decodeURIComponent(requestUrl.pathname) } catch (error) {
      reply(res, 400, '400 请求路径无效')
      return
    }
    if (reqPath.includes('\0')) { reply(res, 400, '400 请求路径无效'); return }
    const fullPath = path.resolve(root.rootDir, reqPath.replace(/^[/\\]+/, ''))
    if (!isPathInside(root.rootDir, fullPath)) { reply(res, 403, '403 禁止访问'); return }
    const realPath = await files.realpath(fullPath)
    if (!isPathInside(root.rootRealPath, realPath)) { reply(res, 403, '403 禁止访问'); return }
    const stat = await files.stat(realPath)
    if (res.destroyed || active !== run) return
    if (stat.isDirectory()) {
      const children = await files.readdir(realPath, { withFileTypes: true })
      const entries = await mapEntries(children, async entry => {
        try {
          const entryRealPath = await files.realpath(path.join(realPath, entry.name))
          if (!isPathInside(root.rootRealPath, entryRealPath)) return null
          const info = await files.stat(entryRealPath)
          if (!info.isDirectory() && !info.isFile()) return null
          return { name: entry.name, isDirectory: info.isDirectory(), size: info.size, mtime: info.mtimeMs }
        } catch (error) { return null }
      })
      entries.sort((a, b) => a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name))
      const dirUrl = requestUrl.pathname.endsWith('/') ? requestUrl.pathname : requestUrl.pathname + '/'
      const html = renderDirPage(dirUrl, entries, dirUrl === '/' ? null : getParentUrlPath(dirUrl))
      if (res.destroyed || active !== run) return
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
      res.end(req.method === 'HEAD' ? undefined : html)
      return
    }
    if (!stat.isFile()) { reply(res, 403, '403 禁止访问'); return }

    // 在发响应头前打开文件；打开失败可以正常返回错误状态。
    const handle = await files.open(realPath, 'r')
    let input
    try {
      const current = await handle.stat()
      if (res.destroyed || active !== run) { await handle.close(); return }
      if (!current.isFile()) { await handle.close(); reply(res, 403, '403 禁止访问'); return }
      res.writeHead(200, {
        'Content-Type': getMimeType(realPath),
        'Content-Length': current.size,
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff'
      })
      if (req.method === 'HEAD') { await handle.close(); res.end(); return }
      input = handle.createReadStream()
      // pipeline 同时处理读取错误和客户端断连，销毁两端并释放文件句柄。
      pipeline(input, res, error => {
        if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') log('error', '文件读取失败: ' + error.message, run.mode)
      })
    } catch (error) {
      if (input) input.destroy()
      else await handle.close()
      throw error
    }
  }

  async function startFileServer (dirPath, port = 3000, mode = 'devtunnel') {
    if (active) return { success: false, message: '文件服务器已在运行或启动中' }
    if (!/^\d+$/.test(String(port)) || Number(port) > 65535) return { success: false, message: '文件服务器端口无效' }
    const run = { id: ++nextId, server: null, mode, port: null, dir: null }
    active = run
    try {
      const root = await validateDirectory(dirPath)
      if (active !== run) return { success: false, message: '文件服务启动已取消' }
      run.dir = root.rootDir
      const server = http.createServer((req, res) => {
        serve(run, root, req, res).catch(error => {
          log('error', '文件服务器请求失败: ' + error.message, mode)
          const code = ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : ['EACCES', 'EPERM'].includes(error.code) ? 403 : 500
          reply(res, code, code === 404 ? '404 文件不存在' : code === 403 ? '403 禁止访问' : '500 服务器错误')
        })
      })
      run.server = server
      return await new Promise(resolve => {
        server.on('error', error => {
          if (active === run) active = null
          log('error', '文件服务器错误: ' + error.message, mode)
          resolve({ success: false, message: '端口 ' + port + ' 启动失败: ' + error.message })
        })
        server.listen(Number(port), '127.0.0.1', () => {
          if (active !== run) { server.close(); resolve({ success: false, message: '文件服务启动已取消' }); return }
          run.port = server.address().port
          log('system', '文件服务器已启动: http://127.0.0.1:' + run.port + ' -> ' + run.dir, mode)
          onStarted?.({ port: run.port, dir: run.dir, mode })
          resolve({ success: true, port: run.port })
        })
        server.once('close', () => resolve({ success: false, message: '文件服务启动已取消' }))
      })
    } catch (error) {
      if (active === run) active = null
      run.server?.close()
      return { success: false, message: error.message }
    }
  }

  function stopFileServer (mode) {
    if (!active) return { success: false, message: '文件服务器未在运行' }
    if (mode && mode !== active.mode) return { success: false, message: '文件服务器属于 ' + active.mode + ' 模式，拒绝停止' }
    const run = active
    try {
      run.server?.close()
      run.server?.closeAllConnections?.()
      active = null
      log('system', '文件服务器已停止', run.mode)
      return { success: true }
    } catch (error) { return { success: false, message: error.message } }
  }

  function getFileServerStatus () {
    return { running: Boolean(active), id: active?.id, port: active?.port ?? null, dir: active?.dir ?? null, mode: active?.mode ?? null }
  }

  return { startFileServer, stopFileServer, getFileServerStatus, validateFileServerDirectory }
}
