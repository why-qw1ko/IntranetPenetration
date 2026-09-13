import { Radio, Link2, FolderOpen, BookOpen, Info, Settings } from 'lucide-react'
import './index.css'

const MENU = [
  { key: 'devtunnel', icon: Radio, label: '免费内网穿透' },
  { key: 'frp', icon: Link2, label: 'Frp 内网穿透' },
  { key: 'proxydir', icon: FolderOpen, label: '代理目录' },
  { key: 'settings', icon: Settings, label: '设置' },
  { key: 'tutorial', icon: BookOpen, label: '教程文档' },
  { key: 'about', icon: Info, label: '关于本项目' }
]

export default function Sidebar ({ activeSection, onSelect, collapsed, onToggle }) {
  return (
    <>
      <div className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
        <div className='sidebar-header'>
          <div className='sidebar-brand'>
            <img className='sidebar-logo' src='./logo.png' alt='logo' />
            <span className='sidebar-name'>内网穿透工具</span>
          </div>
          <button className='sidebar-collapse-btn' onClick={onToggle} title='收起侧边栏'>
            <svg width='16' height='16' viewBox='0 0 16 16' fill='none'>
              <path d='M10 4L6 8L10 12' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'/>
            </svg>
          </button>
        </div>

        <div className='sidebar-menu'>
          {MENU.map(item => (
            <button
              key={item.key}
              className={`sidebar-menu-item ${activeSection === item.key ? 'active' : ''}`}
              onClick={() => onSelect(item.key)}
            >
              <span className='sidebar-menu-icon'><item.icon size={18} strokeWidth={1.8} /></span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        <div className='sidebar-footer'>
          <span className='sidebar-version'>v1.0.0</span>
        </div>
      </div>

      {collapsed && (
        <button className='sidebar-expand-btn' onClick={onToggle} title='展开侧边栏'>
          <svg width='16' height='16' viewBox='0 0 16 16' fill='none'>
            <path d='M6 4L10 8L6 12' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'/>
          </svg>
        </button>
      )}
    </>
  )
}
