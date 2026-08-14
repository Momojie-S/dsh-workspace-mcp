# ADR-0001：注册时机选 agent/pre-step，而非 session/created

状态：**superseded by [ADR-0003](0003-created-timing.md)**（2026-08）

> 当时的决策被 0003 取代：实测发现 `agent/created` 事件上 `agent.ctx` 可安全
> `tools.register`（不依赖 `agentCtx.effect` 即不受 inactive 限制），注册时机
> 前移到 created。本 ADR 保留原始调研与推理，结论已过时。

## 背景

MCP 工具要在合适的生命周期事件里注册：既要 ctx 处于 active 状态（否则注册失败），又要尽量早（agent 第一步就能用工具）。

## 备选

| 时机 | 结论 |
|------|------|
| `session/created` | ❌ 此时 `agent.ctx` 还是 inactive，在其上注册工具直接失败 |
| `agent/pre-step` | ✅ agent 真正开始工作、ctx 已 active 的最早可靠时机 |

## 决策

监听 `agent/pre-step`，首次触发时读配置、连接、注册。

## 后果

- 注册可靠（ctx active 是被验证过的前提）
- 意外收获懒加载语义：agent 不干活（纯人机对话）就完全不碰 MCP 连接
- pre-step 每步都触发，需要内部去重（每个 agent 只初始化一次）
- **遗留代价**（0003 的动因）：`assembly.tools` 在首个 pre-step 之前组装，pre-step 内的注册只能从第 2 步起可见；headless 单步任务全程看不到工具
