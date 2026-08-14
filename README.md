# @momojie-s/dsh-workspace-mcp

DSH (DeepSeek Harness) 插件：按 **workspace（session 的 cwd）** 自动加载/卸载 MCP server。MCP 工具注册到 agent scope，随 agent 生灭自动回收，不同项目（workspace）的 MCP 互不干扰。

## 状态

已跑通端到端验证（headless + server-everything 测试 server）：
- ✅ 按 cwd 读取项目级 `.dsh/mcp.servers.yml`
- ✅ agent-scoped 注册 MCP 工具（`mcp__<server>__<tool>`）
- ✅ workspace 隔离（无配置的目录不加载 MCP）

## 机制

1. 全局监听 `agent/pre-step`（agent 真正开始工作时、ctx active）
2. 首次触发时读 `<cwd>/<configFile>` 里的 MCP server 列表
3. 对每个 server 用 `@modelcontextprotocol/sdk` 连接、发现工具
4. 在 `agent.ctx` scope 注册工具（agent-scoped，随 agent 回收）
5. `agent/disposed` 时断开连接、卸载工具

为什么不是 `session/created`：agent.ctx 在 created 时 inactive，注册工具会失败。`agent/pre-step` 是 ctx active 的最早可靠时机，且是懒加载（agent 不工作就不连 MCP）。

## 项目级配置

在项目根放 `.dsh/mcp.servers.yml`：

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

字段与 `@deepseek-ai/dsh-mcp-client` 的 Config 对齐（`transport` / `command` / `args` / `env` / `url` / `headers` / `toolCallTimeoutMs`）。

## 安装到 DSH profile

```shell
dsh plugin --profile web add <本插件路径>
```

在 `~/.dsh/profiles/web/cordis.patch.yml` 加：

```yaml
- insert:
    - id: workspace-mcp
      name: '@momojie-s/dsh-workspace-mcp'
      config:
        configFile: '.dsh/mcp.servers.yml'  # 默认值，可省略
        verbose: true
```

## 开发

```shell
npm install
npm run build      # tsc → lib/
```

peer deps（`@deepseek-ai/cordis` 等）由 DSH 运行时提供；`@modelcontextprotocol/sdk` 和 `js-yaml` 是本插件直接依赖。
