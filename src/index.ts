/**
 * @momojie-s/dsh-workspace-mcp
 *
 * 按 workspace（session.header.cwd）自动加载/卸载 MCP server。
 *
 * 机制:
 *   - 监听 agent/created（全局），agent 创建即异步连接 <cwd>/<configFile> 里的
 *     MCP server，在 agent.ctx scope 注册工具——首个模型请求即可见到 mcp__* 工具。
 *   - agent/pre-step 兜底：HMR 重载后已存在的 agent 没有 created 事件，首个
 *     pre-step 补初始化（await）。注意 assembly.tools 在 pre-step 前组装，
 *     pre-step 内的等待无法影响本步工具集，故不做等待。
 *   - 每个 server 一条受监督连接（mcp.ts，移植官方 dsh-mcp-client）：
 *     连接失败与中途断线均按指数退避自动重连并重新注册工具；预算耗尽才放弃
 *     （卸载工具，改配置文件或重启恢复）；监听工具列表变化通知即时重同步。
 *   - 用 chokidar 监听配置文件，变化时自动 dispose 旧 server、重新连接注册
 *     （改 .dsh/mcp.servers.yml 后当前会话立即生效，无需重启/新开会话）。
 *   - agent/disposed / fiber dispose 时断开连接、卸载工具、关闭 watcher，无泄漏。
 */

import { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import chokidar from "chokidar";
import { resolve } from "node:path";
import { loadWorkspaceMcpConfig, type ReconnectPolicy, type ServerConfig } from "./config.js";
import {
  RECONNECT_DEFAULTS,
  resolveReconnectPolicy,
  startSupervisedConnection,
  type SupervisedServer,
} from "./mcp.js";

const name = "workspace-mcp";
const inject = ["tools"];

interface PluginConfig {
  configFile: string;
  verbose: boolean;
  /** 文件变化后重新加载的防抖延迟（毫秒），避免编辑器多次保存触发抖动。 */
  reloadDebounceMs: number;
  /** 插件级重连默认（各 server 可在 yml 里逐项覆盖）。 */
  reconnect: Partial<ReconnectPolicy>;
}

const Reconnect = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).default(RECONNECT_DEFAULTS.maxAttempts),
});

const Config = z.object({
  configFile: z.string().default(".dsh/mcp.servers.yml"),
  verbose: z.boolean().default(true),
  reloadDebounceMs: z.number().default(500),
  reconnect: Reconnect,
});

/** 一个 agent 的加载状态: 已注册的 server 监督句柄 + watcher + 防抖计时器。 */
interface AgentState {
  handles: SupervisedServer[];
  watcher?: ReturnType<typeof chokidar.watch>;
  reloadTimer?: ReturnType<typeof setTimeout>;
  reloading: boolean;
}

/** agent id → 加载状态。 */


const statesByAgent = new Map<string, AgentState>();
/** 已初始化（启动过 initAgent）的 agent 对象集合，避免重复初始化。 */
const initedAgents = new WeakSet<object>();

function apply(ctx: Context, config: PluginConfig) {
  const log = (msg: string) => {
    if (config.verbose) console.error(`[ws-mcp] ${msg}`);
  };
  log(`插件已加载，configFile=${config.configFile}`);
  const bus = ctx as any;

  // agent/created 即启动 MCP 连接 + 工具注册（fire-and-forget）：
  // web 会话创建与用户首条消息之间有秒级间隔，localhost MCP 握手毫秒级完成，
  // 注册先于首个模型请求的 assembly.tools 组装 → 首个请求即含 mcp__* 工具。
  // （assembly.tools 在首个 pre-step 之前组装，created 是唯一够早的钩子；
  // headless 这类 create 后立刻 followup 的场景仍是竞速，输了则第 2 步可见。）
  // 实测 agent.ctx 在此事件上可安全 tools.register（不依赖 agentCtx.effect，
  // disposer 由本插件持有，agent/disposed / fiber dispose 时统一清理）。
  bus.on(
    "agent/created",
    ({ agent }: any) => {
      if (!agent || initedAgents.has(agent)) return;
      initedAgents.add(agent);
      initAgent(agent, config, log).catch((e: any) => {
        log(`初始化失败: ${e?.message ?? e}`);
      });
    },
    { global: true }
  );

  bus.on(
    "agent/pre-step",
    async ({ agent }: any, next: () => any) => {
      // 兜底路径：插件 HMR 重载后已存在的 agent 不会再收到 agent/created，
      // 首个 pre-step 时补初始化（await，自下一步起可见）。
      if (agent && !initedAgents.has(agent)) {
        initedAgents.add(agent);
        await initAgent(agent, config, log);
      }
      return await next();
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

  // Fiber dispose（HMR 重载 / 插件停止 / 卸载）时清理所有 agent 的资源：
  // 关闭 MCP 连接、卸载工具、关 watcher、清计时器。否则 HMR 会泄漏子进程与注册。
  ctx.effect(() => {
    return () => {
      for (const [agentId, state] of statesByAgent) {
        teardownAgent(agentId, state, log);
      }
      statesByAgent.clear();
      log(`插件卸载：已清理全部 agent 资源`);
    };
  });
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

/** （重新）加载一个 agent 的 MCP server: 先卸载旧的（等连接静默关闭），再连接新的。 */
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
    // 卸载旧 server（await：等 in-flight 连接尝试与 transport 关闭，
    // 避免 stdio 旧进程未退就 spawn 新进程造成重叠）
    await Promise.all(state.handles.map((h) => h.dispose().catch(() => {})));
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

    // 每个server一条受监督连接：启动后自管理重连/重同步，无需 await 完成
    await Promise.all(
      Object.entries(mcpConfig.servers).map(async ([serverName, serverCfg]) => {
        try {
          const policy = resolveReconnectPolicy(
            config.reconnect,
            (serverCfg as ServerConfig).reconnect,
            `server "${serverName}"`
          );
          state.handles.push(
            startSupervisedConnection(agentCtx, serverName, serverCfg as any, policy, log)
          );
        } catch (e: any) {
          log(`server "${serverName}" 配置异常: ${e?.message ?? e}`);
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
  for (const h of state.handles) {
    // 同步事件上下文里不等完成；dispose 自身幂等且不抛错
    h.dispose().catch(() => {});
  }
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