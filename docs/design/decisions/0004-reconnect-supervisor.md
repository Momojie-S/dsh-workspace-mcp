# ADR-0004：断线自动重连（移植官方 dsh-mcp-client 的 supervisor）

状态：accepted（2026-08）

## 背景

实测发现两个真实缺口，且 overview 旧文档的描述失实：

1. **会话中断线永久挂死**：`connectAndRegister` 拿到 client 后无人监听 `onclose`。stdio 子进程崩溃/被杀、HTTP server 重启后，工具注册原样保留，此后每次调用抛 SDK 的 `Not connected`，直到会话结束。
2. **启动时连不上永不重试**：首试失败只记日志。旧文档声称"下次 pre-step 兜底重试"，但 `initedAgents.add(agent)` 在首次初始化时就同步加入，pre-step 只认"从未初始化"的 agent（HMR 兜底场景）——该重试路径实际不存在。

唯一的"重连"手段是改配置文件触发 chokidar reload（全局 AGENTS.md 的"强制重连"技巧），纯手动。

对照官方 `@deepseek-ai/dsh-mcp-client`（DSH 当前版本）：已有一套完整 connection supervisor——onclose 驱动、指数退避、预算耗尽放弃、close 竞态防护、toolListChanged 重同步。本插件当初只对齐了工具结果处理（RawCallToolResultSchema/extractText），生命周期没跟上。

## 备选

| 方案 | 结论 |
|------|------|
| 移植官方 supervisor（per-server 受监督连接） | ✅ 行为与官方对齐，两缺口一次补齐，顺带获得 toolListChanged 重同步 |
| 最小修复：onclose → 整文件 reloadAgent | 代码量最小，但粒度粗（一个 server 断线重连同文件所有 server）、无退避/预算控制、易进程重叠 |
| 只改文档 | 缺口仍在，长会话遇 server 重启即挂死 |

## 决策

- **逐行移植官方 supervisor 语义**到 `mcp.ts` 的 `startSupervisedConnection`：每次尝试换代全新 Client+transport（SDK 把 Protocol 绑死单 transport）；`generation.onclose` 驱动断线检测；指数退避 `initialDelayMs * 2^(n-1)` 封顶 `maxDelayMs`；连接存活 ≥ `maxDelayMs` 重置预算；耗尽后卸载该 server 全部工具并停止（改配置文件或重启是唯一恢复路径）；失败一代 5s 未确认关闭则停止（防 stdio 进程重叠）；监听 `ToolListChangedNotification` 重同步。
- **配置两层**：插件级 `reconnect`（patch config，Schemastery 默认值 = 官方默认）+ yml per-server 同名项逐项覆盖（`resolveReconnectPolicy` 合并并重判边界）。
- 工具换代替换沿用官方两阶段 syncTools：fetch 全部成功才 dispose 旧代注册新一代；断线期间旧工具**保持注册**（可见性不抖动，调用失败等换新）。
- 放弃官方的 `failOnStartupError`/`ready`-await 维度：agent-scoped fire-and-forget 场景（ADR-0003）没有同步启动语义，失败走重连策略即可。

## 后果

- 启动失败从"永久跳过"变为"退避重试"：server 比 DSH session 晚起的场景自愈。
- 中途断线自愈：stdio = 重新 spawn，http = 重新握手；重连成功后工具按新列表重新注册。
- `ServerHandle`/`connectAndRegister`/`disposeServer` 被 `SupervisedServer` 取代；`dispose()` 变 async（reload 时 await，等 transport 静默关闭防进程重叠；agent/disposed 同步事件里 fire-and-forget）。
- crash-loop 的 server 在预算耗尽后彻底安静（工具卸载，不再无限重启），verbose 日志给出恢复路径。
- 验证：`npm test` 两条 smoke——杀子进程自动重连恢复 / 启动失败退避重试后放弃且无工具注册（2026-08 实测通过）。
