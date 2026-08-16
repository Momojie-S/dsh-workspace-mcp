# ADR-0006：官方 dsh-mcp-client 对齐补齐（parity port）

状态：accepted（2026-08）

## 背景

ADR-0004 移植 supervisor 时只对齐了连接生命周期。逐段 diff 官方 `lib/index.js`（DSH 0.1.0-rc.6）后发现五个未移植的行为缺口，其中 stdio 环境继承影响真实工作流（全局 AGENTS.md 的 PYTHONPATH 工作流依赖它）：

1. **stdio 子进程环境**：官方 `buildChildEnv` = `scrubbedParentEnv()`（全量父 env）+ yml 显式 env；我们只传 yml env，SDK 兜底安全子集（PATH 等十余个）——需要其余父变量（PYTHONPATH、代理、locale）的 stdio server 缺变量。
2. **重复 raw name 守卫**：server 在 tools/list 里重复列同一 raw name（分页 bug）时官方拒绝整代；我们 `Map.set` 静默覆盖且泄漏第一个 disposer。
3. **注册冲突回滚**：官方任一 register 抛错 → 回滚整代（本 server 0 工具）；我们 per-tool catch 留半代状态。
4. **输出契约**：官方声明 `structuredContent` 属性（server outputSchema 受支持时为该 schema）、`required`、`additionalProperties: false`；我们只有 `content` 属性，模型看不到结构化输出契约。
5. **taskSupport 守卫**：官方对 `execution.taskSupport === "required"` 的工具给出明确错误；我们调用后得到模糊失败。

## 备选

| 方案 | 结论 |
|------|------|
| 逐项移植（本 ADR） | ✅ 五项均为行为对齐，无新配置面 |
| 只移 env 继承（影响面最大的一项） | 其余四项是正确性/契约缺口，改造成本已付 |
| 等官方插件演化后再整体同步 | 缺口影响当下工作流；官方迭代节奏不受我们控制 |

## 决策

- **五项全部移植**，实现逐行对齐官方（含错误文案语义）：
  - `buildChildEnv`：直接 import `scrubbedParentEnv`（`@deepseek-ai/dsh-subprocess`），不自研副本——scrub 规则（`/KEY|PASSWORD|SECRET|TOKEN/i` + `DSH_*` 前缀，大小写不敏感）与官方共享同一份定义，不漂移。peer 依赖新增 `dsh-subprocess`（dev 树加 junction）。
  - 重复名守卫在 fetch 阶段（`definitions.has` → 抛错，上一代注册保留）；**注意语义**：publicToolName 对归一化有损的名字附加身份哈希，不同 raw name 永不撞名——守卫抓的是"同一 raw name 列出两次"，不是"归一化撞名"（测试首版就理解错了）。
  - swap 阶段整代回滚：任一 register 抛错 → dispose 已注册项 → 本代空 map + 日志（官方 contain 语义）。
  - `supportedOutputSchema`：import `assertSupportedJsonSchema`（`@deepseek-ai/dsh-tools`，peer 已有）——不支持词汇整体降级为不声明；`createOutput` 完整契约。
  - taskSupport 守卫在 execute 开头，先于任何请求。
- **明确不移植**（有既有决策或不适用）：
  - `failOnStartupError` / `ready`-await / `registrationFailure:"throw"`——ADR-0004：agent-scoped fire-and-forget 无同步启动语义。
  - `activeServerNames` 跨实例 serverName 保留——防的是"多条 patch 行同名"；本插件单 yml 内 YAML 后键覆盖，跨插件（全局 vs 项目）同名遮蔽是文档化特性，保留机制反而会破坏它。
  - reconnect 未知键的插件级重判——yml 层校验（config.ts）已拒绝未知键，插件级 Schemastery 管一层足够。

## 后果

- stdio server 现在继承全量（scrubbed）父环境：需要父变量的 server 直接工作；代价是子进程可见面变大（与全局 MCP 行为一致，由 scrub 规则兜底敏感项）。
- yml `env` 语义从"整个子环境"变为"覆盖层"（merge 在 scrubbed 父环境之后）——与全局 MCP 对齐，全局 AGENTS.md 的"裸值 env 传认证"写法不受影响（显式项永远赢）。
- 非法工具列表/名字被占不再产生半代注册：该 server 本代 0 工具，退避重连后重试。
- 新增 peer `@deepseek-ai/dsh-subprocess`：组合包安装路径与 cordis 等 peer 同机制，dev 树 junction 指向 DSH 安装。
- 版本 0.3.0（env 继承是显著语义变化）。
- 验证：`node test/parity.mjs` 五段（重复名守卫 + 哈希防坍缩 / 输出契约两路 / taskSupport / 整代回滚 / scrubbed env 三断言）+ 原三条回归，2026-08 实测全过。
