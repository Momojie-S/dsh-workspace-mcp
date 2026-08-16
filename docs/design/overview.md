# 设计总览：dsh-workspace-mcp

## 目标

- 按 workspace（session cwd）自动加载/卸载 MCP server：项目自己的 `.dsh/mcp.servers.yml` 只在自己的会话生效
- MCP 工具注册到 agent scope，随 agent 生灭自动回收，不同项目互不干扰
- **首步可见**：agent 创建即连接注册，首个模型请求就含 `mcp__*` 工具（[ADR-0003](decisions/0003-created-timing.md)）
- **断线自愈**：启动失败与中途断线自动重连 + 工具重注册（[ADR-0004](decisions/0004-reconnect-supervisor.md)，移植官方 dsh-mcp-client 的 supervisor）
- **会话失效自愈**：streamable-http server 重启/会话驱逐后的 "Session not found" 主动判定断线并换代重连（[ADR-0005](decisions/0005-session-loss-detection.md)，官方 dsh-mcp-client 亦有此盲区，本插件先修）

## 非目标

- 不管理 DSH 全局 MCP 配置（那是 `dsh-mcp-client` patch 行的职责，本插件是它的 workspace 化包装）
- 不改变工具命名规则（`mcp__<server>__<tool>` 由 dsh-tools 决定）

## 工作原理

```
agent/created（global，fire-and-forget 异步连接）
  ↓
读 <cwd>/<configFile>（默认 .dsh/mcp.servers.yml）
  ↓
对每个 server：supervisor 受监督连接（@modelcontextprotocol/sdk）
  连接 → 发现工具 → 在 agent.ctx 注册（agent-scoped，随 agent 回收）
  断线（onclose / 会话失效识别）/ 启动失败 → 指数退避重连（换代新 client）→ 重新注册
  toolListChanged 通知 → 工具列表重同步
  ↓
agent/pre-step 兜底：HMR 重载后已存在 agent 没有 created 事件，补初始化
  ↓
agent/disposed / fiber dispose：断开连接、卸载工具、清 watcher
```

- 每个 server 一条受监督连接：重连预算（默认 10 次，500ms→30s 指数退避），连接存活 ≥ maxDelayMs 重置预算；耗尽后卸载该 server 全部工具并停止
- 重连期间旧工具保持注册（模型可见性不抖动），但调用会失败直到换代完成
- chokidar 监听配置文件，保存即重载（verbose 可看日志）
- 无配置文件的目录不加载任何 MCP

## 已知限制

- 改本插件代码需 `npx tsc` + 重启 DSH（Node ESM 缓存，通用限制）
- patch 的 `name` 必须指向 `lib/` 构建产物（曾因长期指向已废弃的热加载目录 `dist-dev-*` 出过会话毒化事故，该方案已删除）
- 配置里 `stdio` 的 `env` / `http` 的 `headers` 只作用于**本插件发起的连接**；`streamable-http` server 的**进程环境**（如它需要的 `PYTHONPATH`）由启动方决定，DSH 配置够不着——需在启动方（daemon/GUI/脚本）注入。实例：sr_od 主 server 依赖 `PYTHONPATH=src`，最终落在 daemon/GUI 的 spawn 代码里显式注入，而不是任何 DSH 配置
