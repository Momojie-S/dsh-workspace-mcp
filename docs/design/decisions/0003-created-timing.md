# ADR-0003：注册时机前移至 agent/created（pre-step 降级为兜底）

状态：accepted（2026-08）

## 背景

[ADR-0001](0001-agent-pre-step-timing.md) 选 pre-step 的原因是"created 时 ctx inactive，注册失败"。但 pre-step 的代价是结构性的：`assembly.tools` 在首个 pre-step **之前**组装，pre-step 内的注册永远赶不上本步工具集——工具从第 2 步才可见，headless 单步任务全程看不到。

重新实测 `agent/created`：**`agent.ctx` 在此事件上可安全 `tools.register`**。当初的 inactive 限制来自"依赖 `agentCtx.effect` 注册"（fiber 未激活时 effect 不可用）；改为不依赖 `agentCtx.effect`——disposer 由本插件自持，`agent/disposed` 与 fiber dispose 统一清理——限制即消失。

## 备选

| 方案 | 结论 |
|------|------|
| 维持 pre-step | 稳但慢：首步永远没有工具，单步任务不可用 |
| `agent/created` fire-and-forget | ✅ created 是唯一早于 `assembly.tools` 组装的钩子 |
| 维持 + `session/created` | ❌ 仍无 agent 上下文，无意义 |

## 决策

- `agent/created`（global）：立即异步连接 + 注册（fire-and-forget）
- `agent/pre-step`（global）：保留为**兜底**——插件 HMR 重载后，已存在的 agent 不会再收到 created 事件，首个 pre-step 补初始化（await，自下一步可见）
- 工具/连接清理不由 agentCtx 管理，插件自持 state，`agent/disposed` + fiber dispose 清理

## 后果

- web 场景首个模型请求即含 `mcp__*` 工具（created 与首条消息间有秒级间隔，localhost MCP 握手毫秒级完成）
- headless "create 后立刻 followup" 仍是竞速：输了则第 2 步可见（可接受，非同步通道无解）
- 懒加载语义弱化：agent 创建即连接，不干活也会连（轻微资源代价，换首步可见）
- 双钩子并存，去重集合 `initedAgents` 保证幂等

## 验证记录（2026-08-14 实测）

关键事实来自 DSH 源码 `agent-loop/src/agent.ts` 的 `preStep()`：`systemPrompt.assemble()`（产出 `assembly.tools`）在 `agent/pre-step` waterfall **之前**执行，所以 pre-step 内的注册/等待都无法影响本步工具集——这不是实现瑕疵，是组装顺序的结构性事实。

验证链（会话日志 request/header 信封 + 行为）：

| 实验 | 结果 |
|---|---|
| 动态插件在 `agent/created` 里于 `agent.ctx` 注册探针工具 → 后台子代理 | 注册无异常；子代理**首个请求信封**即含探针；第一个动作直接调用成功 |
| pre-step 时机（旧版，StarRail 工作区） | 单步问答的请求信封 `mcp__sr_od*` 计数 = 0——"插件不生效"体验的根因 |
| created 时机（新版，StarRail 工作区，headless） | request 1 = 0（create 后立即 followup，竞速输）；request 2 = 34 个 sr_od 工具 |
| 曾尝试"pre-step 有界等待 created 完成" | **无效**：本步工具集已定型，等待只拖慢首步——已删除，勿复发 |

辅助结论：`agent/created` 的 inactive-ctx 限制只影响"依赖 `agentCtx.effect` 注册"的写法（effect 需激活的 fiber）；插件自持 disposer 即不受限。
