# ADR-0009：调用内重启自愈（丢弃旧代 → 等新代 → 重试一次）

状态：accepted（2026-11，演进自 ADR-0005）

## 背景

ADR-0005 解决了「Session not found 不判断线」的盲区：调用失败时识别会话失效、
主动换代重连——但**本次调用仍失败上抛**，模型看到错误后需自己再调一次。全局
AGENTS.md 的表述「重试几次即恢复」即此语义：恢复要消耗模型一轮往返，且模型
可能误判错误而放弃。

同时 ADR-0005 只覆盖 session 失效一类；server 重启**窗口中**的调用
（TCP 未监听 → `fetch failed ECONNREFUSED`）与网关场景（502/503）不在其列，
这类失败同样可安全重试却原样抛给模型。

2026-11 在官方 `@deepseek-ai/dsh-mcp-client` 上完整验证过方案可行性（含端到端
实测 516ms 恢复；官方包上的补丁已按主人裁定回滚，本 ADR 是其自研落地——实测
数据与测试工具见
`ops/home/patches/dsh-mcp-client-restart-recovery/README.md`，momojie-assistant 仓）。

## 备选

| 方案 | 结论 |
|------|------|
| 维持 ADR-0005：失败上抛 + 后台重连，模型重试 | 已验证不够：多一轮模型往返；重启窗口类（ECONNREFUSED/502/503）完全不覆盖 |
| 任何 transport 错误都重试一次 | 不可接受：ECONNRESET、超时、504 无法证明请求未到达 server，重放可能重复执行非幂等工具 |
| 错误分类 + 调用内换代重试一次（分类只放行「可证明未触达工具执行」的失败） | ✅ 安全性与无感知兼得 |

## 决策

- **分类器**（`src/diagnostic.ts`，鸭子类型判形不依赖 SDK 错误类）：
  - session-lost：HTTP 404（新 SDK `.status` / 老 SDK `.code`）、JSON-RPC
    -32001（非超时文案）、会话失效文案（沿用 ADR-0005 宽匹配）
  - server-unreachable：502/503；ECONNREFUSED / ENOTFOUND / EAI_AGAIN
    （沿 cause 链 + `AggregateError.errors` 递归找 syscall code，深度上限 8）
  - **刻意不分类**：ECONNRESET、超时、abort、504、其余 5xx、业务错误
    （含 server 侧 "unknown tool"）——请求可能已到达并执行，原样上抛
  - 跨 SDK 撞码防御：老 SDK（@modelcontextprotocol/sdk 1.x）的本地超时
    `McpError(-32001, "Request timed out")` 与 server 会话失效码撞号，
    -32001 命中时先排除超时文案
- **调用桥**：`buildToolDefinition` 的 execute 不再闭包捕获注册时的那代
  client，改经 `supervision.invokeWithRecovery` 转发到**调用时刻的当前代**
  ——换代后旧注册的 execute 天然可用（ADR-0005 时代 execute 绑死代，换代
  竞速窗口内调用必失败）
- **恢复流程**（`invokeWithRecovery`）：当前代上执行 → 失败分类命中 →
  `forceReconnect` 丢弃当前代（复用 ADR-0004 既有退避/预算重连循环）→
  等新代就绪（预算 `min(toolCallTimeoutMs, 30s)`）→ 在新代上重试原调用
  一次；第二次失败原样上抛。无新增配置项
- **等待机制**：supervisor 维护代就绪等待者集合，连接成功 / 重连放弃 /
  重连禁用 / 失败代未关闭 / dispose 时 settle；等待失败或超预算一律上抛
  **原始调用错误**（对模型更有用）
- **并发**：`isCurrent` 守卫天然让并发撞同一重启的调用共享一次重建；但
  `Client.close()` 会把同代仍在飞行中的请求同步 reject 为
  `McpError(-32000, "Connection closed")`——对**被本 supervisor 主动 close
  的代**（WeakSet 标记）产生的该错误定向豁免为 session-lost：close 的前提
  是并发调用已证实 session 死亡，受害请求在 server 侧必然同样未执行。
  其余来源的 -32000（如 stdio 进程死亡）维持不可重试
- toolListChanged 重拉取失败路径同步扩展：命中任一分类即换代（原只识别
  session 失效文案）

## 后果

- streamable-http server 重启后：撞错的调用在同一次 execute 内自动恢复
  （退避 100ms 配置下实测 ~120-320ms），模型无感知；重启窗口中的调用在
  窗口短于 `min(toolCallTimeoutMs, 30s)` 时同样无感知恢复
- ECONNRESET / 超时 / abort / 504 / 业务错误语义不变，原样上抛（测试断言
  调用计数不增）
- 恢复等待受调用超时约束：预算耗尽 / 重连放弃时模型看到原始错误，与
  ADR-0005 时代行为一致（可手动重试）
- `Supervision` 接口变化：`reportSessionLoss` 移除，新增
  `invokeWithRecovery`；`buildToolDefinition` 签名随之变化（内部函数，
  无外部 API 影响）
- 官方 `dsh-mcp-client`（全局 MCP patch 行）仍无此能力——全局 MCP 的恢复
  仍靠「删条目再贴回」或模型自行重试
- 验证：`node test/classify.mjs`（33 用例：新老 SDK 形态 / 真实样本 /
  撞码排除 / cause 环）+ `node test/restart-recovery.mjs`（ECONNREFUSED
  窗口恢复 / 预算耗尽抛原始错误 / 挂起超时不重试 / 并发共享重建）+
  `node test/session-loss.mjs`（404 调用内恢复 / 偶发 500 不拆会话）
