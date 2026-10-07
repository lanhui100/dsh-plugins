# Agent Note: Invalidate baseline cache on reconnect and fix token rotation

Status: implemented

## Problem

用户在使用 `dsh-plugin-remote-ssh` 连接远端主机时反馈：
当远端主机的 `dsh` 服务停止重启后，当前插件重新连接该远程主机，侧边栏中的远端工作区变成了“未知工作区”（`unknown-workspace`）。

经 Dev Team 源码诊断，存在以下三个连锁根因：
1. **日志 Token 读取过时（Token Rotation 失效）**：
   在 `src/remote.ts` 的 `readLaunchToken` 中，此前使用的脚本是 `grep -o "?token=[A-Za-z0-9_-]*" ${logPath} | head -1`。由于远端日志文件通常是追加写入（append），远端 `dsh` 重启后新生成的进程 launch token 被记录在日志末尾，而 `head -1` 读取到的永远是首次启动的历史旧 token，导致向远端发送的 token exchange 认证无法获取新 Cookie。
2. **WebSocket Baseline 握手无重试与重新鉴权机制**：
   `RemoteCaller.fetchWorkspaceBaseline()` 通过 WebSocket multiplexer（`/api/remote.mux`）建立长连接订阅工作区基线。当远端重启、旧 Cookie 变为无效时，WebSocket 握手直接被远端拒绝关闭。此前 `fetchWorkspaceBaseline` 缺少像 HTTP RPC `invoke` 一样的 401/握手失败自动清理 Cookie 并重新执行 token exchange 的自我修复重试机制。基线请求失败后降级为空，导致工作区无法映射实际目录。
3. **隧道重建与断线时未主动清理工作区 Baseline 缓存**：
   `RemoteCaller` 在内存中缓存了 `cachedBaseline`（有效期 45 秒）。在隧道断开或恢复（`onTunnelDown` / `onTunnelReady`）时，没有调用 `this.clearBaselineCache()`。如果远端重启后很快重连，45 秒内依然沿用重启前的旧基线，或者因旧连接状态残留导致工作区匹配失败降级为“未知工作区”。

## Decision

1. **修正 Token 读取为最新生成项（`tail -1`）**：
   在 `src/remote.ts` 中将提取 launch token 的 shell 命令由 `head -1` 修改为 `tail -1`，确保远端重启后总是获取最新进程的有效 token。
2. **添加 Baseline 获取失败后的 Cookie 清理与重试机制**：
   在 `fetchWorkspaceBaseline` 中包装内部获取逻辑 `fetchWorkspaceBaselineInternal`，如果初次 WebSocket 握手或协议解析异常，立即调用 `this.jar.clear()` 强制重新完成 token 认证交换并重试一次，自愈远端服务重启造成的认证状态轮转。
3. **在隧道生命周期变更中使 Baseline 缓存失效**：
   在 `RemoteCaller.onTunnelReady()` 和 `onTunnelDown()` 中，均显式调用 `this.clearBaselineCache()`，确保重连后总是向远端拉取全新的权威工作区基线。
4. **补充机械验证测试**：
   在 `smoke-keepalive.mjs` 中添加针对 `RemoteCaller.onTunnelDown()` 和 `onTunnelReady()` 清理 `cachedBaseline` 缓存的断言用例。

## Alternatives considered

- **在远端停止重启时由本地清空日志文件**：
  被否决。远端日志属于远端运维所有，且本地插件无权且不应随意 truncate 远端系统日志。读取日志最新条目 `tail -1` 是遵循标准 UNIX 设计的最佳实践。
- **取消 Baseline 本地缓存**：
  被否决。移除缓存会导致前端每次短轮询都向远端发起 WebSocket 基线订阅，极大增加隧道与远端负载。在隧道断连与恢复时定向失效缓存（Cache Invalidation）既保证了时效性，又维持了高性能。

## Consequences

- 远端 `dsh` 服务停止重启后，插件重连远端主机能够准确换取新 token 与有效 Cookie。
- 权威工作区基线在重连时被正确刷新，远端各工作区目录准确呈现，彻底解决降级为“未知工作区”的缺陷。
- 全套测试（包含 17 项 smoke 测试套件）全部通过。
