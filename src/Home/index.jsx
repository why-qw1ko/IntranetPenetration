import { ArrowRight, BookOpen, FolderOpen, Link2, Menu, Radio } from 'lucide-react'
import './index.css'

const ENTRIES = [
  { key: 'devtunnel', icon: Radio, title: '免费内网穿透', description: '由 Microsoft Dev Tunnels 提供，无需自建服务器，适合临时调试。' },
  { key: 'frp', icon: Link2, title: 'FRP 内网穿透', description: 'FRP 免费使用，需准备服务器，适合长期运行和固定服务器。' },
  { key: 'proxydir', icon: FolderOpen, title: '共享文件夹', description: '选择本地文件夹，生成链接供他人浏览和下载文件。' },
  { key: 'tutorial', icon: BookOpen, title: '使用帮助', description: '了解穿透方式、配置步骤和常见问题。' }
]

export default function Home ({ onSelect, onToggleSidebar }) {
  return (
    <>
      <div className='topbar'>
        <div className='topbar-left'>
          <button className='topbar-menu-btn' onClick={onToggleSidebar} title='菜单'><Menu size={18} /></button>
          <span className='topbar-title'>主页</span>
        </div>
      </div>
      <div className='page home-page'>
        <div className='home-intro'>
          <h1>选择要使用的功能</h1>
          <p>连接本地服务，或分享文件夹中的内容。</p>
        </div>
        <div className='home-grid'>
          {ENTRIES.map(item => (
            <button key={item.key} className='home-entry' onClick={() => onSelect(item.key)}>
              <span className='home-entry-icon'><item.icon size={20} /></span>
              <span className='home-entry-copy'>
                <span className='home-entry-title'>{item.title}</span>
                <span className='home-entry-description'>{item.description}</span>
              </span>
              <ArrowRight className='home-entry-arrow' size={16} />
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
