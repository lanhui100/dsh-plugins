# 决策记录：SSH 隧道保活与 `$events` 自动重连加固

- 日期：2026-10-05
- 状态：implemented
- 影响范围：`dsh-plugin-remote-ssh` (`tunnel.ts`, `remote.ts`, `manager.ts`, `config.ts`, `index.ts`, `README.md`)
- 关联决策：加固并扩展 `.agents/notes/implemented/architecture/2026-09-30-tunnel-token-cookie-rpc-path.md` 中的隧道子进程管理与重连策略

## 背景与问题
1. 原 SSH 隧道重连虽采用 Full Jitter，但缺乏延迟下限保护，极值可能产生 0ms 重试风暴；且 `dispose()` 期间若遇退避等待，未唤醒 Promise 会导致挂起死锁。
2. `config.ts` 未声明高级保活参数，且 `index.ts` 到 `manager.ts` 的透传链路断裂，导致保活配置无法下发。
3. `RemoteCaller` 中的 `$events` WebSocket 断线无自动重连，一旦网络闪断或远端重启，模型提问卡片（`ask_user_question`）永久失联。
4. 本地端口分配原本仅依靠内存最大值自增，缺乏操作系统级端口占用探测。

## 决策内容
1. **带下限的 Full Jitter 与无阻塞 Dispose**：
   - 隧道退避间隔保证至少 1000ms（`MIN_RECONNECT_DELAY_MS`），避免 0 延迟突发。
   - `SshTunnel` 引入 `backoffResolve`，在 `dispose()` 时主动唤醒挂起的退避 Promise，实现毫秒级平稳退出。
2. **端到端保活参数配置透传**：
   - `config.ts` 补充 `reconnectDelayMs`, `reconnectMaxDelayMs`, `serverAliveInterval`, `serverAliveCountMax`, `connectTimeout`, `tcpKeepAlive`。
   - `index.ts` 和 `RemoteHostManager` 全量透传上述参数至各主机的 `SshTunnel`；动态 `addHost` 自动继承全局选项。
3. **隧道状态驱动的 `$events` 自愈机制**：
   - `SshTunnel` 增加 `onReady` 与 `onDown` 生命周期回调，动态同步 `entry.isReady`。
   - 隧道断开时 `onTunnelDown()` 挂起 `$events` 轮询重连并清空失效 Cookie，消除网络中断期间的高频 SSH 探测。
   - 隧道恢复时 `onTunnelReady()` 立即唤醒 `$events` 重置退避计数并发起连接。
   - `ensureEventsListener` 引入 `eventsConnecting` 单飞锁防止并发重入。
4. **端口分级策略**：
   - 静态主配置端口冲突严格报错（Fail-Fast）。
   - 动态端口通过 `net.createServer` 预检空闲状态并自动顺延寻优（Auto-hunt）。
5. **交互卡片防御**：
   - `respondRemoteEvent` 增加 `finally` 块确保异常时（如 400 过期）同步清理内存中的挂起卡片并派发取消通知，杜绝幽灵卡片残留。

## Alternatives considered
- **仅依赖应用层周期心跳**：被否决。SSH 子进程自带 `ServerAliveInterval` 与 `TCPKeepAlive`，应用层叠加密集心跳会增加跨包开销并造成误判。
- **断线立即全量取消交互卡片**：被否决。短时闪断时若立即清空，会导致用户正在输入的表单丢失；重连后更新 `clientId` 并在应答失败时兜底清理是更优解。
- **运行时动态漂移静态配置端口**：被否决。主配置端口被占多为孤儿僵尸进程所致，私自漂移会破坏外部访问契约并掩盖系统泄漏。
