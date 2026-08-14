# @momojie-s/dsh-workspace-mcp

DSH (DeepSeek Harness) 插件：按 workspace（session 的 cwd）自动加载/卸载 MCP server，MCP 工具注册到 agent scope，随 agent 生灭自动回收。

> 当前状态：**探针阶段**，验证挂钩点数据链路。

## 状态

- [x] 插件骨架
- [ ] 验证 createAgent + setup 拿到 agent.ctx / session.header.cwd
- [ ] MCP server 加载逻辑
- [ ] agent-scoped 工具注册
- [ ] 端到端验证

## 开发

```shell
npm install        # 或 pnpm install
npm run build      # tsc → lib/
```

在 DSH profile 的 `cordis.patch.yml` 里引用（探针阶段）：

```yaml
- insert:
    - id: workspace-mcp-probe
      name: '@momojie-s/dsh-workspace-mcp'
      config:
        configFile: '.dsh/mcp.patch.yml'
        probe: true
```
