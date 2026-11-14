/**
 * MCP server 受监督连接（supervisor）+ 工具发现（fetch 层）。
 * 复用 @modelcontextprotocol/sdk，命名 mcp__<server>__<tool>（与 dsh-mcp-client 一致）。
 *
 * 方案C（ADR-0008）分层：本模块只负责「连接层」——一个 server 条目一条受监督
 * 连接（同一 workspace 的全体 agent 共享），不再持有任何 agentCtx：
 *   - 连接成功后 fetch 一代 tools/list（含 publicName 冲突守卫），把工具元数据
 *     交给 registry（hooks.onFetched）分发到各订阅者注册（apply 在 registry.ts）；
 *   - ToolListChanged → 重拉 → 再次 onFetched；
 *   - 重连预算耗尽 → hooks.onGivenUp，registry 卸载全部订阅者的注册（订阅者
 *     条目保留，重建后随共享恢复）。
 * 监督机制移植自官方 @deepseek-ai/dsh-mcp-client 的 connection 模块：
 *   - 每次 attempt 一代全新 Client+transport（MCP SDK 把 Protocol 绑死在单个
 *     transport 上，重连必须换代，不能复用旧 client）
 *   - generation.onclose 驱动断线检测（stdio 子进程退出 / HTTP 连接断开）
 *   - 指数退避重连：initialDelayMs * 2^(n-1)，封顶 maxDelayMs
 *   - 一次断线共享一次尝试预算（maxAttempts）；连接存活 ≥ maxDelayMs 后预算
 *     重置——偶发崩溃的 server 能无限恢复，crash-loop 的会被掐掉
 *   - close 竞态防护：失败一代 5s 内未确认关闭则停止重连，避免 stdio 进程重叠
 *   - 会话失效主动判定（ADR-0005）+ 调用内重启自愈（ADR-0009）：streamable-http
 *     的 server 重启/会话驱逐只表现为请求错误（HTTP 404 / "Session not found"），
 *     transport 不 close、onclose 永不触发；调用与重拉取失败路径按 diagnostic
 *     分类识别此类「可证明未触达工具执行」的失败，主动换代重连，且原调用在
 *     同一次 execute 内等新代就绪后重试一次——调用方（模型）无感知
 *   - 官方对齐补齐（ADR-0006）：stdio 子进程 scrubbed 父环境继承、重复 public 名
 *     守卫、outputSchema→structuredContent 输出契约、taskSupport=required 明确拒绝
 *   - stdio 树杀兜底（ADR-0007）：dispose 与连接失败路径对直接子进程
 *     taskkill /T /F 整树击杀，补 SDK close 只杀单进程的缺口——多层命令链
 *     （如 uvx→uv→exe→python）解析中不读 stdin，EOF 软回收够不着（Windows-only）
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
import { classifyRestartRecovery, isSessionLossError } from "./diagnostic.js";
import { killTree } from "./tree-kill.js";

export { isSessionLossError };

const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;

/**
 * server instructions 的 UTF-8 字节上限（与官方 dsh-mcp-client 的
 * DEFAULT_MAX_INSTRUCTION_BYTES 一致，per-server 可经 maxInstructionBytes 覆盖）。
 * 超限按该次连接尝试失败处理（走既有重连路径）——对齐官方语义：
 * 过长 instructions 是反模式，宁可连接失败也不塞进 system prompt。
 */
export const DEFAULT_MAX_INSTRUCTION_BYTES = 32_768;

/** 失败一代等待 transport 确认关闭的上限（防僵死挂起 teardown）。 */
const GENERATION_CLOSE_TIMEOUT_MS = 5_000;
/** Node setTimeout 的合法上限。 */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * 调用内恢复等待新代连接就绪的预算上限（ADR-0009）：实际取
 * min(toolCallTimeoutMs, 本值)——工具调用超时本来就更短时尊重它。
 */
const RECOVERY_RECONNECT_BUDGET_MS = 30_000;

/**
 * 宽松结果校验 schema：信任 MCP server 返回的 JSON，只做 record(shape) 校验，
 * 不让 SDK 用 CallToolResultSchema 预校验（否则遇到结构化/兼容结果会失败）。
 * 与官方 dsh-mcp-client 的 RawCallToolResultSchema 一致。
 */
const RawCallToolResultSchema = z.record(z.string(), z.unknown());

/**
 * 给一个 promise 加截止时间（ADR-0009）：超时 reject，原 promise 的
 * settle 照常传递。用于恢复等待新代的预算控制。
 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待超过 ${ms}ms 预算`)), ms);
    timer.unref?.();
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
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

/** registry 分发工具定义时的回调集（方案C：fetch 在连接层，apply 在注册层）。 */
export interface SupervisionHooks {
  /** 当前代 tools/list 已拉取（首连、重连成功、toolListChanged 重拉）。幂等分发。 */
  onFetched(): void;
  /** 重连预算耗尽：registry 卸载全部订阅者的注册（订阅者条目保留，重建后随共享恢复）。 */
  onGivenUp(): void;
}

/** 一个 server 条目的共享连接监督句柄（无 agentCtx；多订阅者共用）。 */
export interface Supervision {
  readonly serverName: string;
  /** 首次连接尝试的结果（无论成败；重连在后台继续，不反映在此 promise）。 */
  readonly ready: Promise<{ error?: unknown }>;
  /** 当前代 client（连接中/已连接；退避等待、最终放弃、dispose 后为 undefined）。 */
  getCurrentClient(): Client | undefined;
  /** 当前代已拉取的工具元数据（tools/list 原始条目；未拉取过为 undefined）。 */
  getCurrentTools(): readonly any[] | undefined;
  /**
   * 最后一次成功连接的 server instructions（`### MCP server: <名>` 包装，UTF-8
   * 字节计超限截断不存在——超限按连接失败处理）。断线不清空、重连成功后更新
   * （与官方 dsh-mcp-client 的 serverInstructions 快照语义一致）；server 未声明
   * 或从未连成时为空串。供 systemPrompt section 的 text 惰性读取。
   */
  getInstructions(): string;
  /**
   * 带重启自愈的调用桥（ADR-0009）：operation 在当前代上执行；失败命中
   * classifyRestartRecovery 分类时丢弃当前代、等新代就绪（预算
   * min(timeoutMs, 30s)）后重试一次——调用方无感知。并发撞上同一重启的
   * 调用共享一次重建；不可恢复失败、重连放弃/超时、dispose 均原样上抛。
   */
  invokeWithRecovery<T>(
    what: string,
    timeoutMs: number,
    operation: (client: Client) => Promise<T>
  ): Promise<T>;
  /** 停止监督：树杀兜底 + 断开当前连接、清重连计时器。幂等、不抛。 */
  dispose(): Promise<void>;
}

/**
 * 为一个工具构造订阅者作用域的注册定义。方案C：registry 对每个订阅者重新
 * 调用本函数实例化（不跨订阅者共享定义对象——register 纯度未证实，防挂
 * 元数据互相污染）。
 *
 * execute 不闭包捕获注册时的那代 client（ADR-0009）：调用经 supervision 的
 * invokeWithRecovery 转发到调用时刻的当前代——换代后旧注册的 execute 依然
 * 可用，且失败时自动走重启自愈（换代 → 等新代 → 重试一次）。
 */
export function buildToolDefinition(
  invoke: Supervision["invokeWithRecovery"],
  serverName: string,
  tool: any,
  cfg: ServerConfig
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
      // 重启自愈内置在 invokeWithRecovery：Session not found / server 不可达
      // 类失败会在内部换代重试一次，此处不再需要单独的会话失效上报。
      const result: any = await invoke(
        `tool "${rawName}" 调用`,
        timeoutMs,
        (generation) =>
          generation.request(
            { method: "tools/call", params: { name: rawName, arguments: argObj } },
            RawCallToolResultSchema,
            { signal: exec?.signal, timeout: timeoutMs }
          )
      );
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
 * 拉取一代工具列表（fetch 层，连接级一次）：分页 tools/list + publicName
 * 冲突守卫。失败上抛由调用方按连接尝试失败处理；失败时上一代已注册的
 * 工具原样保留（可见性不抖动，调用会失败等重连换新）。
 */
async function fetchTools(generation: Client, serverName: string): Promise<any[]> {
  const tools: any[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const resp = await generation.request(
      { method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
      ListToolsResultSchema
    );
    for (const tool of resp.tools) {
      const publicName = publicToolName(serverName, tool.name);
      if (seen.has(publicName)) {
        throw new Error(
          `server "${serverName}": server 列出的工具 "${tool.name}" 与已有工具归一化后同名（${publicName}）——非法工具列表`
        );
      }
      seen.add(publicName);
      tools.push(tool);
    }
    cursor = resp.nextCursor;
  } while (cursor);
  return tools;
}

/**
 * 启动一个 MCP server 条目的共享监督连接（连接层，无 agentCtx）：
 * 连接 → fetch 工具 → hooks.onFetched 交 registry 分发订阅者；断线/失败按
 * policy 指数退避重连并重新 fetch；预算耗尽 → hooks.onGivenUp。
 *
 * @returns 监督句柄（不抛错；失败走重连策略，ready 携带首试结果）。
 */
export function startSupervision(
  serverName: string,
  cfg: ServerConfig,
  policy: ReconnectPolicy,
  hooks: SupervisionHooks,
  log: (msg: string) => void
): Supervision {
  const label = `server "${serverName}"`;

  let disposed = false;
  /** 当前代：连接中或已连接的 client；退避等待与最终放弃后为 undefined。 */
  let client: Client | undefined;
  /** 与 client 配对的关闭信号；dispose 抢先清空所有权前捕获。 */
  let clientClosed: Promise<void> | undefined;
  /** 与 client 配对的当前代 transport；树杀兜底从它取直接子进程 pid。 */
  let currentTransport: StdioClientTransport | StreamableHTTPClientTransport | undefined;
  /** 当前代已拉取的工具元数据；未拉取过/断线后为 undefined。 */
  let currentTools: any[] | undefined;
  /**
   * 最后一次成功连接的 instructions 快照（`### MCP server: <名>` 包装；server
   * 未声明或从未连成为空串）。断线不清空、重连成功后整体替换——section 的
   * text 惰性读取本值，重连换代后内容自动跟上（与官方 dsh-mcp-client 一致）。
   */
  let serverInstructions = "";
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** 本次断线周期内连续失败的尝试次数。 */
  let failedAttempts = 0;
  /** 当前代完成 connect + 首次 fetch 的时刻；断线期间为 undefined。 */
  let connectedAt: number | undefined;
  /** 首次尝试的真实错误，供 ready 诊断。 */
  let firstAttemptError: unknown;
  /**
   * 重启自愈等待者（ADR-0009）：invokeWithRecovery 丢弃当前代后在此排队，
   * 等下一个已连接的新代 settle；重连放弃/停止/dispose 时以错误 settle。
   */
  const generationWaiters = new Set<{
    promise: Promise<Client>;
    resolve: (client: Client) => void;
    reject: (error: unknown) => void;
  }>();

  /**
   * 被主动 close 的代（forceReconnect 触发）。SDK 的 Client.close() 会同步
   * 把该代仍在飞行中的请求 reject 为 McpError(-32000, "Connection closed")
   * ——这些并发调用是 close 的受害者，而 close 的前提是并发的另一个调用已
   * 证实 session 死亡 / server 不可达（server 侧必然同样在入口拒绝），对
   * 它们豁免重试是安全的。除主动 close 外的 -32000（如 stdio 进程死亡时
   * 的 onclose 连锁）不在此列——请求可能已被执行，维持不可重试。
   */
  const forceClosedGenerations = new WeakSet<Client>();

  /** SDK 的连接关闭连锁错误：McpError(-32000, "Connection closed")。 */
  function isConnectionClosedError(e: unknown): boolean {
    return (
      typeof e === "object" &&
      e !== null &&
      (e as any).code === -32000 &&
      /connection closed/i.test(String((e as any).message ?? ""))
    );
  }

  /** 手写 deferred（target ES2022 无 Promise.withResolvers 类型）。 */
  function deferredClient(): {
    promise: Promise<Client>;
    resolve: (client: Client) => void;
    reject: (error: unknown) => void;
  } {
    let resolve!: (client: Client) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Client>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /**
   * 等待「晚于恢复触发代」的已连接代：当前代已连接则立即满足（并发撞同一
   * 重启的后续调用者：别人已重建完成，直接用）；否则入队，由
   * settleGenerationWaiters 在新代连接成功 / 重连停止时 settle。
   */
  function waitForFreshGeneration(): Promise<Client> {
    const record = client;
    if (record !== undefined && connectedAt !== undefined) {
      return Promise.resolve(record);
    }
    const waiter = deferredClient();
    generationWaiters.add(waiter);
    return waiter.promise;
  }

  /** settle 全部等待者：record 已连接 → resolve；否则 reject(error)。 */
  function settleGenerationWaiters(record: Client | undefined, error?: unknown): void {
    if (generationWaiters.size === 0) return;
    const waiters = [...generationWaiters];
    generationWaiters.clear();
    for (const waiter of waiters) {
      if (record !== undefined && connectedAt !== undefined) waiter.resolve(record);
      else waiter.reject(error ?? new Error(`${label}: 重连停止，未能得到新连接`));
    }
  }

  /** 从 transport 取直接子进程 pid（streamable-http 无 pid；stdio 未 start 时为 null）。 */
  const pidOf = (t: typeof currentTransport): number | undefined =>
    t && "pid" in t && typeof t.pid === "number" ? t.pid : undefined;

  /** 一代只在它仍是当前代且句柄存活时才允许行动。 */
  const isCurrent = (generation: Client) => !disposed && client === generation;

  /** 每代一次断线判定：isCurrent 守卫让竞速的 close/error 信号幂等。 */
  function generationDown(generation: Client): void {
    if (!isCurrent(generation)) return;
    client = undefined;
    clientClosed = undefined;
    currentTransport = undefined;
    currentTools = undefined;
    scheduleReconnect();
  }

  /**
   * 主动换代：调用路径识别出重启类失败（会话失效 / server 不可达）时调用。
   * 等价断线判定——streamable-http 的 transport 在 server 重启/会话驱逐后
   * 不会自己 close，onclose 永不触发，必须在此主动换代；旧代后台关闭（其
   * onclose 因 isCurrent 已失而幂等无害）。并发多个调用同时失败时，
   * isCurrent 守卫保证只有第一个生效——后来者直接进等待队列共享同一次重建。
   */
  function forceReconnect(generation: Client, kind: string): void {
    if (!isCurrent(generation)) return;
    log(`${label}: ${kind} 类失败，判定断线并换代重连`);
    forceClosedGenerations.add(generation);
    generation.close().catch(() => {});
    generationDown(generation);
  }

  /**
   * 带重启自愈的调用桥（ADR-0009）：operation 在当前代上执行，失败命中
   * classifyRestartRecovery 分类时丢弃当前代、复用既有重连循环重建，等新代
   * 就绪（预算 min(timeoutMs, 30s)）后重试一次——调用方无感知。分类保证
   * 失败可证明未触达工具执行，重放不可能重复非幂等工具；ECONNRESET、超时、
   * abort、504 等不分类，原样上抛。重连放弃/预算耗尽/dispose 时上抛原始
   * 调用错误（对模型更有用）；第二次失败同样原样上抛。
   */
  async function invokeWithRecovery<T>(
    what: string,
    timeoutMs: number,
    operation: (client: Client) => Promise<T>
  ): Promise<T> {
    const first = client;
    if (first === undefined || connectedAt === undefined) {
      throw new Error(`${label}: server 未连接（重连中或已放弃），本次调用失败`);
    }
    try {
      return await operation(first);
    } catch (e) {
      let kind = classifyRestartRecovery(e);
      if (kind === undefined && forceClosedGenerations.has(first) && isConnectionClosedError(e)) {
        // 主动 close 的连锁 reject：并发的另一个调用已证实重启（session 死 /
        // 不可达），本请求在 server 侧必然同样未执行——按 session-lost 恢复
        kind = "session-lost";
      }
      if (kind === undefined || disposed) throw e;
      log(`${label}: ${what} 命中 ${kind} 类失败（${(e as any)?.message ?? e}），丢弃当前连接并重试一次`);
      forceReconnect(first, kind);
      const budgetMs = Math.min(timeoutMs, RECOVERY_RECONNECT_BUDGET_MS);
      let fresh: Client | undefined;
      try {
        fresh = await withDeadline(waitForFreshGeneration(), budgetMs);
      } catch {
        // 重连放弃/停止/等待超预算——原始错误比等待失败原因更有用
        throw e;
      }
      if (fresh === undefined || fresh === first) throw e;
      return await operation(fresh);
    }
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
        ? "连接断开且重连已禁用——工具调用将持续失败，改配置文件或重启可恢复"
        : "连接失败且重连已禁用——无可用工具，改配置文件或重启可重试";
      log(`${label}: ${message}`);
      settleGenerationWaiters(undefined, new Error(`${label}: ${message}`));
      return;
    }
    // 稳定窗口：连接存活 ≥ maxDelayMs 视为健康，断线重开一次全新预算
    if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) {
      failedAttempts = 0;
    }
    connectedAt = undefined;
    failedAttempts += 1;
    if (failedAttempts > policy.maxAttempts) {
      currentTools = undefined;
      hooks.onGivenUp();
      log(`${label}: 连续 ${policy.maxAttempts} 次重连失败，放弃——已卸载订阅者的工具（订阅者保留）；新订阅或配置重载将重开预算`);
      settleGenerationWaiters(undefined, new Error(`${label}: 连续 ${policy.maxAttempts} 次重连失败，放弃重连`));
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
   * 一次连接尝试：全新 transport + client，connect 后 fetch 工具并交 registry
   * 分发。所有失败汇入 generationDown；成功则武装 onclose 驱动的断线路径。永不 reject。
   */
  async function connectGeneration(): Promise<void> {
    const generation = new Client(
      { name: "dsh-workspace-mcp", version: "0.1.0" },
      { capabilities: {} }
    );
    const transport = createTransport(cfg);
    let resolveClose!: () => void;
    const closed = new Promise<void>((r) => { resolveClose = r; });
    let attemptSettled = false;
    let closeObserved = false;
    const hasClosed = () => closeObserved;
    client = generation;
    clientClosed = closed;
    currentTransport = transport;
    generation.onclose = () => {
      closeObserved = true;
      resolveClose();
      if (attemptSettled) generationDown(generation);
    };
    generation.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (!isCurrent(generation)) return;
      log(`${label}: 工具列表变化，重新拉取`);
      try {
        const tools = await fetchTools(generation, serverName);
        if (!isCurrent(generation)) return;
        currentTools = tools;
        hooks.onFetched();
      } catch (e: any) {
        if (disposed) return;
        // 重拉取失败与工具调用同源：命中重启类分类（会话失效 / server 不可达）
        // 即主动换代（无调用方可等待，重拉由新代的 onFetched 天然重做）
        const kind = classifyRestartRecovery(e);
        if (kind !== undefined) forceReconnect(generation, kind);
        else log(`${label}: 工具重拉取失败: ${e?.message ?? e}`);
      }
    });
    try {
      await generation.connect(transport);
      if (hasClosed()) {
        attemptSettled = true;
        generationDown(generation);
        return;
      }
      // 握手结果里的 server instructions（官方对齐：connect 成功后立即取，
      // 包装成 `### MCP server: <名>`；空声明 → 空串；超上限按本连接失败处理）。
      const instructionsText = generation.getInstructions()?.trimEnd() ?? "";
      const instructions =
        instructionsText ? `### MCP server: ${serverName}\n\n${instructionsText}` : "";
      const maxInstructionBytes = cfg.maxInstructionBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES;
      if (Buffer.byteLength(instructions, "utf8") > maxInstructionBytes) {
        throw new Error(
          `${label}: server instructions 超过 maxInstructionBytes（${maxInstructionBytes}，${Buffer.byteLength(instructions, "utf8")} 字节）`
        );
      }
      const tools = await fetchTools(generation, serverName);
      if (!isCurrent(generation)) return;
      currentTools = tools;
      serverInstructions = instructions;
      hooks.onFetched();
    } catch (e: any) {
      if (firstAttemptError === undefined) firstAttemptError = e;
      if (isCurrent(generation)) log(`${label}: 连接尝试失败: ${e?.message ?? e}`);
      // 树杀兜底先行：重试风暴下每个失败尝试都可能孤儿化一条解析中（不读 stdin）
      // 的多层链；taskkill /T /F 覆盖 SDK close 够不着的后代。进程已死则空转无害。
      const attemptPid = pidOf(transport);
      if (attemptPid !== undefined) killTree(attemptPid);
      try { await generation.close(); } catch { /* 忽略 */ }
      const quiesced = hasClosed() || (await waitForClose(closed));
      attemptSettled = true;
      if (!isCurrent(generation)) return;
      if (!quiesced) {
        client = undefined;
        clientClosed = undefined;
        currentTools = undefined;
        log(`${label}: 失败一代未在 ${GENERATION_CLOSE_TIMEOUT_MS}ms 内关闭——为避免 server 进程重叠，停止重连；改配置文件或重启可重试`);
        settleGenerationWaiters(undefined, new Error(`${label}: 失败一代未确认关闭，停止重连`));
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
      log(`${label}: 重连成功，工具已重新分发（第 ${failedAttempts}/${policy.maxAttempts} 次尝试）`);
    }
    // 新代已连接且工具已拉取：唤醒全部恢复等待者（ADR-0009）
    settleGenerationWaiters(generation);
  }

  let settling = connectGeneration();
  const firstSettling = settling;
  return {
    serverName,
    ready: firstSettling.then(() => {
      if (client !== undefined) return {};
      return { error: firstAttemptError ?? new Error(`${label}: 初始连接失败`) };
    }),
    getCurrentClient: () => client,
    getCurrentTools: () => currentTools,
    getInstructions: () => serverInstructions,
    invokeWithRecovery,
    async dispose() {
      disposed = true;
      settleGenerationWaiters(undefined, new Error(`${label}: 连接已销毁`));
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const current = client;
      const currentClosed = clientClosed;
      const currentGenTransport = currentTransport;
      client = undefined;
      clientClosed = undefined;
      currentTransport = undefined;
      currentTools = undefined;
      if (current !== undefined) {
        // 树杀兜底先行：EOF 软回收只对「健康且在读 stdin」的链有效，解析中途/
        // 正忙/不读 stdin 的形态（ADR-0007）靠 taskkill /T /F 立即整树覆盖；
        // 进程死后 close() 只做协议与流清理（closePromise 立即 resolve）。
        const pid = pidOf(currentGenTransport);
        if (pid !== undefined) killTree(pid);
        try { await current.close(); } catch { /* 忽略 */ }
        if (currentClosed !== undefined && !(await waitForClose(currentClosed))) {
          log(`${label}: dispose 时一代连接未在 ${GENERATION_CLOSE_TIMEOUT_MS}ms 内关闭，server 关闭可能不完整`);
        }
      }
      await settling;
    },
  };
}
