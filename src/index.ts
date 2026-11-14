/**
 * @momojie-s/dsh-workspace-mcp
 *
 * 按 workspace（session.header.cwd）自动加载/卸载 MCP server。
 *
 * 机制（方案C：per-agent 连接共享，ADR-0008）:
 *   - 监听 agent/created（全局），同步段登记 agent 存活（liveAgents + watcher
 *     空↔非空跃迁），随后异步确保按 <cwd>/.dsh/mcp.servers.yml 订阅齐全。
 *   - agent/pre-step 自检自愈：每步幂等重跑 ensure（快速路径 = 簿记命中直接
 *     跳过），覆盖 HMR 重载后无 created 事件的存量 agent 与各类失明收敛。
 *   - 同一 workspace 的同一 server 条目全体 agent 共享一条受监督连接
 *     （registry.ts，含串行链/活性守卫/grace/dirty reload/对账义务）；
 *     工具注册依旧 per-agent——可见性、随 agent 卸载、workspace 隔离不变。
 *   - server instructions（握手返回）注入订阅者 agent 的 system prompt：
 *     per-agent scoped section（`mcp:<server>`，MCP_SERVERS 排序位，字面文本），
 *     经 agentCtx 访问使 section 落进该 agent 的 scope layer；快照语义与官方
 *     dsh-mcp-client 对齐（最后成功连接为准、32KB 上限、超限连接失败），见 ADR-0010。
 *   - 重连预算耗尽（given-up）后，任一新 agent 订阅即重开预算重建，旧订阅者
 *     随共享恢复工具；配置文件变化经 watcher 触发 path 级 reload（dirty 补跑
 *     循环 + liveAgents×yml 重挂枚举 + 收尾三件事）。
 *   - agent/disposed 同步段摘 liveAgents 并扇出退订；fiber dispose 时清全部
 *     连接、watcher 与簿记，无泄漏。
 */

import { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { ReconnectPolicy } from "./config.js";
import { RECONNECT_DEFAULTS } from "./mcp.js";
import { WorkspaceMcpRegistry } from "./registry.js";

const name = "workspace-mcp";
const inject = ["tools"];

interface PluginConfig {
  configFile: string;
  verbose: boolean;
  /** 文件变化后重新加载的防抖延迟（毫秒），避免编辑器多次保存触发抖动。 */
  reloadDebounceMs: number;
  /** 连接 refs 归零后的保留宽限（毫秒）；0 = 立即回收。默认 30s（桥接 agent churn）。 */
  idleDropMs: number;
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
  idleDropMs: z.number().min(0).default(30_000),
  reconnect: Reconnect,
});

function apply(ctx: Context, config: PluginConfig) {
  const log = (msg: string) => {
    if (config.verbose) console.error(`[ws-mcp] ${msg}`);
  };
  log(`插件已加载，configFile=${config.configFile}，idleDropMs=${config.idleDropMs}`);
  const registry = new WorkspaceMcpRegistry({
    configFile: config.configFile,
    log,
    reloadDebounceMs: config.reloadDebounceMs,
    idleDropMs: config.idleDropMs,
    reconnect: config.reconnect,
  });
  const bus = ctx as any;

  const extract = (agent: any): { agentId?: string; cwd?: string; agentCtx?: any } => {
    const agentId = agent?.id;
    const cwd = agent?.session?.header?.cwd;
    const agentCtx = agent?.ctx;
    if (!agentId || !cwd || !agentCtx) return {};
    return { agentId, cwd, agentCtx };
  };

  // agent/created：同步段登记（liveAgents + watcher 跃迁），随后 fire-and-forget
  // 确保订阅。web 会话创建与用户首条消息之间有秒级间隔，注册先于首个模型请求
  // 的 assembly.tools 组装 → 首个请求即含 mcp__* 工具。
  bus.on(
    "agent/created",
    ({ agent }: any) => {
      const { agentId, cwd, agentCtx } = extract(agent);
      if (!agentId) return;
      registry.registerAgentPresence(agentId, cwd!, agentCtx);
      registry
        .ensureAgentServers(agentId, cwd!, agentCtx)
        .catch((e: any) => log(`初始化失败: ${e?.message ?? e}`));
    },
    { global: true }
  );

  // agent/pre-step 自检自愈：幂等 ensure（快速路径 = 簿记命中直接跳过）。
  // 覆盖 HMR 重载后已存在的 agent（没有 created 事件）与各类失明收敛。
  bus.on(
    "agent/pre-step",
    async ({ agent }: any, next: () => any) => {
      const { agentId, cwd, agentCtx } = extract(agent);
      if (agentId) {
        try {
          await registry.ensureAgentServers(agentId, cwd!, agentCtx);
        } catch (e: any) {
          log(`pre-step 自检失败: ${e?.message ?? e}`);
        }
      }
      return await next();
    },
    { global: true }
  );

  // agent/disposed：同步段摘 liveAgents + 扇出退订（registry 内部入队，事件侧不等待）
  bus.on(
    "agent/disposed",
    ({ agent }: any) => {
      if (!agent?.id) return;
      registry.agentDisposed(agent.id);
      log(`agent/disposed: 已清理 ${agent.id}`);
    },
    { global: true }
  );

  // Fiber dispose（HMR 重载 / 插件停止 / 卸载）时清理所有资源：连接（树杀兜底
  // 生效）、watcher、path 状态、订阅簿记。否则 HMR 会泄漏子进程与注册。
  ctx.effect(() => {
    return () => {
      void registry.disposeAll();
    };
  });
}

export { Config, apply, inject, name };
