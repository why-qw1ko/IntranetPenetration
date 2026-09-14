import { useState } from 'react'
import { Radio, Link2, HelpCircle, Lightbulb, AlertTriangle, CheckCircle2, XCircle, ChevronRight, Menu } from 'lucide-react'
import './index.css'

export default function TutorialPage ({ onToggleSidebar }) {
  const [faqOpen, setFaqOpen] = useState({})
  const toggleFaq = (k) => setFaqOpen(p => ({ ...p, [k]: !p[k] }))

  const FaqItem = ({ k, q, children }) => (
    <div className='tutorial-faq-item'>
      <div className={`tutorial-faq-q ${faqOpen[k] ? 'expanded' : ''}`} onClick={() => toggleFaq(k)}>
        {q}<span><ChevronRight size={14} /></span>
      </div>
      {faqOpen[k] && <div className='tutorial-faq-a'>{children}</div>}
    </div>
  )

  return (
    <div className='content-wrap'>
      <div className='topbar'>
        <div className='topbar-left'>
          <button className='topbar-menu-btn' onClick={onToggleSidebar}><Menu size={18} /></button>
          <span className='topbar-title'>教程文档</span>
        </div>
      </div>
      <div className='page'>
        <div className='tutorial-page'>

          {/* ====== DevTunnel 教程 ====== */}
          <div className='tutorial-section'>
            <div className='tutorial-section-title'><Radio size={20} /> DevTunnel 免费内网穿透教程</div>

            <div className='tutorial-card'>
              <div className='tutorial-card-title'>什么是 DevTunnel？</div>
              <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.8, marginBottom: 10 }}>
                DevTunnel 是微软 Azure 提供的免费内网穿透服务，基于全球 Azure 基础设施运行。
                它可以将你的本地开发服务器暴露到公网，生成一个 <code>*.devtunnels.ms</code> 的 HTTPS 域名，
                任何人都可以通过这个域名访问你的本地服务。
              </p>
              <div className='tutorial-tip'>
                <b><Lightbulb size={13} /> 特点：</b>完全免费、无需注册（GitHub 登录即可）、自动 HTTPS、全球加速节点、支持 TCP 和 HTTP 协议。
              </div>
            </div>

            <div className='tutorial-card'>
              <div className='tutorial-card-title'>快速开始</div>
              <ol className='tutorial-steps'>
                <li>点击左侧菜单「免费内网穿透」，进入主界面。</li>
                <li>点击「GitHub 登录」或「Microsoft 登录」，在弹出的浏览器页面完成授权。</li>
                <li>登录成功后，点击「新建隧道」，填写隧道名称和本地端口（如 <code>3000</code>）。</li>
                <li>隧道创建成功后，在列表中点击「启动」，等待连接建立。</li>
                <li>连接成功后会显示一个 <code>https://xxx.devtunnels.ms</code> 的地址，复制后即可在任何设备上访问。</li>
              </ol>
              <div className='tutorial-tip'>
                <b><Lightbulb size={13} /> 提示：</b>隧道创建后会自动持久化保存，下次打开 uTools 无需重新创建，直接启动即可。
              </div>
            </div>

            <div className='tutorial-card'>
              <div className='tutorial-card-title'>常见使用场景</div>
              <ul className='tutorial-steps'>
                <li><b>Webhook 调试</b> — 微信公众号、支付宝、GitHub 等第三方服务需要配置回调 URL，用 DevTunnel 生成公网地址即可接收回调。</li>
                <li><b>移动端测试</b> — 手机浏览器打开生成的地址，实时预览本地开发页面，无需部署。</li>
                <li><b>团队协作</b> — 将本地运行中的项目分享给同事查看，无需等部署到测试环境。</li>
                <li><b>远程演示</b> — 给客户演示开发中的功能，无需公网服务器。</li>
              </ul>
            </div>

            <div className='tutorial-card'>
              <div className='tutorial-card-title'>目录代理功能</div>
              <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.8, marginBottom: 10 }}>
                如果你想快速共享本地的一个文件夹，可以使用「目录代理」功能：
              </p>
              <ol className='tutorial-steps'>
                <li>点击左侧菜单「代理目录」，进入目录代理页面。</li>
                <li>选择要共享的文件夹路径，设置端口（默认 3000）。</li>
                <li>点击「启动目录代理」，系统会自动创建一个本地 HTTP 服务器并启动穿透。</li>
                <li>生成的公网地址可以直接在浏览器中打开，浏览文件夹内容并下载文件。</li>
              </ol>
              <div className='tutorial-warning'>
                <b><AlertTriangle size={13} /> 注意：</b>目录代理会将文件夹内容完全暴露到公网，请勿共享包含敏感信息的目录。建议仅在调试和临时分享时使用。
              </div>
            </div>

            <div className='tutorial-card'>
              <div className='tutorial-card-title'>常见问题</div>
              <ul className='tutorial-steps'>
                <li><b>隧道显示「已过期」</b> — DevTunnel 免费隧道有 30 天有效期，过期后需重新创建。</li>
                <li><b>连接速度慢</b> — DevTunnel 服务器在海外，国内访问可能有延迟。如需更快的速度，建议使用 Frp 内网穿透。</li>
                <li><b>启动失败</b> — 检查本地端口是否被占用，确认 devtunnel.exe 路径正确（可在设置中修改）。</li>
                <li><b>登录超时</b> — 网络问题可能导致登录流程超时，检查网络后重试。如持续失败，可尝试重新打开 uTools。</li>
              </ul>
            </div>
          </div>

          {/* ====== Frp 教程 ====== */}
          <div className='tutorial-section'>
            <div className='tutorial-section-title'><Link2 size={20} /> Frp 内网穿透教程</div>

            <div className='tutorial-card'>
              <div className='tutorial-card-title'>什么是 Frp？</div>
              <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.8, marginBottom: 10 }}>
                Frp（Fast Reverse Proxy）是一款开源的高性能内网穿透工具，由 fatedier 开发维护。
                它通过在公网服务器上部署服务端（frps），在内网机器上运行客户端（frpc），
                将内网服务安全地暴露到公网。相比 DevTunnel，Frp 的优势在于：
              </p>
              <ul className='tutorial-steps'>
                <li><b>速度更快</b> — 数据不经过第三方服务器，直连你自己的服务器，延迟更低。</li>
                <li><b>完全可控</b> — 服务器在你手里，不受第三方服务条款限制，没有使用时长和流量限制。</li>
                <li><b>协议丰富</b> — 支持 TCP、UDP、HTTP、HTTPS、STCP 等多种协议。</li>
                <li><b>永久免费</b> — 开源项目，Apache 2.0 协议，可自由使用和修改。</li>
              </ul>
            </div>

            <div className='tutorial-card'>
              <div className='tutorial-card-title'>什么是 VPS / 云服务器？</div>
              <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.8, marginBottom: 10 }}>
                要使用 Frp，你需要一台拥有公网 IP 的服务器。以下是几种常见的服务器类型：
              </p>
              <table className='tutorial-table'>
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>说明</th>
                    <th>能否用 Frp？</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><b>VPS</b>（Virtual Private Server）</td>
                    <td>虚拟专用服务器，通过虚拟化技术将一台物理服务器划分为多个独立的虚拟服务器。每个 VPS 有独立的操作系统、公网 IP 和资源配额。</td>
                    <td><CheckCircle2 size={14} style={{ color: 'var(--green)', verticalAlign: 'middle' }} /> 完全支持</td>
                  </tr>
                  <tr>
                    <td><b>云服务器</b>（ECS / CVM / EC2）</td>
                    <td>阿里云 ECS、腾讯云 CVM、华为云 ECS、AWS EC2 等，本质也是虚拟服务器，但由云厂商提供更完善的管理面板和技术支持。</td>
                    <td><CheckCircle2 size={14} style={{ color: 'var(--green)', verticalAlign: 'middle' }} /> 完全支持</td>
                  </tr>
                  <tr>
                    <td><b>轻量应用服务器</b></td>
                    <td>云厂商推出的简化版云服务器，预装常见应用镜像，价格更低，适合个人开发者。功能上与标准云服务器相同，有公网 IP，可以自由安装软件。</td>
                    <td><CheckCircle2 size={14} style={{ color: 'var(--green)', verticalAlign: 'middle' }} /> 完全支持</td>
                  </tr>
                  <tr>
                    <td><b>物理服务器 / 独立服务器</b></td>
                    <td>实体硬件服务器，通常托管在 IDC 机房，有公网 IP。</td>
                    <td><CheckCircle2 size={14} style={{ color: 'var(--green)', verticalAlign: 'middle' }} /> 完全支持</td>
                  </tr>
                  <tr>
                    <td><b>NAT VPS</b></td>
                    <td>没有独立公网 IP 的 VPS，只能通过端口映射访问。部分 NAT VPS 可以做 Frp 服务端，但需要额外配置。</td>
                    <td><AlertTriangle size={14} style={{ color: 'var(--orange)', verticalAlign: 'middle' }} /> 有限支持</td>
                  </tr>
                  <tr>
                    <td><b>家宽 / 办公网络</b></td>
                    <td>家庭宽带或公司内网，通常没有公网 IP（或为动态 IP）。</td>
                    <td><XCircle size={14} style={{ color: 'var(--red)', verticalAlign: 'middle' }} /> 仅能做客户端</td>
                  </tr>
                </tbody>
              </table>
              <div className='tutorial-tip'>
                <b><Lightbulb size={13} /> 推荐：</b>对于个人使用，各大云厂商的「轻量应用服务器」性价比最高。腾讯云轻量应用服务器 2核2G 约 50-100 元/年，阿里云类似。购买时选择离你最近的地域（如上海、广州），延迟更低。
              </div>
            </div>

            <div className='tutorial-card'>
              <div className='tutorial-card-title'>服务器购买建议</div>
              <ul className='tutorial-steps'>
                <li><b>配置要求</b> — Frp 服务端非常轻量，1 核 512MB 内存即可满足个人使用。如果有更多需求（多人共用、大量代理），建议 1 核 1G 以上。</li>
                <li><b>带宽</b> — 带宽决定了穿透速度的上限。1Mbps 带宽理论下载速度约 128KB/s，3Mbps 约 384KB/s。个人使用建议 3Mbps 起步。</li>
                <li><b>操作系统</b> — 推荐 Ubuntu 22.04 / Debian 12 / CentOS Stream 9，本教程以 Ubuntu 为主。Windows Server 也可以运行 Frp，但 Linux 更省资源。</li>
                <li><b>地域选择</b> — 选择离你最近的地域。如果你在华东，选上海/杭州；华南选广州/深圳；华北选北京。</li>
                <li><b>防火墙</b> — 购买后记得在云厂商控制台的安全组中放行端口：7000（frps 管理端口）、7500（frps 面板端口，可选）、以及你计划暴露的服务端口范围（如 10000-20000）。</li>
              </ul>
            </div>

            <div className='tutorial-card'>
              <div className='tutorial-card-title'>第一步：在服务器上安装 Frps（服务端）</div>
              <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.8, marginBottom: 10 }}>
                Frps 是 Frp 的服务端程序，需要安装在有公网 IP 的服务器上。以下是各种安装方式：
              </p>

              <div className='tutorial-sub-title'>方式一：一键脚本安装（推荐新手）</div>
              <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.8, marginBottom: 10 }}>
                通过 SSH 登录服务器后，执行以下命令：
              </p>
              <div className='tutorial-code'>{`# 下载并执行一键安装脚本
curl -fsSL https://raw.githubusercontent.com/fatedier/frp/master/install.sh | bash

# 如果上面的命令无法访问（国内网络），使用镜像
curl -fsSL https://ghproxy.com/https://raw.githubusercontent.com/fatedier/frp/master/install.sh | bash`}
              </div>
              <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.8, marginBottom: 10 }}>
                脚本会自动下载最新版本并安装到 <code>/usr/local/bin/frps</code>。
              </p>

              <div className='tutorial-sub-title'>方式二：手动下载安装</div>
              <div className='tutorial-code'>{`# 查看最新版本：https://github.com/fatedier/frp/releases
# 以 v0.69.1 为例，Linux amd64 架构

# 下载
wget https://github.com/fatedier/frp/releases/download/v0.69.1/frp_0.69.1_linux_amd64.tar.gz

# 如果 GitHub 访问慢，使用镜像站
wget https://ghproxy.com/https://github.com/fatedier/frp/releases/download/v0.69.1/frp_0.69.1_linux_amd64.tar.gz

# 解压
tar -xzf frp_0.69.1_linux_amd64.tar.gz
cd frp_0.69.1_linux_amd64

# 复制到系统目录
sudo cp frps /usr/local/bin/
sudo chmod +x /usr/local/bin/frps`}
              </div>

              <div className='tutorial-sub-title'>方式三：Docker 安装</div>
              <div className='tutorial-code'>{`# 创建配置文件目录
mkdir -p /etc/frp

# 使用 Docker 运行 frps
docker run -d \\
  --name frps \\
  --restart always \\
  --network host \\
  -v /etc/frp/frps.toml:/etc/frp/frps.toml \\
  snowdreamtech/frps:latest`}
              </div>

              <div className='tutorial-sub-title'>方式四：宝塔面板安装</div>
              <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.8, marginBottom: 10 }}>
                如果你使用宝塔面板管理服务器，可以通过「软件商店」搜索 Frp 一键安装，或者使用宝塔的「Docker 管理器」部署 Frp 容器。
              </p>

              <div className='tutorial-sub-title'>Windows 服务器安装</div>
              <div className='tutorial-code'>{`# 从 GitHub Releases 下载 Windows 版本
# https://github.com/fatedier/frp/releases
# 下载 frp_x.x.x_windows_amd64.zip，解压后得到 frps.exe

# 用 PowerShell 测试运行
.\\frps.exe -c .\\frps.toml`}
              </div>
            </div>

            <div className='tutorial-card'>
              <div className='tutorial-card-title'>第二步：配置 Frps（服务端配置）</div>
              <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.8, marginBottom: 10 }}>
                创建配置文件 <code>/etc/frp/frps.toml</code>：
              </p>
              <div className='tutorial-code'>{`# frps.toml - 服务端配置

# Frp 服务端监听端口，客户端通过此端口连接
bindPort = 7000

# 认证方式和密钥（请修改为你自己的密码！）
auth.method = "token"
auth.token = "your-strong-password-here"

# Web 管理面板（可选）
webServer.addr = "0.0.0.0"
webServer.port = 7500
webServer.user = "admin"
webServer.password = "admin-password-here"

# 日志配置
log.to = "/var/log/frps.log"
log.level = "info"
log.maxDays = 7

# 允许客户端映射的端口范围
allowPorts = [
  { start = 10000, end = 20000 }
]`}
              </div>
              <div className='tutorial-warning'>
                <b><AlertTriangle size={13} /> 重要：</b>请务必修改 <code>auth.token</code> 为一个强密码！否则任何人都可以连接你的 Frp 服务端。
              </div>
            </div>

            <div className='tutorial-card'>
              <div className='tutorial-card-title'>第三步：设置开机自启</div>
              <div className='tutorial-sub-title'>Linux（systemd）</div>
              <div className='tutorial-code'>{`# 创建 systemd 服务文件
sudo tee /etc/systemd/system/frps.service << 'EOF'
[Unit]
Description=Frp Server Service
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 启用并启动服务
sudo systemctl daemon-reload
sudo systemctl enable frps
sudo systemctl start frps

# 查看运行状态
sudo systemctl status frps`}
              </div>

              <div className='tutorial-sub-title'>Windows（任务计划程序）</div>
              <ol className='tutorial-steps'>
                <li>按 <code>Win + R</code>，输入 <code>taskschd.msc</code> 打开任务计划程序。</li>
                <li>点击「创建基本任务」，名称填「Frp Server」。</li>
                <li>触发器选择「当计算机启动时」。</li>
                <li>操作选择「启动程序」，浏览选择 <code>frps.exe</code>，参数填 <code>-c frps.toml</code>。</li>
                <li>完成创建后，右键任务 → 属性 → 勾选「使用最高权限运行」。</li>
              </ol>
            </div>

            <div className='tutorial-card'>
              <div className='tutorial-card-title'>第四步：在本插件中配置 Frpc（客户端）</div>
              <ol className='tutorial-steps'>
                <li>点击左侧菜单「Frp 内网穿透」，进入 Frp 管理页面。</li>
                <li>在「服务器配置」区域填写你的服务器信息。</li>
              </ol>
              <div className='tutorial-step-detail'>
                <div><b>服务器地址</b> — 你的服务器公网 IP 或域名（如 <code>123.45.67.89</code>）</div>
                <div><b>端口</b> — frps 的监听端口，与服务端配置一致（默认 7000）</div>
                <div><b>Token</b> — 与服务端 <code>auth.token</code> 一致的密码</div>
              </div>
              <ol className='tutorial-steps' start='3'>
                <li>点击「测试端口」确认 frps 端口可以连通。此测试不校验 Token，认证结果以启动 frpc 后的日志为准。</li>
                <li>点击「保存配置」。</li>
                <li>点击「新建代理」，配置要暴露的服务。</li>
              </ol>
              <div className='tutorial-step-detail'>
                <div><b>TCP 代理</b> — 适合数据库、SSH、游戏服务器等。填写本地端口和远程端口。</div>
                <div><b>HTTP 代理</b> — 适合 Web 服务。填写本地端口和自定义域名。</div>
              </div>
              <ol className='tutorial-steps' start='6'>
                <li>在代理列表中点击「启动连接」，连接建立后即可通过服务器 IP + 端口（或域名）访问本地服务。</li>
              </ol>
            </div>

            <div className='tutorial-card'>
              <div className='tutorial-card-title'>代理类型详解</div>
              <table className='tutorial-table'>
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>适用场景</th>
                    <th>访问方式</th>
                    <th>示例</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><b>TCP</b></td>
                    <td>数据库、SSH、远程桌面、游戏服务器等基于 TCP 的服务</td>
                    <td><code>服务器IP:远程端口</code></td>
                    <td>本地 MySQL 3306 → 远程 13306，访问 <code>1.2.3.4:13306</code></td>
                  </tr>
                  <tr>
                    <td><b>HTTP</b></td>
                    <td>网站、API 服务、Webhook 接收等 HTTP 服务</td>
                    <td><code>自定义域名</code></td>
                    <td>本地 3000 → 域名 <code>app.yourdomain.com</code></td>
                  </tr>
                </tbody>
              </table>
              <div className='tutorial-tip'>
                <b><Lightbulb size={13} /> HTTP 代理需要域名：</b>使用 HTTP 代理时，你需要拥有一个域名，并将域名的 DNS 解析（A 记录）指向你的 Frp 服务器 IP。如果还没有域名，可以先使用 TCP 代理。
              </div>
            </div>

            <div className='tutorial-card'>
              <div className='tutorial-card-title'>安全建议</div>
              <ul className='tutorial-steps'>
                <li><b>使用强密码</b> — <code>auth.token</code> 至少 16 位，包含大小写字母、数字和特殊字符。</li>
                <li><b>限制端口范围</b> — 通过 <code>allowPorts</code> 限制可映射的端口范围，避免暴露不必要的端口。</li>
                <li><b>配置防火墙</b> — 只开放必要的端口。用 <code>ufw</code>（Ubuntu）或 <code>firewalld</code>（CentOS）管理。</li>
                <li><b>定期更新</b> — 关注 Frp 的版本更新，及时升级以获取安全补丁。</li>
                <li><b>不要暴露敏感服务</b> — 数据库、管理后台等敏感服务建议使用 Frp 的 STCP（密钥代理）模式，而非直接暴露 TCP 端口。</li>
                <li><b>监控日志</b> — 定期查看 frps 日志，发现异常连接。</li>
              </ul>
              <div className='tutorial-code'>{`# Ubuntu 防火墙示例
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 7000/tcp    # frps 管理
sudo ufw allow 7500/tcp    # frps 面板（可选）
sudo ufw allow 10000:20000/tcp  # 代理端口范围
sudo ufw enable`}
              </div>
            </div>

            <div className='tutorial-card'>
              <div className='tutorial-card-title'>故障排查</div>
              <table className='tutorial-table'>
                <thead>
                  <tr>
                    <th>问题</th>
                    <th>排查方法</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>客户端连接超时</td>
                    <td>① 检查服务器防火墙/安全组是否放行 7000 端口<br />② 检查 frps 是否在运行：<code>systemctl status frps</code><br />③ 用 telnet 测试：<code>telnet 服务器IP 7000</code></td>
                  </tr>
                  <tr>
                    <td>连接成功但无法访问服务</td>
                    <td>① 确认本地服务正在运行且监听正确端口<br />② 检查远程端口是否在防火墙/安全组中放行<br />③ 查看 frpc 日志是否有报错</td>
                  </tr>
                  <tr>
                    <td>HTTP 代理域名无法访问</td>
                    <td>① 确认域名 DNS 已解析到服务器 IP（<code>ping yourdomain.com</code>）<br />② 确认 frps 配置中未禁用 HTTP 代理<br />③ 检查是否需要配置 vhostHTTPPort</td>
                  </tr>
                  <tr>
                    <td>frpc 启动报错 "proxy already exists"</td>
                    <td>同名代理已存在，修改代理名称或先停止旧代理。</td>
                  </tr>
                  <tr>
                    <td>frpc 启动报错 "port already used"</td>
                    <td>远程端口已被其他代理占用，换一个端口号。</td>
                  </tr>
                  <tr>
                    <td>连接频繁断开</td>
                    <td>① 检查网络稳定性<br />② 在 frpc 配置中增加心跳间隔<br />③ 检查服务器资源（CPU/内存）是否充足</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className='tutorial-card'>
              <div className='tutorial-card-title'>高级配置参考</div>
              <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.8, marginBottom: 10 }}>
                如果需要更多高级功能（如 HTTPS 代理、负载均衡、端口复用等），可以参考 Frp 官方文档：
              </p>
              <ul className='tutorial-steps'>
                <li>官方文档：<code>https://github.com/fatedier/frp</code></li>
                <li>配置参考：<code>https://github.com/fatedier/frp#configuration</code></li>
                <li>示例配置：<code>https://github.com/fatedier/frp/tree/dev/conf</code></li>
              </ul>
            </div>
          </div>

          {/* ====== 综合 FAQ ====== */}
          <div className='tutorial-section'>
            <div className='tutorial-section-title'><HelpCircle size={20} /> 常见问题</div>
            <div className='tutorial-card'>
              <FaqItem k='faq1' q='DevTunnel 和 Frp 应该选哪个？'>
                <p><b>选 DevTunnel 的情况：</b>没有服务器、不想花钱、临时使用、对速度要求不高、需要快速上手。</p>
                <p style={{ marginTop: 8 }}><b>选 Frp 的情况：</b>有自己的服务器、需要长期稳定使用、对速度和延迟有要求、需要更灵活的配置。</p>
                <p style={{ marginTop: 8 }}>两者可以同时使用，互不影响。建议先用 DevTunnel 体验，有需要再搭建 Frp。</p>
              </FaqItem>
              <FaqItem k='faq2' q='Frp 服务端对服务器配置有什么要求？'>
                <p>Frp 服务端非常轻量，<b>最低 1 核 512MB 内存</b>即可。推荐配置：</p>
                <p style={{ marginTop: 4 }}>• 个人使用：1 核 1G，3Mbps 带宽</p>
                <p>• 小团队（5-10 人）：2 核 2G，5Mbps 带宽</p>
                <p>• 大量并发：2 核 4G，10Mbps 带宽以上</p>
                <p style={{ marginTop: 8 }}>带宽是主要瓶颈，Frp 本身 CPU 和内存占用极低。</p>
              </FaqItem>
              <FaqItem k='faq3' q='轻量应用服务器和标准云服务器有什么区别？'>
                <p>轻量应用服务器是云厂商推出的简化版产品，主要区别：</p>
                <p style={{ marginTop: 4 }}>• <b>价格更低</b>：通常比同配置标准云服务器便宜 30-50%</p>
                <p>• <b>功能简化</b>：不支持 VPC 高级网络、不支持挂载多块数据盘等</p>
                <p>• <b>套餐计费</b>：通常包含固定带宽和流量包，超出后限速</p>
                <p>• <b>预装镜像</b>：提供 WordPress、LAMP 等应用镜像一键部署</p>
                <p style={{ marginTop: 8 }}>对于运行 Frp 来说，轻量应用服务器完全够用，性价比更高。</p>
              </FaqItem>
              <FaqItem k='faq4' q='frpc.exe 从哪里获取？'>
                <p>两种方式：</p>
                <p style={{ marginTop: 4 }}>① <b>本插件自动检测</b>：如果你已安装 devtunnel，插件会自动在同目录下查找 frpc.exe。</p>
                <p>② <b>手动下载</b>：从 GitHub Releases 下载对应平台的版本，解压后将 frpc.exe 放到 devtunnel 同目录，或在设置中自定义路径。</p>
                <p style={{ marginTop: 8 }}>下载地址：<code>https://github.com/fatedier/frp/releases</code></p>
              </FaqItem>
              <FaqItem k='faq5' q='穿透的速度取决于什么？'>
                <p>穿透速度主要取决于以下因素：</p>
                <p style={{ marginTop: 4 }}>• <b>你的本地网络上行带宽</b>（通常是最大瓶颈）</p>
                <p>• <b>服务器的带宽</b>（Frp 模式下）</p>
                <p>• <b>中间网络链路质量</b>（DevTunnel 经过海外服务器，延迟较高）</p>
                <p>• <b>服务器与你的物理距离</b>（选近的服务器延迟更低）</p>
                <p style={{ marginTop: 8 }}>DevTunnel 适合调试和演示，Frp 内网穿透适合长期使用和对速度有要求的场景。</p>
              </FaqItem>
              <FaqItem k='faq6' q='Frp 支持 UDP 吗？'>
                <p>支持。Frp 支持 TCP、UDP、HTTP、HTTPS、STCP、SUDP 等多种协议。但本插件目前仅封装了 TCP 和 HTTP 两种最常用的类型。如需 UDP 代理，可以手动编辑 frpc.toml 配置文件。</p>
              </FaqItem>
              <FaqItem k='faq7' q='Frp 服务端被攻击怎么办？'>
                <p>常见防护措施：</p>
                <p style={{ marginTop: 4 }}>① 使用强密码（auth.token 至少 16 位随机字符串）</p>
                <p>② 配置 <code>allowPorts</code> 限制可映射端口范围</p>
                <p>③ 服务器安装 fail2ban 防暴力破解</p>
                <p>④ 云厂商安全组只放行必要端口</p>
                <p>⑤ 不使用时关闭 frps 服务</p>
                <p style={{ marginTop: 8 }}>如果发现异常流量，可以临时关闭 frps 并检查日志。</p>
              </FaqItem>
              <FaqItem k='faq8' q='可以多人共用一个 Frp 服务端吗？'>
                <p>可以。Frp 服务端支持多个客户端同时连接，每个客户端使用相同的 token 认证。只要代理名称和远程端口不冲突即可。适合团队共用一台服务器。</p>
              </FaqItem>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
