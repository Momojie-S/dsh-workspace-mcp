/**
 * 连接注册表：per-agent 连接共享（ADR-0008，方案C）。
 *
 * 两级状态（详见 .temp/plan-c-shared-connections.md 终稿 §4）：
 *   path 级（键 = normalize(configFilePath)）：{ liveAgents, watcher, reloading, dirty }
 *     —— 拥有 watcher 与 reload 互斥；全部触点在同步段内完成（不受任何连接
 *     串行链保护，连接可能尚不存在）。
 *   连接级（键 = path + serverName）：SharedConnection
 *     —— 拥有连接生死（grace）；一切状态变更入该连接的串行链，任务执行时
 *     先过活性守卫（已 dispose 则 no-op），杜绝在已删表项上注册工具。
 *
 * 关键纪律（评审换来的，勿动）：
 *   - liveAgents 的摘除唯一时机 = agent/disposed 同步段；yml 条目增删、连接
 *     dispose、given-up 均不摘——agent 仍活着就留在名单里。
 *   - 订阅簿记粒度 = agentId × serverKey，入队即摘（不依赖队列任务存活）。
 *   - watcher 判据 = liveAgents 空↔非空跃迁（禁止锚连接级 subscribe——无配置
 *     agent 永远不会发生连接级 subscribe，热添加会静默回归）。
 *   - reload 尾部重挂枚举 = liveAgents × 当前 yml 全部条目，幂等 ensure+subscribe
 *     ——同时覆盖换代重挂、新增条目、热添加、从未订阅的存量 agent。
 *   - 收尾三件事（dirty read-and-clear / 按 liveAgents×yml 对账 / 空则回收）
 *     于 finally 等价点执行，覆盖含配置读取失败在内的全部退出路径。
 *   - definitions 按订阅者实例化（register 纯度未证实，不跨订阅者共享对象）。
 */

import chokidar from "chokidar";
import { resolve } from "node:path";
import { loadWorkspaceMcpConfig, type ReconnectPolicy, type ServerConfig } from "./config.js";
import {
  buildToolDefinition,
  publicToolName,
  resolveReconnectPolicy,
  startSupervision,
  type Supervision,
} from "./mcp.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** win32 下路径大小写不敏感：仅键 normalize，路径本体照原样使用。 */
function normalizePathKey(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** 连接键 = normalize(configFilePath) + serverName。 */
export function connKeyOf(configFilePath: string, serverName: string): string {
  return `${normalizePathKey(configFilePath)}\0${serverName}`;
}

/** 键序无关的 canonical JSON（ServerConfig 深比较用，禁止失真比较）。 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v as object).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

function serverConfigEquals(a: ServerConfig, b: ServerConfig): boolean {
  return canonical(a) === canonical(b);
}

export interface RegistryOptions {
  /** 相对 cwd 的配置文件路径（默认 .dsh/mcp.servers.yml）。 */
  configFile: string;
  log: (msg: string) => void;
  /** 文件变化后重新加载的防抖延迟（毫秒）。 */
  reloadDebounceMs: number;
  /** 连接 refs 归零后的保留宽限（毫秒）；0 = 立即回收。 */
  idleDropMs: number;
  /** 插件级重连默认。 */
  reconnect: Partial<ReconnectPolicy>;
}

/** 一个 agent 在一条共享连接上的订阅项。 */
interface Subscriber {
  agentId: string;
  agentCtx: any;
  /** 失活后 apply 跳过；unsubscribe 先置 false 再入队摘除。 */
  active: boolean;
  /** 该订阅者在本连接上的注册 disposer（publicName → disposer）。 */
  disposers: Map<string, () => void>;
}

/** 一条共享连接：一个 server 条目 × 一个 workspace 的全体 agent。 */
interface SharedConnection {
  key: string;
  pathKey: string;
  filePath: string;
  serverName: string;
  cfg: ServerConfig;
  policy: ReconnectPolicy;
  supervision: Supervision;
  hooks: {
    onFetched(): void;
    onGivenUp(): void;
  };
  logFn: (msg: string) => void;
  /** agentId → 订阅项；refs = size。 */
  subscribers: Map<string, Subscriber>;
  /** 连接级串行链：一切连接级状态变更在此排队（含活性守卫）。 */
  chain: Promise<void>;
  disposed: boolean;
  /** 重连预算耗尽；新订阅触发换代重建（重开预算）。 */
  givenUp: boolean;
  /** 首次构建尝试结果（历史值；重建换代不更新——joiner 拿到的是它）。 */
  ready: Promise<{ error?: unknown }>;
  graceTimer?: ReturnType<typeof setTimeout>;
}

/** path 级状态：拥有 watcher 与 reload 互斥；触点全在同步段。 */
interface PathState {
  key: string;
  filePath: string;
  cwd: string;
  liveAgents: Set<string>;
  watcher?: ReturnType<typeof chokidar.watch>;
  reloadTimer?: ReturnType<typeof setTimeout>;
  reloading: boolean;
  dirty: boolean;
}

/** agent 维度订阅簿记：粒度 agentId × serverKey，供 disposed 扇出枚举与自检。 */
interface AgentEntry {
  agentId: string;
  pathKey: string;
  filePath: string;
  cwd: string;
  agentCtx: any;
  /** serverName → 该 agent 当前持有的共享连接。 */
  subscriptions: Map<string, SharedConnection>;
}

export class WorkspaceMcpRegistry {
  private connections = new Map<string, SharedConnection>();
  private paths = new Map<string, PathState>();
  private agents = new Map<string, AgentEntry>();
  private ensuring = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(private readonly opts: RegistryOptions) {}

  // ------------------------------------------------------------------
  // 同步段入口（agent/created、agent/pre-step 直接调用，无 await 前置）
  // ------------------------------------------------------------------

  /**
   * 登记 agent 存活（同步段）：liveAgents 计入（无条件——无 server 条目/文件
   * 不存在/配置非法同样登记，热添加的前提）、watcher 空↔非空跃迁、订阅簿记建项。
   * 幂等；cwd 变化（罕见）按 disposed+重登记处理。
   */
  registerAgentPresence(agentId: string, cwd: string, agentCtx: any): void {
    if (this.disposed || !agentId || !cwd) return;
    const filePath = resolve(cwd, this.opts.configFile);
    const pathKey = normalizePathKey(filePath);
    const existing = this.agents.get(agentId);
    if (existing && existing.pathKey !== pathKey) {
      // cwd 变化按销毁+重登记处理（DSH 会话 cwd 固定，此路径仅防御）
      this.agentDisposed(agentId);
    }
    let ps = this.paths.get(pathKey);
    if (!ps) {
      ps = { key: pathKey, filePath, cwd, liveAgents: new Set(), reloading: false, dirty: false };
      this.paths.set(pathKey, ps);
    }
    const wasEmpty = ps.liveAgents.size === 0;
    ps.liveAgents.add(agentId);
    if (wasEmpty && !ps.watcher) this.attachWatcher(ps);
    let entry = this.agents.get(agentId);
    if (!entry) {
      entry = { agentId, pathKey, filePath, cwd, agentCtx, subscriptions: new Map() };
      this.agents.set(agentId, entry);
    } else {
      entry.agentCtx = agentCtx;
    }
  }

  /**
   * agent/disposed（同步段）：先摘 liveAgents（此后任何重挂 pass 不再看见该
   * agent），再按订阅簿记扇出退订（遍历次序无关，各项入各自连接的队列），
   * 最后清订阅簿记。重复调用幂等。
   */
  agentDisposed(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (!entry) return;
    const ps = this.paths.get(entry.pathKey);
    if (ps) {
      ps.liveAgents.delete(agentId);
      if (ps.liveAgents.size === 0) this.closeWatcher(ps);
    }
    for (const [, conn] of entry.subscriptions) {
      this.enqueueUnsubscribe(conn, agentId);
    }
    this.agents.delete(agentId);
    // path 状态回收：liveAgents 空且无 reload 在途（在途时由 reload 收尾点负责）
    if (ps && ps.liveAgents.size === 0 && !ps.reloading && !ps.dirty) {
      this.paths.delete(ps.key);
    }
  }

  // ------------------------------------------------------------------
  // 加载 / 自检自愈（幂等；pre-step 每步调用走快速路径）
  // ------------------------------------------------------------------

  /**
   * 确保该 agent 按当前 yml 订阅齐全（幂等）：读 yml → 期望集 vs 簿记+连接
   * 活性对比 → 缺失项补订阅。这是 pre-step 自检自愈的实现体——自检判据
   * 不信任簿记之外的任何状态（R5/R6 附注）。
   */
  async ensureAgentServers(agentId: string, cwd: string, agentCtx: any): Promise<void> {
    const inflight = this.ensuring.get(agentId);
    if (inflight) return inflight;
    const p = this.ensureAgentServersInner(agentId, cwd, agentCtx).finally(() => {
      this.ensuring.delete(agentId);
    });
    this.ensuring.set(agentId, p);
    return p;
  }

  private async ensureAgentServersInner(agentId: string, cwd: string, agentCtx: any): Promise<void> {
    if (this.disposed) return;
    this.registerAgentPresence(agentId, cwd, agentCtx);
    const entry = this.agents.get(agentId);
    if (!entry) return;
    let cfg: Awaited<ReturnType<typeof loadWorkspaceMcpConfig>>;
    try {
      cfg = loadWorkspaceMcpConfig(cwd, this.opts.configFile);
    } catch (e: any) {
      // 瞬态读取/解析错误：保守不动（订阅集的清空归 reload 流程管）
      this.log(`cwd=${cwd} 配置读取失败（保守保留现状）: ${e?.message ?? e}`);
      return;
    }
    if (!cfg) return; // ENOENT：无配置；watcher 已在位，文件出现后由 reload 落位
    for (const [serverName, serverCfg] of Object.entries(cfg.servers)) {
      // 快速路径：簿记命中且连接健在且本 agent 已是订阅者 → 跳过。
      // 局限注明（规格 §4.4 R6 附注的预授权退化）：此判据 = yml 期望集 vs 簿记 + 连接活性，
      // 未枚举 cordis tools 实际注册面——簿记与注册面若失配（理论上已被入队即摘纪律压到最低），
      // 此自检不可见，依赖日志与集成测试兜底。
      const existing = entry.subscriptions.get(serverName);
      if (
        existing &&
        !existing.disposed &&
        !existing.givenUp &&
        existing.subscribers.has(agentId)
      ) {
        continue;
      }
      this.subscribeAgentExternal(entry, serverName, serverCfg as ServerConfig);
    }
  }

  /**
   * 测试/直驱入口：跳过 yml，直接按内联 server 配置确保订阅（语义同
   * ensureAgentServers，配置来源不同）。smoke 用它驱动 supervisor 全链路。
   */
  async ensureAgentServersInline(
    agentId: string,
    cwd: string,
    agentCtx: any,
    servers: Record<string, ServerConfig>
  ): Promise<void> {
    if (this.disposed) return;
    this.registerAgentPresence(agentId, cwd, agentCtx);
    const entry = this.agents.get(agentId);
    if (!entry) return;
    for (const [serverName, serverCfg] of Object.entries(servers)) {
      this.subscribeAgentExternal(entry, serverName, serverCfg);
    }
  }

  // ------------------------------------------------------------------
  // 订阅（同步段 + 入队）
  // ------------------------------------------------------------------

  /** 外部订阅（agent/created、pre-step 自愈）：reload in-flight 时置 dirty。 */
  private subscribeAgentExternal(
    entry: AgentEntry,
    serverName: string,
    serverCfg: ServerConfig
  ): void {
    const ps = this.paths.get(entry.pathKey);
    const conn = this.subscribeAgent(entry, ps, serverName, serverCfg);
    if (conn && ps?.reloading) ps.dirty = true;
  }

  /** 枚举内订阅（reload pass 自己的落位）：不置 dirty（本身就是 pass）。 */
  private subscribeAgentEnumerate(
    entry: AgentEntry,
    ps: PathState,
    serverName: string,
    serverCfg: ServerConfig
  ): void {
    this.subscribeAgent(entry, ps, serverName, serverCfg);
  }

  /**
   * 同步段：liveAgents 登记[幂等] + 订阅簿记登记 + 连接 get-or-create 占位
   * （given-up → 换代重建重开预算；grace 期内 → 取消计时器复用），
   * 随后入队「登记订阅者 → 套用当前代已拉取的工具定义」。
   */
  private subscribeAgent(
    entry: AgentEntry,
    ps: PathState | undefined,
    serverName: string,
    serverCfg: ServerConfig
  ): SharedConnection | undefined {
    if (this.disposed || !ps) return undefined;
    const key = connKeyOf(entry.filePath, serverName);
    let conn = this.connections.get(key);
    if (conn && conn.disposed) conn = undefined;
    if (!conn) {
      let policy: ReconnectPolicy;
      try {
        policy = resolveReconnectPolicy(
          this.opts.reconnect,
          (serverCfg as ServerConfig).reconnect,
          `server "${serverName}"`
        );
      } catch (e: any) {
        this.log(`server "${serverName}"@${entry.filePath} 配置异常: ${e?.message ?? e}`);
        return undefined;
      }
      const fresh: SharedConnection = {
        key,
        pathKey: ps.key,
        filePath: entry.filePath,
        serverName,
        cfg: serverCfg as ServerConfig,
        policy,
        subscribers: new Map(),
        chain: Promise.resolve(),
        disposed: false,
        givenUp: false,
        graceTimer: undefined,
        logFn: (msg) => this.log(msg),
        hooks: undefined as unknown as SharedConnection["hooks"],
        supervision: undefined as unknown as Supervision,
        ready: undefined as unknown as Promise<{ error?: unknown }>,
      };
      fresh.hooks = {
        onFetched: () => {
          this.enqueue(fresh, () => {
            if (fresh.disposed) return;
            this.applyAll(fresh);
          });
        },
        onGivenUp: () => {
          this.enqueue(fresh, () => {
            if (fresh.disposed || fresh.givenUp) return;
            fresh.givenUp = true;
            for (const sub of fresh.subscribers.values()) stripSubscriberTools(sub);
            this.log(
              `conn "${serverName}"@${entry.filePath}: 重连预算耗尽，已卸载全部订阅者的工具（订阅者保留）；新订阅或配置重载将重开预算`
            );
          });
        },
      };
      fresh.supervision = startSupervision(serverName, fresh.cfg, policy, fresh.hooks, (msg) =>
        this.log(msg)
      );
      fresh.ready = fresh.supervision.ready;
      this.connections.set(key, fresh);
      conn = fresh;
      this.log(`conn "${serverName}"@${entry.filePath}: 已建立共享连接`);
    } else {
      if (conn.givenUp) {
        // given-up → 新订阅重开预算：换代重建 supervision，订阅者条目保留
        // （重建完成后 onFetched 会把工具重新分发给他们——旧订阅者随共享恢复）
        this.log(`conn "${serverName}"@${entry.filePath}: given-up 收到新订阅，重开预算重建`);
        void conn.supervision.dispose().catch(() => {});
        conn.supervision = startSupervision(serverName, conn.cfg, conn.policy, conn.hooks, conn.logFn);
        conn.givenUp = false;
      }
      clearGraceTimer(conn);
    }
    // 订阅簿记登记（同步段；入队即摘的对称面：加入也是同步段）
    entry.subscriptions.set(serverName, conn);
    this.enqueueSubscribe(conn, entry);
    return conn;
  }

  private enqueueSubscribe(conn: SharedConnection, entry: AgentEntry): void {
    this.enqueue(conn, () => {
      if (conn.disposed) return;
      if (conn.subscribers.has(entry.agentId)) return; // 幂等
      conn.subscribers.set(entry.agentId, {
        agentId: entry.agentId,
        agentCtx: entry.agentCtx,
        active: true,
        disposers: new Map(),
      });
      this.log(
        `conn "${conn.serverName}"@${conn.filePath}: subscribe ${entry.agentId} (refs=${conn.subscribers.size})`
      );
      this.applyToSubscriber(conn, conn.subscribers.get(entry.agentId)!);
    });
  }

  private enqueueUnsubscribe(conn: SharedConnection, agentId: string): void {
    // 先置失活（同步段）：进行中的 apply 立即跳过该订阅者
    const sub = conn.subscribers.get(agentId);
    if (sub) sub.active = false;
    this.enqueue(conn, () => {
      if (conn.disposed) return;
      const s = conn.subscribers.get(agentId);
      if (!s) return; // 幂等
      stripSubscriberTools(s);
      conn.subscribers.delete(agentId);
      this.log(
        `conn "${conn.serverName}"@${conn.filePath}: unsubscribe ${agentId} (refs=${conn.subscribers.size})`
      );
      if (conn.subscribers.size === 0) this.armGraceTimer(conn);
    });
  }

  // ------------------------------------------------------------------
  // 连接级串行链（含活性守卫）与工具分发
  // ------------------------------------------------------------------

  /** 入队连接级任务；执行时先过活性守卫（已 dispose+删表则整任务 no-op）。 */
  private enqueue(conn: SharedConnection, task: () => void | Promise<void>): void {
    const run = conn.chain.then(async () => {
      if (conn.disposed) return;
      await task();
    });
    conn.chain = run.catch(() => {});
  }

  /** 把当前代的工具分发到全部活跃订阅者（幂等全量置换）。 */
  private applyAll(conn: SharedConnection): void {
    for (const sub of conn.subscribers.values()) {
      this.applyToSubscriber(conn, sub);
    }
    this.log(
      `conn "${conn.serverName}"@${conn.filePath}: sync ${conn.subscribers.size}/${conn.subscribers.size} 订阅者更新`
    );
  }

  /**
   * 两阶段置换（单订阅者粒度）：按订阅者实例化 definitions（不跨订阅者共享
   * 对象）→ dispose 旧注册 → 注册新一代 → 任一失败该订阅者整代回滚为 0 工具。
   */
  private applyToSubscriber(conn: SharedConnection, sub: Subscriber): void {
    if (!sub.active) return;
    const client: Client | undefined = conn.supervision.getCurrentClient();
    const tools = conn.supervision.getCurrentTools();
    if (!client || !tools) return; // 尚未就绪（连接中/given-up）；onFetched 会再驱动

    const built = new Map<string, any>();
    try {
      for (const tool of tools) {
        const publicName = publicToolName(conn.serverName, tool.name);
        if (built.has(publicName)) {
          throw new Error(
            `server "${conn.serverName}": 工具 "${tool.name}" 归一化后同名（${publicName}）——非法工具列表`
          );
        }
        built.set(
          publicName,
          buildToolDefinition(conn.supervision.invokeWithRecovery, conn.serverName, tool, conn.cfg)
        );
      }
    } catch (e: any) {
      this.log(
        `conn "${conn.serverName}"@${conn.filePath}: 工具定义构建失败，保持上一代注册: ${e?.message ?? e}`
      );
      return;
    }

    for (const d of sub.disposers.values()) {
      try { d(); } catch { /* 忽略 */ }
    }
    sub.disposers = new Map();
    try {
      for (const [publicName, definition] of built) {
        sub.disposers.set(publicName, sub.agentCtx.tools.register(definition));
      }
    } catch (e: any) {
      for (const d of sub.disposers.values()) {
        try { d(); } catch { /* 忽略 */ }
      }
      sub.disposers = new Map();
      this.log(
        `conn "${conn.serverName}"@${conn.filePath}: 订阅者 ${sub.agentId} 工具注册失败，该订阅者 0 个工具（已回滚）: ${e?.message ?? e}`
      );
    }
  }

  // ------------------------------------------------------------------
  // grace：refs 归零后的保留宽限
  // ------------------------------------------------------------------

  private armGraceTimer(conn: SharedConnection): void {
    clearGraceTimer(conn);
    if (this.disposed) return;
    if (this.opts.idleDropMs <= 0) {
      this.dropConnection(conn);
      return;
    }
    const t = setTimeout(() => {
      conn.graceTimer = undefined;
      this.dropConnection(conn);
    }, this.opts.idleDropMs);
    (t as any).unref?.();
    conn.graceTimer = t;
    this.log(`conn "${conn.serverName}"@${conn.filePath}: refs=0，grace ${this.opts.idleDropMs}ms 后回收`);
  }

  private dropConnection(conn: SharedConnection): void {
    if (conn.disposed) return;
    this.log(`conn "${conn.serverName}"@${conn.filePath}: grace 到期，回收连接`);
    this.connections.delete(conn.key);
    void this.disposeConnection(conn);
  }

  /**
   * 连接销毁（幂等）：先置 disposed——在途任务继续跑完、后续队列任务经活性
   * 守卫 no-op——排空串行链后兜底清残留注册，最后 supervision.dispose
   * （ADR-0007 树杀兜底 + 断开）。删除条目/配置变化的回收都走这里（不走 grace）。
   */
  private async disposeConnection(conn: SharedConnection): Promise<void> {
    if (conn.disposed) return;
    conn.disposed = true;
    clearGraceTimer(conn);
    await conn.chain.catch(() => {});
    for (const sub of conn.subscribers.values()) stripSubscriberTools(sub);
    conn.subscribers.clear();
    await conn.supervision.dispose().catch(() => {});
  }

  // ------------------------------------------------------------------
  // watcher（每配置文件一个；判据 = liveAgents 空↔非空跃迁）
  // ------------------------------------------------------------------

  private attachWatcher(ps: PathState): void {
    try {
      const watcher = chokidar.watch(ps.filePath, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      });
      ps.watcher = watcher;
      watcher.on("all", () => {
        if (ps.reloadTimer) clearTimeout(ps.reloadTimer);
        ps.reloadTimer = setTimeout(() => {
          ps.reloadTimer = undefined;
          this.log(`配置文件变化，重新加载: ${ps.filePath}`);
          this.scheduleReload(ps);
        }, this.opts.reloadDebounceMs);
      });
    } catch (e: any) {
      this.log(`配置文件监听建立失败: ${e?.message ?? e}`);
    }
  }

  private closeWatcher(ps: PathState): Promise<void> | undefined {
    if (ps.reloadTimer) {
      clearTimeout(ps.reloadTimer);
      ps.reloadTimer = undefined;
    }
    if (ps.watcher) {
      const done = ps.watcher.close().catch(() => {});
      ps.watcher = undefined;
      return done;
    }
    return undefined;
  }

  // ------------------------------------------------------------------
  // reload：互斥 + dirty 终止语义 + 重挂枚举 + 收尾三件事
  // ------------------------------------------------------------------

  /** 文件变化入口；reload in-flight 时仅置 dirty（由在途 pass 收尾补跑）。 */
  private scheduleReload(ps: PathState): void {
    if (this.disposed) return;
    if (ps.reloading) {
      ps.dirty = true;
      return;
    }
    ps.reloading = true;
    void this.reloadAll(ps).catch((e: any) => {
      this.log(`重新加载失败: ${e?.message ?? e}`);
    });
  }

  /**
   * 互斥已持（ps.reloading = true）。循环执行 pass 直到出现干净一轮
   * （dirty 终止语义）；收尾三件事之 3（liveAgents 空 → 回收）在 finally
   * 等价点执行，覆盖含配置读取失败在内的全部退出路径。
   */
  private async reloadAll(ps: PathState): Promise<void> {
    try {
      for (let round = 0; ; round++) {
        ps.dirty = false; // pass 开始清零
        try {
          await this.reloadOnce(ps);
        } catch (e: any) {
          // reloadOnce 设计为不抛；防御性兜底（保留现状，等下一事件）
          this.log(`reload pass 异常（保守保留现状）: ${e?.message ?? e}`);
        }
        if (!ps.dirty) break;
        if (round >= 20) {
          this.log(`reload 连续 ${round + 1} 轮均有新订阅置位 dirty，停止补跑（防御上限）`);
          break;
        }
        this.log(`重挂 pass 内有新订阅置位 dirty，补跑一轮`);
      }
    } finally {
      ps.reloading = false;
      if (ps.liveAgents.size === 0 && !this.disposed) {
        this.closeWatcher(ps);
        this.paths.delete(ps.key);
      }
    }
  }

  /**
   * 一轮 reload（永不抛）：读 yml（区分 ENOENT/瞬态两类失败）→ 删除/变更条目
   * 立即 dispose（树杀联动，不走 grace）→ 重挂枚举 liveAgents × yml 全条目
   * （幂等 ensure+subscribe）。
   */
  private async reloadOnce(ps: PathState): Promise<void> {
    let entries: Array<[string, ServerConfig]>;
    try {
      const cfg = loadWorkspaceMcpConfig(ps.cwd, this.opts.configFile);
      // ENOENT（文件删除）= 明确失效 → 空条目集对账：摘除全部订阅并整树回收
      entries = cfg ? Object.entries(cfg.servers) : [];
    } catch (e: any) {
      // 瞬态读取/解析错误：保守保留上一配置连接，等下一事件收敛
      // （避免编辑器原子保存窗口期的整树误杀）
      this.log(`配置读取失败（保守保留现状，等下一事件）: ${e?.message ?? e}`);
      return;
    }
    const wanted = new Map(entries);

    // 删除条目 / 内容变化 → 立即 dispose（不走 grace；联动 ADR-0007 树杀）
    for (const [key, conn] of [...this.connections.entries()]) {
      if (conn.pathKey !== ps.key) continue;
      const fresh = wanted.get(conn.serverName);
      if (!fresh || !serverConfigEquals(conn.cfg, fresh as ServerConfig)) {
        this.connections.delete(key);
        // 同步摘除各 live agent 对该连接的簿记项（连接不复存在；残留会让
        // disposed 扇出枚举到死连接、pre-step 自检失明——与「入队即摘」同一纪律）
        for (const agentId of ps.liveAgents) {
          const entry = this.agents.get(agentId);
          if (entry && entry.subscriptions.get(conn.serverName) === conn) {
            entry.subscriptions.delete(conn.serverName);
          }
        }
        this.log(
          `conn "${conn.serverName}"@${conn.filePath}: ${fresh ? "配置已变化" : "条目已删除"}，立即回收（树杀联动）`
        );
        await this.disposeConnection(conn);
      }
    }

    // 重挂枚举：liveAgents × yml 全条目，幂等 ensure + subscribe
    for (const agentId of [...ps.liveAgents]) {
      const entry = this.agents.get(agentId);
      if (!entry || entry.pathKey !== ps.key) continue;
      for (const [serverName, serverCfg] of wanted) {
        this.subscribeAgentEnumerate(entry, ps, serverName, serverCfg as ServerConfig);
      }
    }
  }

  // ------------------------------------------------------------------
  // 插件级 dispose（fiber dispose / HMR / 卸载）
  // ------------------------------------------------------------------

  async disposeAll(): Promise<void> {
    this.disposed = true;
    const watcherJobs: Promise<void>[] = [];
    for (const ps of this.paths.values()) {
      const done = this.closeWatcher(ps);
      if (done) watcherJobs.push(done);
    }
    const jobs: Promise<void>[] = [];
    for (const conn of this.connections.values()) {
      jobs.push(this.disposeConnection(conn));
    }
    this.connections.clear();
    this.paths.clear();
    this.agents.clear();
    this.ensuring.clear();
    await Promise.all(jobs);
    // watcher 关闭是异步的：等它落地再返回，避免测试进程紧随其后 exit 时
    // 撞上 libuv 的 closing-handle 断言
    await Promise.all(watcherJobs);
    this.log(`插件卸载：已清理全部连接 / watcher / 簿记`);
  }

  // ------------------------------------------------------------------
  // 观测面（测试与排障用）
  // ------------------------------------------------------------------

  connectionKeys(): string[] {
    return [...this.connections.keys()];
  }

  connectionInfo(key: string):
    | { serverName: string; refs: number; givenUp: boolean; disposed: boolean }
    | undefined {
    const conn = this.connections.get(key);
    if (!conn) return undefined;
    return {
      serverName: conn.serverName,
      refs: conn.subscribers.size,
      givenUp: conn.givenUp,
      disposed: conn.disposed,
    };
  }

  readyOf(key: string): Promise<{ error?: unknown }> | undefined {
    return this.connections.get(key)?.ready;
  }

  pathKeys(): string[] {
    return [...this.paths.keys()];
  }

  liveAgentsOf(pathKey: string): string[] {
    return [...(this.paths.get(pathKey)?.liveAgents ?? [])];
  }

  agentSubscriptionServerNames(agentId: string): string[] {
    return [...(this.agents.get(agentId)?.subscriptions.keys() ?? [])];
  }

  /** 等全部连接串行链排空（测试断言前的稳定点；best-effort）。 */
  async whenSettled(): Promise<void> {
    await Promise.all([...this.connections.values()].map((c) => c.chain.catch(() => {})));
  }

  private log(msg: string): void {
    this.opts.log(msg);
  }
}

function clearGraceTimer(conn: SharedConnection): void {
  if (conn.graceTimer) {
    clearTimeout(conn.graceTimer);
    conn.graceTimer = undefined;
  }
}

function stripSubscriberTools(sub: Subscriber): void {
  for (const d of sub.disposers.values()) {
    try { d(); } catch { /* 忽略 */ }
  }
  sub.disposers = new Map();
}
