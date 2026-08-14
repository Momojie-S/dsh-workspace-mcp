# 设计总览：dsh-workspace-mcp

## 目标

- 按 workspace（session cwd）自动加载/卸载 MCP server：项目自己的 `.dsh/mcp.servers.yml` 只在自己的会话生效
- MCP 工具注册到 agent scope，随 agent 生灭自动回收，不同项目互不干扰
- **首步可见**：agent 创建即连接注册，首个模型请求就含 `mcp__*` 工具（[ADR-0003](decisions/0003-created-timing.md)）

## 非目标

- 不管理 DSH 全局 MCP 配置（那是 `dsh-mcp-client` patch 行的职责，本插件是它的 workspace 化包装）
- 不改变工具命名规则（`mcp__<server>__<tool>` 由 dsh-tools 决定）
- 不做 server 健康监控/自动重连（连接失败记日志，下次 pre-step 兜底重试）

## 工作原理

```
agent/created（global，fire-and-forget 异步连接）
  ↓
读 <cwd>/<configFile>（默认 .dsh/mcp.servers.yml）
  ↓
对每个 server：@modelcontextprotocol/sdk 连接 → 发现工具
  ↓
在 agent.ctx 注册工具（agent-scoped，随 agent 回收；disposer 插件自持）
  ↓
agent/pre-step 兜底：HMR 重载后已存在 agent 没有 created 事件，补初始化
  ↓
agent/disposed / fiber dispose：断开连接、卸载工具、清 watcher
```

- chokidar 监听配置文件，保存即重载（verbose 可看日志）
- 无配置文件的目录不加载任何 MCP

## 已知限制

- 改本插件代码需 `npx tsc` + 重启 DSH（Node ESM 缓存，通用限制）
- patch 的 `name` 必须指向 `lib/` 构建产物（曾因长期指向已废弃的热加载目录 `dist-dev-*` 出过会话毒化事故，该方案已删除）
