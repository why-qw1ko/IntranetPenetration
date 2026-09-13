import { AlertTriangle, Lock, Wrench, ClipboardList, RefreshCw, Menu } from 'lucide-react'
import './index.css'

export default function AboutPage({ onToggleSidebar }) {
  return (
    <div className="content-wrap">
      <div className="topbar">
        <div className="topbar-left">
          <button className="topbar-menu-btn" onClick={onToggleSidebar}><Menu size={18} /></button>
          <span className="topbar-title">关于本项目</span>
        </div>
      </div>
      <div className="page">
        <div className="about-page">
          <div className="about-header">
            <img src="./logo.png" className="about-logo" alt="logo" />
            <div>
              <div className="about-name">内网穿透助手</div>
              <div className="about-version">v{__APP_VERSION__}</div>
            </div>
          </div>

          <p className="about-desc">
            一款基于 uTools 平台的内网穿透管理工具，集成 Microsoft DevTunnel 和 Frp 两种穿透方案，帮助开发者快速将本地服务暴露到公网，便于调试、演示和远程访问。
          </p>

          <div className="about-card">
            <div className="about-card-title"><AlertTriangle size={16} /> 免责声明</div>
            <ul className="about-list">
              <li>本工具仅提供内网穿透服务的管理界面，实际穿透服务由第三方提供（Microsoft DevTunnel / Frp），使用者需自行了解相关服务的使用条款和限制。</li>
              <li>使用本工具进行内网穿透所产生的任何直接或间接损失（包括但不限于数据泄露、服务中断、财产损失等），开发者不承担任何责任。</li>
              <li>使用者通过本工具暴露的本地服务内容，由使用者自行负责。请勿将本工具用于非法用途，如传播违法信息、侵犯他人权益等。</li>
              <li>本工具不对第三方服务的稳定性、安全性和可用性做任何保证。穿透服务可能因网络环境、服务提供商策略变更等原因中断或不可用。</li>
              <li>使用 Frp 自建穿透服务时，服务器的安全配置由使用者自行负责。请确保服务器已正确配置防火墙、访问控制等安全措施。</li>
              <li>本工具不收集任何用户数据。所有配置信息仅存储在本地 uTools 数据库中，不会上传到任何服务器。</li>
              <li>使用本工具即表示您已阅读、理解并同意本免责声明的全部内容。</li>
            </ul>
          </div>

          <div className="about-card">
            <div className="about-card-title"><Lock size={16} /> 隐私说明</div>
            <ul className="about-list">
              <li>所有隧道配置、服务器地址、Token 等信息均存储在本地 uTools 数据库中，不会上传到任何云端。</li>
              <li>本工具不包含任何数据上报、用户行为追踪或统计分析功能。</li>
              <li>登录 DevTunnel 时使用的是 Microsoft 官方的设备代码认证流程，本工具不存储您的 Microsoft 账号密码。</li>
              <li>Frp 连接仅在您主动启动时建立，不会在后台保持长连接。</li>
            </ul>
          </div>

          <div className="about-card">
            <div className="about-card-title"><Wrench size={16} /> 技术说明</div>
            <ul className="about-list">
              <li><b>DevTunnel</b> — 由 Microsoft 提供的免费内网穿透服务，基于 Azure 基础设施，无需注册即可使用（GitHub 账号登录），支持 TCP 和 HTTP 协议，自动 HTTPS。</li>
              <li><b>Frp</b> — 开源的高性能内网穿透工具，由 fatedier 开发，采用 Apache 2.0 开源协议。需要用户自行准备公网服务器作为服务端。</li>
              <li><b>uTools</b> — 本工具基于 uTools 平台运行，利用其插件系统、本地数据库和系统 API 实现桌面端集成。</li>
            </ul>
          </div>

          <div className="about-card">
            <div className="about-card-title"><ClipboardList size={16} /> 适用场景</div>
            <ul className="about-list">
              <li><b>本地开发调试</b> — 将 localhost 服务暴露到公网，方便对接第三方 Webhook（如微信支付回调、GitHub Webhook 等）。</li>
              <li><b>远程演示</b> — 在客户或团队面前展示本地开发中的项目，无需部署到服务器。</li>
              <li><b>远程访问</b> — 在外出时访问家中或办公室的 NAS、路由器管理页面、远程桌面等服务。</li>
              <li><b>IoT 设备调试</b> — 将内网中的 IoT 设备接口暴露出来，进行远程调试和数据采集。</li>
              <li><b>临时文件共享</b> — 通过目录代理功能快速共享本地文件夹。</li>
            </ul>
          </div>

          <div className="about-card">
            <div className="about-card-title"><RefreshCw size={16} /> 更新日志</div>
            <ul className="about-list">
              <li><b>v1.0.0</b> — 初始版本，支持 DevTunnel 免费内网穿透、Frp 自建穿透、目录代理、教程文档。</li>
            </ul>
          </div>

          <div className="about-footer">
            本工具基于 uTools 平台构建 · DevTunnel 由 Microsoft 提供 · Frp 由 fatedier 开发 · 如有问题或建议，欢迎反馈
          </div>
        </div>
      </div>
    </div>
  )
}
