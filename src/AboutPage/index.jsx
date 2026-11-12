/* global __APP_VERSION__ */
import { AlertTriangle, Lock, Wrench, ClipboardList, Menu, ShieldCheck } from 'lucide-react'
import './index.css'

export default function AboutPage ({ onToggleSidebar }) {
  return (
    <div className='content-wrap'>
      <div className='topbar'>
        <div className='topbar-left'>
          <button className='topbar-menu-btn' onClick={onToggleSidebar} title='菜单'><Menu size={18} /></button>
          <span className='topbar-title'>关于本项目</span>
        </div>
      </div>
      <div className='page'>
        <div className='about-page'>
          <div className='about-header about-card'>
            <img src='./logo.png' className='about-logo' alt='logo' />
            <div>
              <div className='about-name'>内网穿透助手</div>
              <div className='about-version'>v{__APP_VERSION__}</div>
              <p className='about-desc'>
                通过 Dev Tunnels 或 FRP 转发本地服务，也可以共享本地文件夹。
              </p>
            </div>
          </div>

          <div className='about-grid'>
            <div className='about-card'>
              <div className='about-card-title'><Wrench size={16} /> 核心能力</div>
              <ul className='about-list'>
                <li>通过 DevTunnel 快速生成公网访问地址，适合 Webhook、API 和本地 Web 项目调试。</li>
                <li>内置只读 HTTP 文件服务，可将选定文件夹临时暴露给外部访问。</li>
                <li>连接你的 frps 服务端，用一个 frpc 进程承载多条代理规则。</li>
              </ul>
            </div>

            <div className='about-card'>
              <div className='about-card-title'><ClipboardList size={16} /> 适用场景</div>
              <ul className='about-list'>
                <li>本地开发调试、第三方回调联调、临时远程演示。</li>
                <li>临时文件共享、静态页面预览、内网设备接口调试。</li>
                <li>已有公网服务器时，用 Frp 维护更长期、固定入口的代理。</li>
              </ul>
            </div>
          </div>

          <div className='about-card'>
            <div className='about-card-title'><Lock size={16} /> 隐私与数据</div>
            <ul className='about-list'>
              <li>默认值、FRP 服务器和代理规则沿用 uTools 数据同步；文件路径和目录设置按设备 ID 隔离取值。</li>
              <li>DevTunnel 登录使用官方 CLI 的设备代码流程；插件不接触、不保存你的账号密码。</li>
              <li>Frp Token 按设备 ID 隔离，仍存储在参与 uTools 同步的 dbStorage 中，不代表仅保存在本机；运行日志会做脱敏显示。</li>
              <li>启动穿透后，你暴露的服务会按所选通道对外可访问，请确认本地服务本身的鉴权和内容安全。</li>
            </ul>
          </div>

          <div className='about-card'>
            <div className='about-card-title'><ShieldCheck size={16} /> 使用边界</div>
            <ul className='about-list'>
              <li>本插件负责管理本机 CLI、配置和本地文件服务；DevTunnel 服务由 Microsoft 提供，Frp 服务端由你自行部署或维护。</li>
              <li>Frp 的“测试端口”只验证服务器端口是否可连通，不代表 Token 已通过认证；认证结果以启动 frpc 后的日志为准。</li>
              <li>请勿将未加鉴权的管理后台、私密文件或敏感接口直接暴露到公网。</li>
            </ul>
          </div>

          <div className='about-card about-warning'>
            <div className='about-card-title'><AlertTriangle size={16} /> 免责声明</div>
            <ul className='about-list'>
              <li>你需要自行遵守 DevTunnel、Frp、云服务器和网络服务提供方的使用条款。</li>
              <li>因暴露本地服务、错误配置服务器或共享敏感内容造成的风险由使用者自行承担。</li>
              <li>本插件不对第三方通道服务的稳定性、可用性和策略变更作保证。</li>
            </ul>
          </div>

          <div className='about-footer'>
            基于 uTools 平台构建 · DevTunnel 由 Microsoft 提供 · Frp 由 fatedier 开发
          </div>
        </div>
      </div>
    </div>
  )
}
