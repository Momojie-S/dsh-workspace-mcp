# ADR-0002：工具注册到 agent scope，而非全局

状态：accepted（2026-08）

## 背景

MCP 工具注册有 scope 选择：全局 ctx（插件生命周期存活）或 agent.ctx（随 agent 生灭）。本插件的核心诉求是 workspace 隔离，scope 决定隔离边界。

## 备选

| scope | 结论 |
|------|------|
| 全局注册 | ❌ 工具跨 agent、跨 workspace 存活——A 项目的 MCP 工具会泄漏到 B 项目的会话，正是要消灭的问题 |
| agent-scoped（`agent.ctx`） | ✅ 工具与 agent 同生命周期，agent 结束自动卸载、连接自动断开 |

## 决策

在 `agent.ctx` 上注册，`agent/disposed` 时断开 MCP 连接、清理工具。

## 后果

- 隔离天然成立：换 workspace = 换 agent = 换工具集，无需手动卸载逻辑
- 代价：同一 session 内 agent 重建会重连 MCP（连接开销换正确性，可接受）
- 依赖 ADR-0001 的时机配合：必须在 ctx active 后才能往 agent.ctx 注册
