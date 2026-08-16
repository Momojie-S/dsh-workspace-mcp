# ADR-0005：会话失效主动判定（"Session not found" 盲区）

状态：accepted（2026-08）

## 背景

streamable-http 的 MCP 会话是有状态的：`initialize` 时 server 发 `mcp-session-id`，会话状态存 server 内存。server 重启 / 重新部署 / 会话空闲驱逐后旧 id 作废——但 HTTP 逐请求 POST、无常连可断，客户端 transport 毫无感知，下一次调用带着旧 id 收到 HTTP 404 + `{"code":-32600,"message":"Session not found"}`。

实测（SDK `@modelcontextprotocol/sdk` 1.12 源码核对）该错误**不会触发任何 `onclose`**：

- `StreamableHTTPClientTransport` 的 `onclose` 只在显式 `close()` 时触发；POST 收到非 2xx 走 `throw StreamableHTTPError` + `transport.onerror`，transport 保持"打开"
- 错误原样 reject 掉当次 `client.request()`，上抛为工具调用失败

而 ADR-0004 移植的 supervisor（官方 `dsh-mcp-client` 同源）**唯一断线信号是 `generation.onclose`**——于是：不判死、不重连，旧工具持续注册、每次调用同样失败，直到改配置文件（HMR reload）或重启 DSH。对 stdio 无影响（进程退出必触发 onclose）；对 streamable-http，"中途断线重连"实际只在连接阶段失败时工作过。官方 `dsh-mcp-client` 至今同样只挂 onclose，盲区是原版自带、移植时一并带上的。

## 备选

| 方案 | 结论 |
|------|------|
| 挂 `client.onerror`，任何 transport 错误即判断线 | 太激进：偶发 5xx、单次 POST 失败、SSE 抖动都会拆掉整个会话重新握手，好的会话被无辜重建 |
| 在 execute / 重同步失败路径上**分类识别**会话失效错误，命中才主动换代 | ✅ 精确命中本盲区；瞬时错误零误伤；识别即走既有退避/预算路径，无新增机制 |
| 等 SDK / 官方 client 修 | TS SDK 无自动 re-initialize；官方 client 未挂 onerror，无时间表，本仓插件等不起 |

## 决策

- `isSessionLossError`：`error.code === 404`（`StreamableHTTPError.code` 即 HTTP 状态；MCP streamable-http 规范里 404 = 会话未知/已终止）或消息匹配 `session not found / session (has )?expired / invalid or expired session / unknown session`。
- 两个上报点，命中即调 `reportSessionLoss(generation)`：
  1. 工具 `execute` 的 `tools/call` 失败（主要路径，即用户看到的报错来源）
  2. `ToolListChangedNotification` 重同步的 `tools/list` 失败（原 catch 只记日志，同为盲区）
- `reportSessionLoss` = `isCurrent` 守卫下记日志 → 后台 `close()` 旧代 → `generationDown`。并发多调用同时失败时守卫保证只有第一个生效；旧代 onclose 因 `isCurrent` 已失而幂等无害。之后完全复用 ADR-0004 的指数退避/预算/换代重注册。
- 本次调用仍失败上抛（重连期间旧工具保持注册的既有语义不变），模型下一步重试即命中新会话。
- 无新增配置项：这是检测缺口修复，不是新能力。

## 后果

- streamable-http server 重启/会话驱逐后：一次工具调用失败 + 自动重连（退避后一次 initialize），无需人工"强制重连"。
- 偶发 500 / 超时不会误拆会话（有测试断言 initialize 计数不变）。
- `buildToolDefinition` / `syncTools` 增加 `onSessionLoss` 回调参数（内部函数，无外部 API 影响）。
- 官方 `dsh-mcp-client`（全局 MCP patch 行）仍有此盲区——全局 MCP 遇 Session not found 依旧需要手动"删条目再贴回"强制重连，直到官方修复。
- 验证：`node test/session-loss.mjs`（内联最小 http MCP server，404 复刻真实报文）——失效后恰好一次重新握手恢复；500 不触发换代（2026-08 实测通过）。
