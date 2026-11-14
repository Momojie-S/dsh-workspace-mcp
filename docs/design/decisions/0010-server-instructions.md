# ADR-0010：server instructions 注入 system prompt（per-agent scoped section）

状态：accepted（2026-11）

## 背景

官方 dsh-mcp-client（全局/profile 级）连接成功后把握手返回的 server instructions 以 `### MCP server: <名>` 包装注册进 system prompt（`server-context.ts` 的 `systemPrompt.section`，`mcp:<server>` 名、`MCP_SERVERS` 排序位、32KB 字节上限、超限按连接失败处理）。本插件此前只消费 tools，instructions 在握手后被丢弃——同一 server 走全局挂载有引导文字、走项目级挂载没有，行为分裂（sr_od 的截图分辨率/坐标全局口径即实际受害案例）。

MCP 协议层 constraints：instructions 是 InitializeResult 里的**单个可选字符串**（一 server 一份、握手时定、无运行时更新机制）；prompts 能力（`prompts/list`）两侧客户端均不消费，不在本 ADR 范围。

## 备选

| 方案 | 结论 |
|------|------|
| per-agent scoped section（本 ADR） | ✅ 与插件既有的 per-agent 注册生命周期同构；同名 server 跨 workspace 天然隔离 |
| 插件 global layer 注册一个 section | ❌ section 名 `mcp:<server>` 在全局层唯一——两个 workspace 配同名 server（合法场景）会撞 `already registered` 抛错 |
| 连接级注册、订阅者共享 | ❌ 等价 global 层问题；且订阅者退订时无法单独摘除自己的 section |
| 不注入（现状） | ❌ 与官方行为分裂；server 侧无替代通道（prompts 不消费、tool description 放不下跨工具口径） |

## 决策

- **语义逐项对齐官方**：connect 成功后立即 `client.getInstructions()?.trimEnd()`，包装成 `### MCP server: <名>\n\n<正文>`（空声明 → 空串）；超 `maxInstructionBytes`（默认 32768，per-server 可覆盖）→ 该次连接尝试失败、走既有重连路径（官方 McpLocalError 同语义）。快照存连接层，断线不清、重连成功后整体替换（官方 `serverInstructions` 同语义）——section 的 text 惰性读快照，重连换代内容自动跟上。
- **section 挂 per-agent scope layer**：经订阅者的 `agentCtx.systemPrompt.section({...})` 注册（`mcp:<server>` 名、`getSectionOrder('MCP_SERVERS')`、`interpolate: false`）。机制依据：cordis 的 `getTraceable` proxy 使 `agentCtx.systemPrompt` 的 `.ctx` 解析到访问方 ctx（useSite），`ScopedLayers.effect` 按 `scopeOf(ctx)` 落层——agent ctx 带 `createScope` 标记，section 落进该 agent 的 layer；agent-loop 组装时 `assembleContextFor` 传 `scope: agent`，恰好可见。同名 section 跨 agent 各自一层互不冲突；agent 销毁时 scope fiber 卸载自动兜底清理。
- **与工具同一份 disposers 管理**：section disposer 放订阅者的 `disposers` Map（键 `section:mcp:<server>`），退订/given-up/两阶段置换统一清理——given-up 卸工具时一并摘引导文字，避免「server 不可用但使用说明还在 prompt 里」的误导态。
- **与工具注册分离容错**：agentCtx 无 systemPrompt 服务（headless 形态、测试桩）时记日志跳过，不影响该订阅者的工具注册；section 注册抛错只记日志，不触发工具整代回滚（工具是主功能，回滚纪律仍只覆盖工具注册面）。

## 后果

- 项目级挂载的 server 现在与全局挂载行为一致：跨工具全局口径进 system prompt；配合 MCP 官方 blog 的写作指导（只放全局口径、不写手册）server 侧无需改动。
- section 文本随 workspace 生灭：切到无配置 workspace 后该 section 不再出现（订阅退订同步清理）——与工具可见性同构。
- 新增 per-server 配置项 `maxInstructionBytes`（默认 32768）；server 侧声明超长 instructions 会表现为**连接失败反复重连**（官方同语义；处置是 server 精简文本或调大上限，而非静默截断）。
- 局限（记录，不处理）：section 注册走 agentCtx 的 traceable proxy 机制，若未来 cordis 改变 useSite 语义（`.ctx` 不再解析到访问方），section 会落到 global 层并在多 workspace 同名时暴露——`test/instructions.mjs` 锁住注册路径形状，回归可见。
- 版本 0.5.0。
- 验证：`node test/instructions.mjs` 六场景（注册形状逐项断言 / 快照稳定性 / 退订清理 / 防御跳过 / 超限拒绝 / 放行上限）+ 原十九个测试回归，2026-11 实测全过。
