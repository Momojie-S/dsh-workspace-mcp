/**
 * @momojie-s/dsh-workspace-mcp
 *
 * 按 workspace（session.header.cwd）自动加载/卸载 MCP server。
 *
 * 机制: 全局监听 agent/pre-step（agent 运行时、ctx active），
 *   首次触发时懒加载 <cwd>/<configFile> 里的 MCP server，
 *   在 agent.ctx scope 注册工具（mcp__<server>__<tool>）。
 *   agent/disposed 时断开连接、卸载工具，无泄漏。
 */

import { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { loadWorkspaceMcpConfig } from "./config.js";
import { connectAndRegister, disposeServer, type ServerHandle } from "./mcp.js";

const name = "workspace-mcp";
const inject = ["tools"];

interface PluginConfig {
  configFile: string;
  verbose: boolean;
}

const Config = z.object({
  configFile: z.string().default(".dsh/mcp.servers.yml"),
  verbose: z.boolean().default(true),
});

/** agent id → 该 agent 的所有 MCP server 连接句柄。 */
const handlesByAgent = new Map<string, ServerHandle[]>();
/** 已完成懒加载的 agent id（避免每个 step 重复连接）。 */
const loadedAgents = new WeakSet<object>();

function apply(ctx: Context, config: PluginConfig) {
  const log = (msg: string) => {
    if (config.verbose) console.error(`[ws-mcp] ${msg}`);
  };
  log(`插件已加载，configFile=${config.configFile}`);

  const bus = ctx as any;

  // agent/pre-step: agent 真正开始工作时触发，此时 agent.ctx active。
  // 首次触发时懒加载该 workspace 的 MCP server。
  bus.on(
    "agent/pre-step",
    async ({ agent }: any, next: () => any) => {
      const result = await next();

      // 去重: 每个 agent 只加载一次
      if (agent && !loadedAgents.has(agent)) {
        loadedAgents.add(agent);
        await loadForAgent(agent, config, log);
      }
      return result;
    },
    { global: true }
  );

  // agent/disposed: 清理连接和工具
  bus.on(
    "agent/disposed",
    ({ agent }: any) => {
      const agentId = agent?.id;
      if (!agentId) return;
      const handles = handlesByAgent.get(agentId);
      if (handles) {
        for (const h of handles) disposeServer(h);
        handlesByAgent.delete(agentId);
        log(`agent/disposed: 清理 ${handles.length} 个 server 连接`);
      }
    },
    { global: true }
  );
}

/** 为一个 agent 加载其 workspace 的 MCP server 并注册工具。 */
async function loadForAgent(
  agent: any,
  config: PluginConfig,
  log: (msg: string) => void
): Promise<void> {
  const cwd: string | undefined = agent?.session?.header?.cwd;
  const agentId: string | undefined = agent?.id;
  if (!cwd || !agentId) return;

  let mcpConfig;
  try {
    mcpConfig = loadWorkspaceMcpConfig(cwd, config.configFile);
  } catch (e: any) {
    log(`配置读取失败: ${e?.message ?? e}`);
    return;
  }
  if (!mcpConfig || Object.keys(mcpConfig.servers).length === 0) {
    log(`cwd=${cwd} 无 MCP 配置`);
    return;
  }

  log(`agent/first-step: cwd=${cwd}，${Object.keys(mcpConfig.servers).length} 个 server`);

  const handles: ServerHandle[] = [];
  const agentCtx = agent.ctx;
  await Promise.all(
    Object.entries(mcpConfig.servers).map(async ([serverName, serverCfg]) => {
      try {
        const h = await connectAndRegister(agentCtx, serverName, serverCfg as any, log);
        if (h) handles.push(h);
      } catch (e: any) {
        log(`server "${serverName}" 异常: ${e?.message ?? e}`);
      }
    })
  );
  if (handles.length > 0) handlesByAgent.set(agentId, handles);
}

export { Config, apply, inject, name };
