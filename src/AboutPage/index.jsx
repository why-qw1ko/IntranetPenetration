/* global __APP_VERSION__ */
import { AlertTriangle, Lock, Wrench, ClipboardList, RefreshCw, Menu, ShieldCheck } from 'lucide-react'
import './index.css'

export default function AboutPage ({ onToggleSidebar }) {
  return (
    <div className='content-wrap'>
      <div className='topbar'>
        <div className='topbar-left'>
          <button className='topbar-menu-btn' onClick={onToggleSidebar}><Menu size={18} /></button>
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
                面向开发调试、远程演示和临时文件分享的 uTools 本地插件。它把 DevTunnel、Frp 和目录代理整理到一个轻量操作台里，让你少记命令，多关注正在暴露什么服务。
              </p>
            </div>
          </div>

          <div className='about-grid'>
            <div className='about-card'>
              <div className='about-card-title'><Wrench size={16} /> 核心能力</div>
              <ul className='about-list'>
                <li><b>暴露本地端口</b>：通过 DevTunnel 快速生成公网访问地址，适合 Webhook、API 和本地 Web 项目调试。</li>
                <li><b>分享本地目录</b>：内置只读 HTTP 文件服务，可将选定文件夹临时暴露给外部访问。</li>
                <li><b>Frp 内网穿透</b>：连接你的 frps 服务端，用一个 frpc 进程承载多条代理规则。</li>
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
              <li>插件配置优先保存在 uTools 本地存储或本地数据库中，路径、frpc 路径等本机相关配置不会主动同步。</li>
              <li>DevTunnel 登录使用官方 CLI 的设备代码流程；插件不接触、不保存你的账号密码。</li>
              <li>Frp Token 保存在本地存储中，不随 uTools 数据库同步；运行日志中会做脱敏显示。</li>
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

          <div className='about-card'>
            <div className='about-card-title'><RefreshCw size={16} /> 更新日志</div>
            <ul className='about-list'>
              <li><b>v2.0.0</b> — 重构工作台入口，修正 Frp 端口测试语义，优化卡片视觉和运行状态表达。</li>
              <li>增强 preload 安全边界：命令执行避免 shell 拼接、目录代理补充路径校验、Frp 日志脱敏。</li>
              <li><b>v1.0.0</b> — 初始版本，支持 DevTunnel、Frp、目录代理和教程文档。</li>
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
