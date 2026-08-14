/**
 * @momojie-s/dsh-workspace-mcp
 *
 * 按 workspace（session.header.cwd）自动加载/卸载 MCP server。
 *
 * 机制:
 *   - 全局监听 agent/pre-step（agent 运行时、ctx active），首次触发时懒加载
 *     <cwd>/<configFile> 里的 MCP server，在 agent.ctx scope 注册工具。
 *   - 用 chokidar 监听配置文件，变化时自动 dispose 旧 server、重新连接注册
 *     （改 .dsh/mcp.servers.yml 后当前会话立即生效，无需重启/新开会话）。
 *   - agent/disposed 时断开连接、卸载工具、关闭 watcher，无泄漏。
 */

import { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import chokidar from "chokidar";
import { resolve } from "node:path";
import { loadWorkspaceMcpConfig } from "./config.js";
import { connectAndRegister, disposeServer, type ServerHandle } from "./mcp.js";

const name = "workspace-mcp";
const inject = ["tools"];

interface PluginConfig {
  configFile: string;
  verbose: boolean;
  /** 文件变化后重新加载的防抖延迟（毫秒），避免编辑器多次保存触发抖动。 */
  reloadDebounceMs: number;
}

const Config = z.object({
  configFile: z.string().default(".dsh/mcp.servers.yml"),
  verbose: z.boolean().default(true),
  reloadDebounceMs: z.number().default(500),
});

/** 一个 agent 的加载状态: 已注册的 server 句柄 + watcher + 防抖计时器。 */
interface AgentState {
  handles: ServerHandle[];
  watcher?: ReturnType<typeof chokidar.watch>;
  reloadTimer?: ReturnType<typeof setTimeout>;
  reloading: boolean;
}

/** agent id → 加载状态。 */


const statesByAgent = new Map<string, AgentState>();
/** 已初始化（建好 watcher）的 agent 对象集合，避免重复初始化。 */
const initedAgents = new WeakSet<object>();

function apply(ctx: Context, config: PluginConfig) {
  const log = (msg: string) => {
    if (config.verbose) console.error(`[ws-mcp] ${msg}`);
  };
  log(`插件已加载，configFile=${config.configFile}`);
  const bus = ctx as any;

  bus.on(
    "agent/pre-step",
    async ({ agent }: any, next: () => any) => {
      const result = await next();      if (agent && !initedAgents.has(agent)) {
        initedAgents.add(agent);
        await initAgent(agent, config, log);
      }
      return result;
    },
    { global: true }
  );

  bus.on(
    "agent/disposed",
    ({ agent }: any) => {
      const agentId = agent?.id;
      if (!agentId) return;
      const state = statesByAgent.get(agentId);
      if (state) {
        teardownAgent(agentId, state, log);
        log(`agent/disposed: 已清理`);
      }
    },
    { global: true }
  );
}

/** 为一个 agent 首次加载 MCP + 建立配置文件监听。 */
async function initAgent(
  agent: any,
  config: PluginConfig,
  log: (msg: string) => void
): Promise<void> {
  const cwd: string | undefined = agent?.session?.header?.cwd;
  const agentId: string | undefined = agent?.id;
  if (!cwd || !agentId) return;

  const state: AgentState = { handles: [], reloading: false };
  statesByAgent.set(agentId, state);

  const agentCtx = agent.ctx;
  const cfgPath = resolve(cwd, config.configFile);

  // 首次加载
  await reloadAgent(agentId, agentCtx, cwd, config, state, log);

  // 监听配置文件变化（chokidar：处理编辑器原子保存、防抖）
  try {
    const watcher = chokidar.watch(cfgPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    state.watcher = watcher;
    watcher.on("all", () => {
      if (state.reloadTimer) clearTimeout(state.reloadTimer);
      state.reloadTimer = setTimeout(() => {
        state.reloadTimer = undefined;
        log(`配置文件变化，重新加载: ${cfgPath}`);
        reloadAgent(agentId, agentCtx, cwd, config, state, log).catch((e) => {
          log(`重新加载失败: ${e?.message ?? e}`);
        });
      }, config.reloadDebounceMs);
    });
  } catch (e: any) {
    log(`配置文件监听建立失败: ${e?.message ?? e}`);
  }
}

/** （重新）加载一个 agent 的 MCP server: 先卸载旧的，再连接新的。 */
async function reloadAgent(
  agentId: string,
  agentCtx: any,
  cwd: string,
  config: PluginConfig,
  state: AgentState,
  log: (msg: string) => void
): Promise<void> {
  if (state.reloading) return;
  state.reloading = true;
  try {
    // 卸载旧 server
    for (const h of state.handles) disposeServer(h);
    state.handles = [];

    // 读最新配置
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

    log(`加载: cwd=${cwd}，${Object.keys(mcpConfig.servers).length} 个 server`);

    // 连接 + 注册
    await Promise.all(
      Object.entries(mcpConfig.servers).map(async ([serverName, serverCfg]) => {
        try {
          const h = await connectAndRegister(agentCtx, serverName, serverCfg as any, log);
          if (h) state.handles.push(h);
        } catch (e: any) {
          log(`server "${serverName}" 异常: ${e?.message ?? e}`);
        }
      })
    );
  } finally {
    state.reloading = false;
  }
}

/** 清理一个 agent 的所有资源: server 连接 + watcher + 计时器。 */
function teardownAgent(
  agentId: string,
  state: AgentState,
  log: (msg: string) => void
): void {
  for (const h of state.handles) disposeServer(h);
  state.handles = [];
  if (state.reloadTimer) {
    clearTimeout(state.reloadTimer);
    state.reloadTimer = undefined;
  }
  if (state.watcher) {
    state.watcher.close().catch(() => {});
    state.watcher = undefined;
  }
  statesByAgent.delete(agentId);
}

export { Config, apply, inject, name };