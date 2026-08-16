/**
 * MCP server 受监督连接（supervisor）+ 工具发现 + agent-scoped 注册。
 * 复用 @modelcontextprotocol/sdk，命名 mcp__<server>__<tool>（与 dsh-mcp-client 一致）。
 *
 * 连接监督机制移植自官方 @deepseek-ai/dsh-mcp-client 的 connection 模块：
 *   - 每次 attempt 一代全新 Client+transport（MCP SDK 把 Protocol 绑死在单个
 *     transport 上，重连必须换代，不能复用旧 client）
 *   - generation.onclose 驱动断线检测（stdio 子进程退出 / HTTP 连接断开）
 *   - 指数退避重连：initialDelayMs * 2^(n-1)，封顶 maxDelayMs
 *   - 一次断线共享一次尝试预算（maxAttempts）；连接存活 ≥ maxDelayMs 后预算
 *     重置——偶发崩溃的 server 能无限恢复，crash-loop 的会被掐掉
 *   - 预算耗尽：卸载该 server 全部工具并停止；改配置文件（watcher reload）
 *     或重启是唯一恢复路径
 *   - 监听 ToolListChangedNotification：server 热改工具列表即时重同步
 *   - close 竞态防护：失败一代 5s 内未确认关闭则停止重连，避免 stdio 进程重叠
 *   - 会话失效主动判定（ADR-0005）：streamable-http 的 server 重启/会话驱逐只表现为
 *     请求错误（HTTP 404 / "Session not found"），transport 不 close、onclose 永不
 *     触发；在工具调用与重同步失败路径上识别此类错误，主动换代重连
 *   - 官方对齐补齐（ADR-0006）：stdio 子进程 scrubbed 父环境继承、重复 public 名
 *     守卫、注册冲突整代回滚、outputSchema→structuredContent 输出契约、
 *     taskSupport=required 明确拒绝
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ListToolsResultSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReconnectPolicy, ServerConfig } from "./config.js";

const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;

/** 失败一代等待 transport 确认关闭的上限（防僵死挂起 teardown）。 */
const GENERATION_CLOSE_TIMEOUT_MS = 5_000;
/** Node setTimeout 的合法上限。 */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * 宽松结果校验 schema：信任 MCP server 返回的 JSON，只做 record(shape) 校验，
 * 不让 SDK 用 CallToolResultSchema 预校验（否则遇到结构化/兼容结果会失败）。
 * 与官方 dsh-mcp-client 的 RawCallToolResultSchema 一致。
 */
const RawCallToolResultSchema = z.record(z.string(), z.unknown());

/**
 * 会话失效文案特征：覆盖官方 SDK server（"Session not found"）、FastMCP 系
 * （"Session has expired"）及常见变体。HTTP 404 单独成条件（MCP streamable-http
 * 规范里 404 = 会话未知/已终止；StreamableHTTPError.code 即 HTTP 状态码）。
 */
const SESSION_LOSS_MESSAGE_PATTERN =
  /session not found|session (has )?expired|invalid or expired session|unknown session/i;

/**
 * 判断一个错误是否表明 server 侧会话已失效（server 重启 / 会话驱逐 / 重新部署）。
 *
 * 此类错误只会让当次请求失败——transport 不 close、onclose 永不触发，supervisor
 * 若无人上报就永远不知道会话已死（工具持续失败直到改配置或重启）。保守匹配：
 * 偶发 5xx、超时等瞬时错误不在此列，不应触发换代。
 */
export function isSessionLossError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as any).code === 404) return true;
  return SESSION_LOSS_MESSAGE_PATTERN.test(error.message ?? "");
}

/**
 * 从 MCP content 数组中提取文本，与官方 dsh-mcp-client 的 extractText 一致。
 * text blocks 拼接为字符串；image/audio/resource 替换为占位符。
 */
function extractText(mcpContent: any[], toolName: string): string {
  const parts: string[] = [];
  for (const value of mcpContent) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      parts.push("[unsupported content type: unknown]");
      continue;
    }
    const block = value as Record<string, any>;
    switch (block.type) {
      case "text":
        if (block.text !== undefined) parts.push(String(block.text));
        break;
      case "image":
        parts.push(`[image: ${block.mimeType ?? "unknown"}, content discarded]`);
        break;
      case "audio":
        parts.push(`[audio: ${block.mimeType ?? "unknown"}, content discarded]`);
        break;
      case "resource":
      case "resource_link":
        parts.push("[resource: content discarded]");
        break;
      default:
        parts.push(`[unsupported content type: ${block.type ?? "unknown"}]`);
    }
  }
  return parts.join("\n") || `(${toolName} returned no text content)`;
}

export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, "_");
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash("sha256")
    .update(`${serverName}\0${rawName}`)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/**
 * 保留 server 声明的 outputSchema 中受支持的 JSON Schema 词汇；不支持
 * 的词汇整体降级为 undefined（不声明 structuredContent 契约），与官方
 * dsh-mcp-client 的 supportedOutputSchema 一致。
 */
function supportedOutputSchema(candidate: unknown): any {
  if (candidate === undefined) return undefined;
  try {
    assertSupportedJsonSchema(candidate as any);
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * 工具输出契约（与官方 dsh-mcp-client 的 createOutput 一致）：
 * content 数组 + structuredContent（server 声明且受支持时为该 schema，
 * 否则空对象占位）；additionalProperties: false；声明了 structured
 * schema 时两项都 required。render 投影与官方一致（文本提取）。
 */
function createOutput(rawName: string, structuredSchema: any): any {
  return {
    schema: {
      type: "object",
      properties: {
        content: { type: "array", items: {} },
        structuredContent: structuredSchema ?? {},
      },
      required:
        structuredSchema === undefined ? ["content"] : ["content", "structuredContent"],
      additionalProperties: false,
    },
    render(_args: any, value: any): any[] {
      // render 必须返回 ContentBlocks 数组，不能返回纯字符串。
      // DSH 的 contentHasImage 会递归对 tool-result 的 content 调用 .some()，
      // 如果返回字符串会导致 "content.some is not a function" 错误，
      // 且该错误会持久化到 session 日志中，导致后续每轮对话都失败。
      const content = Array.isArray(value?.content) ? value.content : [];
      return [{ type: "text", text: extractText(content, rawName) }];
    },
  };
}

/**
 * stdio 子进程环境基座（与官方 dsh-mcp-client 的 buildChildEnv 一致）：
 * scrubbed 父环境 + yml 显式 env（显式项覆盖同名 scrub 项）。
 *
 * SDK 的 StdioClientTransport 只给安全子集（PATH 等十余个），需要其余父环境
 * 变量（如 PYTHONPATH）的 server 会缺变量；scrubbedParentEnv 剥离凭据形状名
 * （/KEY|PASSWORD|SECRET|TOKEN/i）与 DSH_* 前缀名，杜绝 harness 凭据/状态
 * 隐式泄漏，显式传入的敏感名仍可通过（merge 在 scrub 之后）。
 */
function buildChildEnv(extra: Record<string, string> | undefined): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra };
}

function createTransport(cfg: ServerConfig) {
  if (cfg.transport === "stdio") {
    return new StdioClientTransport({
      command: cfg.command!,
      args: cfg.args ?? [],
      env: buildChildEnv(cfg.env),
      cwd: cfg.cwd,
    });
  }
  return new StreamableHTTPClientTransport(new URL(cfg.url!), {
    requestInit: cfg.headers ? { headers: cfg.headers } : {},
  });
}

/** 重连策略默认值（与官方 dsh-mcp-client 的 RECONNECT_DEFAULTS 一致）。 */
export const RECONNECT_DEFAULTS: Readonly<ReconnectPolicy> = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
});

/**
 * 解析重连策略：yml per-server 覆盖 > 插件级（patch config）> 内置默认，逐项合并。
 * 合并后重判边界（Schemastery 只盖插件级一层，程序化构造可绕过，故此处兜底）。
 *
 * @throws 策略非法时抛错（由调用方按 server 记日志跳过）。
 */
export function resolveReconnectPolicy(
  base: Partial<ReconnectPolicy> | undefined,
  override: Partial<ReconnectPolicy> | undefined,
  label: string
): ReconnectPolicy {
  const merged: ReconnectPolicy = {
    enabled: override?.enabled ?? base?.enabled ?? RECONNECT_DEFAULTS.enabled,
    initialDelayMs:
      override?.initialDelayMs ?? base?.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs,
    maxDelayMs: override?.maxDelayMs ?? base?.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs,
    maxAttempts:
      override?.maxAttempts ?? base?.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts,
  };
  for (const key of ["initialDelayMs", "maxDelayMs"] as const) {
    const v = merged[key];
    if (!Number.isFinite(v) || v <= 0 || v > MAX_TIMER_DELAY_MS) {
      throw new Error(`${label}: reconnect.${key} 需为不大于 ${MAX_TIMER_DELAY_MS} 的正数`);
    }
  }
  if (merged.initialDelayMs > merged.maxDelayMs) {
    throw new Error(`${label}: reconnect.initialDelayMs 不能大于 reconnect.maxDelayMs`);
  }
  if (!Number.isInteger(merged.maxAttempts) || merged.maxAttempts < 1) {
    throw new Error(`${label}: reconnect.maxAttempts 需为正整数`);
  }
  return merged;
}

/** 一个 server 的受监督连接句柄：自管理重连，dispose 时清理全部资源。 */
export interface SupervisedServer {
  serverName: string;
  /** 首次连接尝试的结果（无论成败；重连在后台继续，不反映在此 promise）。 */
  ready: Promise<{ error?: unknown }>;
  /** 停止监督：断开当前连接、清重连计时器、卸载全部工具。幂等。 */
  dispose(): Promise<void>;
}

/** 为一个工具构造 agent-scoped 注册定义（execute 绑定所属代的 client）。 */
function buildToolDefinition(
  generation: Client,
  serverName: string,
  tool: any,
  cfg: ServerConfig,
  onSessionLoss: (generation: Client) => void
): any {
  const publicName = publicToolName(serverName, tool.name);
  const rawName = tool.name;
  const timeoutMs = cfg.toolCallTimeoutMs ?? 60000;
  return {
    name: publicName,
    description: tool.description ?? "",
    parameters: tool.inputSchema,
    output: createOutput(rawName, supportedOutputSchema(tool.outputSchema)),
    async execute(args: any, exec: any) {
      // task-based 执行模式本桥不支持（与官方 dsh-mcp-client 一致），
      // 提前给出明确错误而非调用后得到模糊失败。
      if (tool?.execution?.taskSupport === "required") {
        throw new Error(
          `Tool "${rawName}" requires task-based execution, which this bridge does not support`
        );
      }
      const argObj = typeof args === "object" && args !== null ? args : {};
      let result: any;
      try {
        result = await generation.request(
          { method: "tools/call", params: { name: rawName, arguments: argObj } },
          RawCallToolResultSchema,
          { signal: exec?.signal, timeout: timeoutMs }
        );
      } catch (e) {
        // 会话失效（如 server 重启后的 "Session not found"）不会触发 onclose，
        // 必须在此上报 supervisor 换代重连；错误本身照常上抛——本次调用失败，
        // 重连成功后模型重试即命中新会话。
        if (isSessionLossError(e)) onSessionLoss(generation);
        throw e;
      }
      // MCP 返回的 content 可能不是数组（某些 server 返回 toolResult / 其他结构），
      // 与官方 dsh-mcp-client 一致：归一化为标准 content 数组。
      if (!Array.isArray(result?.content)) {
        const rendered =
          result && "toolResult" in result ? JSON.stringify((result as any).toolResult) : "(no output)";
        const text = typeof rendered === "string" ? rendered : "(no output)";
        if (result?.isError === true) {
          throw new Error(text);
        }
        return {
          content: [{ type: "text", text }],
          ...result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {},
        };
      }
      // 标准 content 数组路径
      const content = result.content;
      if (result?.isError === true) {
        throw new Error(extractText(content, rawName));
      }
      return {
        content,
        ...result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {},
      };
    },
  };
}

/**
 * 同步一代 client 的工具列表到 agent 注册表。
 *
 * 两阶段保安全（与官方 syncTools 一致）：
 *   1. fetch：分页拉全 tools/list，逐个构造注册定义；两个 raw name 归一化
 *      撞出同一 public 名（server 非法工具列表）或任何失败直接抛出，
 *      上一代注册原样保留（断线期间旧工具保持注册——模型可见性不抖动，
 *      调用会失败等重连换新）。
 *   2. swap：dispose 上一代，注册新一代；任一 register 抛错（如名字被
 *      外来注册占用）则整代回滚——本 server 0 个工具，绝无半代状态。
 */
async function syncTools(
  generation: Client,
  agentCtx: any,
  serverName: string,
  cfg: ServerConfig,
  previous: Map<string, () => void>,
  log: (msg: string) => void,
  onSessionLoss: (generation: Client) => void
): Promise<Map<string, () => void>> {
  const definitions = new Map<string, any>();
  let cursor: string | undefined;
  do {
    const resp = await generation.request(
      { method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
      ListToolsResultSchema
    );
    for (const tool of resp.tools) {
      const publicName = publicToolName(serverName, tool.name);
      if (definitions.has(publicName)) {
        throw new Error(
          `server "${serverName}": server 列出的工具 "${tool.name}" 与已有工具归一化后同名（${publicName}）——非法工具列表`
        );
      }
      definitions.set(publicName, buildToolDefinition(generation, serverName, tool, cfg, onSessionLoss));
    }
    cursor = resp.nextCursor;
  } while (cursor);

  for (const d of previous.values()) {
    try { d(); } catch { /* 忽略 */ }
  }
  const disposers = new Map<string, () => void>();
  try {
    for (const [publicName, definition] of definitions) {
      disposers.set(publicName, agentCtx.tools.register(definition));
    }
  } catch (e: any) {
    for (const d of disposers.values()) {
      try { d(); } catch { /* 忽略 */ }
    }
    log(`server "${serverName}": 工具注册失败，本代 0 个工具（已整代回滚）: ${e?.message ?? e}`);
    return new Map();
  }
  log(`server "${serverName}": 注册 ${disposers.size} 个工具`);
  return disposers;
}

/**
 * 启动一个 MCP server 的受监督连接：连接 → 发现工具 → 注册到 agent 的
 * scoped tools 服务；断线/失败按 policy 指数退避重连并重新注册。
 *
 * 注意: agent.ctx 在 agent/created 时可能是 inactive，不能用 agentCtx.effect，
 * 所以返回 SupervisedServer，由调用方在 agent/disposed / reload 时 dispose。
 *
 * @returns 监督句柄（不抛错；失败走重连策略，ready 携带首试结果）。
 */
export function startSupervisedConnection(
  agentCtx: any,
  serverName: string,
  cfg: ServerConfig,
  policy: ReconnectPolicy,
  log: (msg: string) => void
): SupervisedServer {
  const label = `server "${serverName}"`;

  let disposed = false;
  /** 当前代：连接中或已连接的 client；退避等待与最终放弃后为 undefined。 */
  let client: Client | undefined;
  /** 与 client 配对的关闭信号；dispose 抢先清空所有权前捕获。 */
  let clientClosed: Promise<void> | undefined;
  /** 本 server 持有的工具注册（dispose 换代）；仅 enqueueSync 与 dispose 交换。 */
  let disposers = new Map<string, () => void>();
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** 本次断线周期内连续失败的尝试次数。 */
  let failedAttempts = 0;
  /** 当前代完成 connect + 首次同步的时刻；断线期间为 undefined。 */
  let connectedAt: number | undefined;
  /** 首次尝试的真实错误，供 ready 诊断。 */
  let firstAttemptError: unknown;

  /** 一代只在它仍是当前代且插件存活时才允许行动。 */
  const isCurrent = (generation: Client) => !disposed && client === generation;

  /**
   * 串行化所有 syncTools 调用（首同步 + 跨代通知重同步），两次同步的
   * 换代交换永不交错（否则会双重 dispose 一代、泄漏另一代）。
   */
  let syncChain: Promise<void> = Promise.resolve();
  function enqueueSync(generation: Client): Promise<void> {
    const run = syncChain.then(async () => {
      if (!isCurrent(generation)) return;
      disposers = await syncTools(
        generation, agentCtx, serverName, cfg, disposers, log, reportSessionLoss
      );
    });
    syncChain = run.catch(() => {});
    return run;
  }

  /** 每代一次断线判定：isCurrent 守卫让竞速的 close/error 信号幂等。 */
  function generationDown(generation: Client): void {
    if (!isCurrent(generation)) return;
    client = undefined;
    clientClosed = undefined;
    scheduleReconnect();
  }

  /**
   * 会话失效上报：execute / 重同步在已建立的一代上识别出 "Session not found"
   * 类错误时调用。等价断线判定——streamable-http 的 transport 在 server 重启/
   * 会话驱逐后不会自己 close，onclose 永不触发，必须在此主动换代；旧代后台
   * 关闭（其 onclose 因 isCurrent 已失而幂等无害）。并发多个调用同时失败时，
   * isCurrent 守卫保证只有第一个生效。
   */
  function reportSessionLoss(generation: Client): void {
    if (!isCurrent(generation)) return;
    log(`${label}: server 会话已失效（如 Session not found），判定断线并重连`);
    generation.close().catch(() => {});
    generationDown(generation);
  }

  /** 等 transport 自己的关闭信号，坏 transport 不至于把 teardown 挂死。 */
  function waitForClose(closed: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), GENERATION_CLOSE_TIMEOUT_MS);
      timeout.unref();
      closed.then(() => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }

  function scheduleReconnect(): void {
    const lostEstablished = connectedAt !== undefined;
    if (!policy.enabled) {
      const message = lostEstablished
        ? "连接断开且重连已禁用——已注册工具将持续失败，改配置文件或重启可恢复"
        : "连接失败且重连已禁用——未注册任何工具，改配置文件或重启可重试";
      log(`${label}: ${message}`);
      return;
    }
    // 稳定窗口：连接存活 ≥ maxDelayMs 视为健康，断线重开一次全新预算
    if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) {
      failedAttempts = 0;
    }
    connectedAt = undefined;
    failedAttempts += 1;
    if (failedAttempts > policy.maxAttempts) {
      syncChain = syncChain.then(() => {
        for (const d of disposers.values()) {
          try { d(); } catch { /* 忽略 */ }
        }
        disposers = new Map();
      });
      log(`${label}: 连续 ${policy.maxAttempts} 次重连失败，放弃——工具已全部卸载；改配置文件或重启可重试`);
      return;
    }
    const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failedAttempts - 1));
    const action = lostEstablished ? "连接断开" : "连接失败";
    log(`${label}: ${action}，${delayMs}ms 后重连（第 ${failedAttempts}/${policy.maxAttempts} 次）`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      settling = connectGeneration();
    }, delayMs);
    reconnectTimer.unref();
  }

  /**
   * 一次连接尝试：全新 transport + client，connect 后排队首次工具同步。
   * 所有失败汇入 generationDown；成功则武装 onclose 驱动的断线路径。永不 reject。
   */
  async function connectGeneration(): Promise<void> {
    const generation = new Client(
      { name: "dsh-workspace-mcp", version: "0.1.0" },
      { capabilities: {} }
    );
    let resolveClose!: () => void;
    const closed = new Promise<void>((r) => { resolveClose = r; });
    let attemptSettled = false;
    let closeObserved = false;
    const hasClosed = () => closeObserved;
    client = generation;
    clientClosed = closed;
    generation.onclose = () => {
      closeObserved = true;
      resolveClose();
      if (attemptSettled) generationDown(generation);
    };
    generation.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (!isCurrent(generation)) return;
      log(`${label}: 工具列表变化，重新同步`);
      try {
        await enqueueSync(generation);
      } catch (e: any) {
        if (disposed) return;
        if (isSessionLossError(e)) reportSessionLoss(generation);
        else log(`${label}: 工具重同步失败: ${e?.message ?? e}`);
      }
    });
    try {
      await generation.connect(createTransport(cfg));
      if (hasClosed()) {
        attemptSettled = true;
        generationDown(generation);
        return;
      }
      await enqueueSync(generation);
    } catch (e: any) {
      if (firstAttemptError === undefined) firstAttemptError = e;
      if (isCurrent(generation)) log(`${label}: 连接尝试失败: ${e?.message ?? e}`);
      try { await generation.close(); } catch { /* 忽略 */ }
      const quiesced = hasClosed() || (await waitForClose(closed));
      attemptSettled = true;
      if (!isCurrent(generation)) return;
      if (!quiesced) {
        client = undefined;
        clientClosed = undefined;
        log(`${label}: 失败一代未在 ${GENERATION_CLOSE_TIMEOUT_MS}ms 内关闭——为避免 server 进程重叠，停止重连；改配置文件或重启可重试`);
        return;
      }
      generationDown(generation);
      return;
    }
    attemptSettled = true;
    if (hasClosed()) {
      generationDown(generation);
      return;
    }
    if (!isCurrent(generation)) return;
    connectedAt = Date.now();
    if (failedAttempts > 0) {
      log(`${label}: 重连成功，工具已重新同步（第 ${failedAttempts}/${policy.maxAttempts} 次尝试）`);
    }
  }

  let settling = connectGeneration();
  const firstSettling = settling;
  return {
    serverName,
    ready: firstSettling.then(() => {
      if (client !== undefined) return {};
      return { error: firstAttemptError ?? new Error(`${label}: 初始连接失败`) };
    }),
    async dispose() {
      disposed = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const current = client;
      const currentClosed = clientClosed;
      client = undefined;
      clientClosed = undefined;
      if (current !== undefined) {
        try { await current.close(); } catch { /* 忽略 */ }
        if (currentClosed !== undefined && !(await waitForClose(currentClosed))) {
          log(`${label}: dispose 时一代连接未在 ${GENERATION_CLOSE_TIMEOUT_MS}ms 内关闭，server 关闭可能不完整`);
        }
      }
      await settling;
      await syncChain;
      for (const d of disposers.values()) {
        try { d(); } catch { /* 忽略 */ }
      }
      disposers = new Map();
    },
  };
}
