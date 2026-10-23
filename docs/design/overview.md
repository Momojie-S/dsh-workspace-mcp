# 设计总览：dsh-workspace-mcp

## 目标

- 按 workspace（session cwd）自动加载/卸载 MCP server：项目自己的 `.dsh/mcp.servers.yml` 只在自己的会话生效
- MCP 工具注册到 agent scope，随 agent 生灭自动回收，不同项目互不干扰
- **首步可见**：agent 创建即连接注册，首个模型请求就含 `mcp__*` 工具（[ADR-0003](decisions/0003-created-timing.md)）
- **断线自愈**：启动失败与中途断线自动重连 + 工具重注册（[ADR-0004](decisions/0004-reconnect-supervisor.md)，移植官方 dsh-mcp-client 的 supervisor）
- **会话失效自愈**：streamable-http server 重启/会话驱逐后的 "Session not found" 主动判定断线并换代重连（[ADR-0005](decisions/0005-session-loss-detection.md)，官方 dsh-mcp-client 亦有此盲区，本插件先修）
- **官方对齐**：stdio scrubbed 父环境继承、重复 raw name 守卫、注册冲突整代回滚、outputSchema→structuredContent 输出契约、taskSupport=required 明确拒绝（[ADR-0006](decisions/0006-official-parity.md)）
- **连接共享**：同一 workspace 的同一 server 条目只保留一份 server 进程，全体 agent 共用——进程份数不随会话/子 agent 数膨胀（[ADR-0008](decisions/0008-shared-connections.md)）

## 非目标

- 不管理 DSH 全局 MCP 配置（那是 `dsh-mcp-client` patch 行的职责，本插件是它的 workspace 化包装）
- 不改变工具命名规则（`mcp__<server>__<tool>` 由 dsh-tools 决定）

## 工作原理

```
agent/created（global） / agent/pre-step（自检自愈，幂等）
  ↓ 同步段：liveAgents 登记（无条件，先于文件存在）+ watcher 空↔非空跃迁
读 <cwd>/<configFile>（默认 .dsh/mcp.servers.yml）
  ↓ 对每个 server 条目：连接注册表 get-or-create（键 = normalize(path)+serverName）
共享连接层（每条目一份，全体 agent 共用）：
  连接 → fetch 工具（tools/list + 冲突守卫）→ 分发到各订阅者（per-agent 注册）
  断线（onclose / 会话失效识别）/ 启动失败 → 指数退避重连（换代新 client）→ 重新分发
  toolListChanged 通知 → 重拉 → 重分发
  重连预算耗尽（given-up）→ 卸载订阅者工具（条目保留）；新订阅重开预算重建 → 旧订阅者随共享恢复
  dispose/删除条目 → 树杀兜底（ADR-0007）
注册层（不变，per-agent）：
  每个订阅者持自己的注册清单（definitions 按订阅者实例化），随 agent 卸载
path 级（每配置文件一份）：
  watcher（liveAgents 空↔非空跃迁创建/关闭）→ 文件变化 → reload
  reload = dirty 终止循环（pass 清零/内再置位/补跑至干净）+ 收尾三件事（dirty 清零/
  liveAgents×yml 对账/空则回收），覆盖含配置读取失败在内的全部退出路径
  条目删除/变化 → 立即 dispose（树杀联动）；保留条目 → 结构化深比较决定重建或复用
订阅者离开：agent/disposed 同步段摘 liveAgents + 扇出退订；refs 归零 → grace（idleDropMs）
  到期回收连接；grace 窗口内重订复用
```

- 连接级状态变更全部入连接串行链（任务执行先过活性守卫）；path 级状态触点全在同步段——并发纪律详见 [ADR-0008](decisions/0008-shared-connections.md)
- 重连期间旧工具保持注册（模型可见性不抖动），但调用会失败直到换代完成
- stdio 子进程环境 = scrubbed 父环境（剥凭据形状名与 `DSH_*`）+ yml `env` 覆盖层（[ADR-0006](decisions/0006-official-parity.md)，与全局 MCP 一致）
- server 声明受支持的 outputSchema 时进 `structuredContent` 输出契约（required + additionalProperties:false）；重复 raw name / 注册名字被占 → 整代拒绝/回滚，不留半代状态
- 无配置文件的目录不加载任何 MCP

## 已知限制

- 改本插件代码需 `npx tsc` + 重启 DSH（Node ESM 缓存，通用限制）
- patch 的 `name` 必须指向 `lib/` 构建产物（曾因长期指向已废弃的热加载目录 `dist-dev-*` 出过会话毒化事故，该方案已删除）
- 配置里 `stdio` 的 `env` / `http` 的 `headers` 只作用于**本插件发起的连接**；`streamable-http` server 的**进程环境**（如它需要的 `PYTHONPATH`）由启动方决定，DSH 配置够不着——需在启动方（daemon/GUI/脚本）注入。实例：sr_od 主 server 依赖 `PYTHONPATH=src`，最终落在 daemon/GUI 的 spawn 代码里显式注入，而不是任何 DSH 配置
- 连接共享后，server 单进程是该 workspace 全体 agent 的共享吞吐上限（重 server 被多 agent 并发调用时按到达率排队；与 per-agent 时代的「互不影响」相比是接受的取舍，见 [ADR-0008](decisions/0008-shared-connections.md)）
- reload 防抖窗口（默认 500ms + chokidar 写稳定窗 ~300ms）内新建的 agent 可能先加入旧配置构建的连接，由补跑 reload 收敛到最终一致（与现状「新 agent 立即用自己的新配置」存在可感知差异）
