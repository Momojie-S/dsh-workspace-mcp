# @momojie-s/dsh-workspace-mcp

DSH 插件：按 **workspace（session cwd）** 自动加载/卸载 MCP server——每个项目自己的 `.dsh/mcp.servers.yml` 只在自己的会话生效，MCP 工具注册到 agent scope，随 agent 生灭自动回收，不同项目的 MCP 互不干扰。

## 环境要求

- DSH `0.1.0-rc.6`（已验证）

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

字段与 `@deepseek-ai/dsh-mcp-client` 对齐（`transport` / `command` / `args` / `env` / `url` / `headers` / `toolCallTimeoutMs`）。

- agent 创建即连接注册（`agent/created`），**首个模型请求就含这些工具**；headless "create 后立刻发消息" 的竞速场景第 1 步可能没有，第 2 步必有
- 改配置文件由 chokidar 监听，保存即重载；无该文件的目录不加载任何 MCP

## 安装

本插件是**组合包**（`dsh.bundle`），用 `dsh plugin` 安装进 profile，自动追加配置层，无需手编 patch：

```bash
# GitHub（私仓需 git 凭据；pnpm ≥10 首次 add 会提示授权构建，按提示把包键
# 写进 ~/.dsh/profiles/web/pnpm-workspace.yaml 的 allowBuilds 后重新 add）
dsh plugin --profile web add github:Momojie-S/dsh-workspace-mcp

# 或 tarball（pnpm pack 产物，无授权要求）
dsh plugin --profile web add momojie-s-dsh-workspace-mcp-0.1.0.tgz
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

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `configFile` | `.dsh/mcp.servers.yml` | 相对 workspace 根的配置文件路径 |
| `verbose` | `false` | 输出连接/注册详细日志，排查用 |

## 验证

项目根放 `.dsh/mcp.servers.yml` 配一个测试 server（如 MCP 官方 `server-everything`），在会话里让 agent 列工具：

```
mcp__<serverName>__<toolName>
```

工具出现即生效；切到无配置的目录，这些工具不再出现，即隔离生效。

---

设计文档见 [docs/design/overview.md](docs/design/overview.md)；MCP 配置详解与踩坑见合集仓库 `docs/usage/mcp.md`。
