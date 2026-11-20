# @momojie-s/dsh-workspace-mcp

DSH 插件：按 **workspace（session cwd）** 自动加载/卸载 MCP server——每个项目自己的 `.dsh/mcp.servers.yml` 只在自己的会话生效，MCP 工具注册到 agent scope，随 agent 生灭自动回收，不同项目的 MCP 互不干扰。

## 环境要求

- DSH `>= 0.1.0-rc.6`（已验证至 `0.2.2-rc.5`）

## 用法

项目根放 `.dsh/mcp.servers.yml`：

```yaml
servers:
  my-server:
    transport: stdio
    command: npx
    args: ["-y", "some-mcp-server@latest"]
    env: {}
  remote:
    transport: streamable-http
    url: https://example.com/mcp
    headers:
      Authorization: "Bearer <token>"
```

字段与 `@deepseek-ai/dsh-mcp-client` 对齐（`transport` / `command` / `args` / `env` / `url` / `headers` / `toolCallTimeoutMs` / `maxInstructionBytes` / `reconnect`）。

- agent 创建即连接注册（`agent/created`），**首个模型请求就含这些工具**；headless "create 后立刻发消息" 的竞速场景第 1 步可能没有，第 2 步必有
- **server instructions 注入 system prompt（≥0.5.0，与全局 MCP 一致）**：握手返回的 server instructions 以 `### MCP server: <名>` 包装，注册为该 agent 的 system prompt section（`mcp:<server>` 名、`MCP_SERVERS` 排序位、字面文本不做变量插值）。跨工具全局口径（坐标格式、分辨率等）server 侧声明一次即可见；此前走本插件时这段文字会被丢弃（全局 dsh-mcp-client 会注入，行为现已对齐）。断线不清快照、重连成功后自动更新；超 `maxInstructionBytes`（默认 32KB，官方同款上限）按该次连接失败处理走重连
- **断线自动重连**（移植官方 dsh-mcp-client 的 supervisor）：启动失败与中途断线均按指数退避重连并重新注册工具；重连期间旧工具保持注册，server 恢复后自动换新。stdio = 重新 spawn，http = 重新握手
- **重启自愈（调用内重试，≥0.4.0，官方 client 尚无此能力）**：streamable-http server 重启后的调用失败按「可证明未触达工具执行」分类——会话失效（HTTP 404 / JSON-RPC -32001 / "Session not found" 文案）、server 不可达（502/503、ECONNREFUSED/ENOTFOUND/EAI_AGAIN）——命中即丢弃当前连接、等新连接就绪（预算 `min(toolCallTimeoutMs, 30s)`）后**在同一次调用内重试一次，模型无感知**；并发调用撞同一重启共享一次重建。ECONNRESET、超时、abort、504 与业务错误刻意不重试（请求可能已到达 server，重放有重复执行风险），原样上抛
- **stdio 环境继承**（≥0.3.0，与全局 MCP 一致）：子进程拿到 scrubbed 父环境（剥 `KEY|PASSWORD|SECRET|TOKEN` 命中名与 `DSH_*` 前缀名）+ yml `env` 覆盖层——需要父环境变量（如 `PYTHONPATH`）的 server 直接工作；yml `env` 是覆盖层不是完整环境
- server 声明受支持的 `outputSchema` 时进入 `structuredContent` 输出契约；非法工具列表 / 注册名冲突整代拒绝/回滚（≥0.3.0，官方对齐）
- server 发 `toolListChanged` 通知时自动重同步工具列表
- 改配置文件由 chokidar 监听，保存即重载；无该文件的目录不加载任何 MCP

### headless/tui profile 临时挂载

这两个 profile 默认没挂 workspace-mcp，需要时用 `--patch` 临时挂 `file:///` 行指向其 lib（纯 host 半部插件可临时这样挂，带浏览器半部的插件不行）：

```bash
dsh --profile headless --patch <(echo "- insert:
    - id: workspace-mcp
      name: file:///D:/code/workspace/deepseek-harness-101/plugins/dsh-workspace-mcp/lib/index.js") "任务…"
```

### 与全局 MCP 的同名遮蔽（实测结论）

两边工具名都是 `mcp__<serverName>__<tool>`，冲突语义来自 DSH 工具注册表——agent 作用域遮蔽全局（per-tool，按名字逐个遮蔽）：

| 场景 | 行为 |
|---|---|
| serverName 不同 | 共存，两组工具模型都可见（正常用法） |
| 同 serverName（工具名撞车） | 项目级赢：模型看到并调用的都是项目版（web 从第 1 步起；竞速输了的场景第 1 步可能暂用全局版，第 2 步起项目版）。全局版对没配此 server 的其它 workspace 不受影响 |
| 全局 patch 里两条同 serverName | 后者整代注册回滚，日志报 `already registered`，该 server 一个工具都没有 |
| 同一个 yml 里重复 server 键 | YAML 后键覆盖前键 |

同名遮蔽是刻意覆盖的正规姿势（如把全局 server 指向本地 dev 实例调试）；无意撞名就改 serverName。若两边工具列表不完全一致，只有重名的那部分被遮蔽，其余各自可见。

## 安装

本插件是**组合包**（`dsh.bundle`），用 `dsh plugin` 安装进 profile，自动追加配置层，无需手编 patch：

```bash
# GitHub（私仓需 git 凭据；pnpm ≥10 首次 add 会提示授权构建，按提示把包键
# 写进 ~/.dsh/profiles/web/pnpm-workspace.yaml 的 allowBuilds 后重新 add）
dsh plugin --profile web add github:Momojie-S/dsh-workspace-mcp

# 或 tarball（pnpm pack 产物，无授权要求）
dsh plugin --profile web add momojie-s-dsh-workspace-mcp-0.2.0.tgz
```

验证层就位后重启 DSH：

```bash
dsh web --dump-config | Select-String workspace-mcp   # 应看到对应层
```

<details><summary>开发模式：源码直连（改代码 → 重启验证）</summary>

编译 `npm install && npm run build`，profile 的 `cordis.patch.yml` 手动加行（`name` 用 `file:///` URL 指向 `lib/index.js`）：

```yaml
- insert:
    - id: workspace-mcp
      name: file:///D:/code/workspace/deepseek-harness-101/plugins/dsh-workspace-mcp/lib/index.js
      config:
        configFile: '.dsh/mcp.servers.yml'
        verbose: true
```

</details>

## 配置

插件级（patch `config` 字段）：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `configFile` | `.dsh/mcp.servers.yml` | 相对 workspace 根的配置文件路径 |
| `verbose` | `false` | 输出连接/注册详细日志，排查用 |
| `idleDropMs` | `30000` | 连接的最后一名订阅者离开后的保留宽限；0 = 立即回收（不推荐——单 agent 正常退出也会杀掉 server，丢热态） |
| `reconnect.enabled` | `true` | 断线/启动失败是否自动重连 |
| `reconnect.initialDelayMs` | `500` | 首次重连延迟，此后指数翻倍 |
| `reconnect.maxDelayMs` | `30000` | 退避封顶；连接存活超此值则重置尝试预算（偶发崩的能无限恢复，crash-loop 的被掐掉） |
| `reconnect.maxAttempts` | `10` | 一次断线周期内最大连续失败次数，耗尽后卸载该 server 全部订阅者的工具；任一新 agent 订阅或改配置文件即重开预算重试 |

per-server 覆盖（`.dsh/mcp.servers.yml`，同名项优先于插件级）：

```yaml
servers:
  flaky:
    transport: stdio
    command: npx
    args: ["-y", "some-mcp"]
    maxInstructionBytes: 65536   # server instructions 字节上限（默认 32768）
    reconnect:
      enabled: true
      initialDelayMs: 1000
      maxAttempts: 5
```

## 验证

项目根放 `.dsh/mcp.servers.yml` 配一个测试 server（如 MCP 官方 `server-everything`），在会话里让 agent 列工具：

```
mcp__<serverName>__<toolName>
```

工具出现即生效；切到无配置的目录，这些工具不再出现，即隔离生效。

排障时挂载 config 开 `verbose: true`：连接/注册日志含 `[ws-mcp] server "xxx": 注册 N 个工具`（stdio 场景在 stderr）。

断线重连与重启自愈的可执行验证（不经 DSH host）：

```bash
npm test   # 错误分类（33 用例）/ 杀 server 子进程自动重连 / 启动失败退避后放弃 / Session not found 调用内恢复 / ECONNREFUSED 重启窗口恢复 + 预算耗尽抛原始错误 + 超时不重试 + 并发共享重建 / 官方对齐五项 / instructions 注入（注册形状、快照、退订清理、超限拒绝、防御跳过）
```

---

设计文档见 [docs/design/overview.md](docs/design/overview.md)；官方 dsh-mcp-client（全局/profile 级）的配置见合集仓库 `docs/official-usage/mcp.md`。
