import path from 'node:path'

// 缓存留在项目内，使本机沙箱和 CI 使用相同的检查入口。
process.env.XDG_CACHE_HOME = path.resolve('node_modules', '.cache')
const { default: standard } = await import('standard')
const results = await standard.lintFiles(['public/preload/**/*.js', 'src/**/*.{js,jsx}', 'scripts/*.mjs', 'vite.config.js'], { envs: ['browser'] })
let errors = 0
for (const result of results) {
  for (const message of result.messages) {
    console.error(`${path.relative(process.cwd(), result.filePath)}:${message.line}:${message.column} ${message.message} (${message.ruleId})`)
    errors++
  }
}
if (errors) process.exitCode = 1
else console.log(`静态检查通过：${results.length} 个文件`)
