# 设计总览：dsh-workspace-mcp

## 目标

- 按 workspace（session cwd）自动加载/卸载 MCP server：项目自己的 `.dsh/mcp.servers.yml` 只在自己的会话生效
- MCP 工具注册到 agent scope，随 agent 生灭自动回收，不同项目互不干扰
- 懒加载：agent 不工作就不建立连接

## 非目标

- 不管理 DSH 全局 MCP 配置（那是 `dsh-mcp-client` patch 行的职责，本插件是它的 workspace 化包装）
- 不改变工具命名规则（`mcp__<server>__<tool>` 由 dsh-tools 决定）
- 不做 server 健康监控/自动重连（连接失败记日志，下次 pre-step 重试）

## 工作原理

```
agent/pre-step（agent 首次真正干活，ctx active）
  ↓
读 <cwd>/<configFile>（默认 .dsh/mcp.servers.yml）
  ↓
对每个 server：@modelcontextprotocol/sdk 连接 → 发现工具
  ↓
在 agent.ctx scope 注册工具（agent-scoped，随 agent 回收）
  ↓
agent/disposed：断开连接、卸载工具
```

- chokidar 监听配置文件，保存即重载（verbose 可看日志）
- 无配置文件的目录不加载任何 MCP

## 已知限制

- 改本插件代码需 `npx tsc` + 重启 DSH（Node ESM 缓存，通用限制）
- patch 的 `name` 必须指向 `lib/` 构建产物（曾因长期指向已废弃的热加载目录 `dist-dev-*` 出过会话毒化事故，该方案已删除）
