# ADR-0008：per-agent 连接共享（同一 workspace 的 server 条目单实例）

状态：accepted（2026-10-23）。**部分修订 ADR-0002**（见后果）。

## 背景

ADR-0002 把「每个 agent 一份工具注册」和「每个 agent 一条连接、一份 server 进程」绑死——简单，但进程/内存随 workspace 内活 agent 数（含全部 subagent）线性膨胀。2026-10-23 MomoYu workspace 实测：25 个活 agent × 2 server ≈ 50 份 python 进程 ≈ 16GB（风暴事件，见 momojie-assistant ops/home/log/2026-10.md 10-23 条）。方案A（uv tool install 消除解析停滞）与方案B（dispose 树杀兜底，ADR-0007）落地后，泄漏与风暴的正确性问题已解决；本 ADR 处理剩余的资源放大问题。

完整设计与六轮评审记录见 `.temp/plan-c-shared-connections.md`（终稿 v7，R6「可按原案实现」）。

## 备选

| 方案 | 结论 |
|------|------|
| 维持 per-agent 独立连接 | ❌ 进程份数 = 条目数 × 活 agent 数，重 server × 多 subagent 场景代价不可接受 |
| 共享连接（每 path × serverName 一份进程，注册仍 per-agent） | ✅ 份数 = 条目数；隔离与工具随 agent 生灭不变 |
| 跨 workspace 共享 | ❌ 破坏 workspace 隔离（ADR-0002 的根基） |

## 决策

- **拆两层**：连接层（`registry.ts` 的 SharedConnection，键 = `normalize(configPath) + serverName`，拥有 server 进程生死与 grace）与注册层（per-agent 工具注册，随 agent 卸载不变）。`mcp.ts` 的 supervisor 去 agentCtx 化：fetch（tools/list + 冲突守卫）在连接层一次，apply（per-subscriber 重新 `buildToolDefinition`，不跨订阅者共享定义对象）在注册层逐订阅者置换，回滚粒度 = 单订阅者。
- **并发纪律**：连接级状态变更一律入该连接的串行链，任务执行先过活性守卫（已 dispose 则 no-op）；path 级状态（liveAgents/watcher/reloading/dirty）全部触点在同步段完成；同步段三件套（liveAgents 登记 + 连接占位 + await 后重校验）必须在入口第一个 await 前完成。
- **liveAgents 摘除唯一时机 = agent/disposed 同步段**（yml 条目增删、连接 dispose、given-up 均不摘）；watcher 判据 = liveAgents 空↔非空跃迁（与文件存在性解耦，保热添加）。
- **given-up 语义变更**：预算耗尽 → 卸载全部订阅者的工具但**订阅者条目保留**；任一新 agent subscribe 即重开预算换代重建，旧订阅者随共享恢复工具（替代 ADR-0004 的「改配置文件或重启是唯一恢复路径」）。
- **reload 收敛语义**：dirty 终止（pass 开始清零/内再置位/循环至干净）+ 重挂枚举（liveAgents × yml 全条目，幂等 ensure+subscribe）+ 收尾三件事于 finally 等价点覆盖全部退出路径（含配置读取失败）+ 删除条目立即 dispose（树杀联动，不走 grace）。
- 不加 shared/per-agent mode 开关（回滚 = tag + revert + 重启）；`idleDropMs`（默认 30s，0 = 立即回收）为唯一新配置项。

## 后果

- **对 ADR-0002 的部分修订**：「工具注册到 agent scope，随 agent 生灭自动回收」不变；「agent 结束自动卸载、**连接自动断开**」中的连接生命周期改为**引用计数**——最后一个订阅者离开（含 grace）后连接才断开。两条 ADR 并读以本条为准。
- 对 ADR-0004 的语义增强：预算耗尽从「彻底安静等手工恢复」变为「新订阅自动重开预算」；supervisor 的重连/退避/树杀（ADR-0007）/会话失效（ADR-0005）机制原样保留。
- 进程份数公式从「条目数 × 活 agent 数」降为「条目数 × 1」；代价 = server 单进程成为该 workspace 全体 agent 的共享吞吐上限（接受，已在 overview 注明）。
- debounce 窗口内新 agent 可能加入旧配置构建的连接（C-joins-stale），由补跑 reload 收敛到最终一致——与现状「新 agent 立即用自己的新配置」存在可感知差异（最终一致）。
- 新增对账义务与活性守卫等并发纪律由 12 条新增 smoke 守护（共享矩阵/隔离/并发首订/竞速×3/生命周期/热添加/toolListChanged/部分删除/given-up 重建/fiber dispose）。
