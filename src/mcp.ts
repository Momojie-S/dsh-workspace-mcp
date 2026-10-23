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
 *   - 会话失效主动判定（ADR-0005）：streamable-http 的 server 重启/会话驱逐只表现为
 *     请求错误（HTTP 404 / "Session not found"），transport 不 close、onclose 永不
 *     触发；在工具调用与重拉取失败路径上识别此类错误，主动换代重连
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
import { killTree } from "./tree-kill.js";

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
  /** 会话失效上报（execute 路径识别出 Session not found 类错误时调用）。 */
  reportSessionLoss(generation: Client): void;
  /** 停止监督：树杀兜底 + 断开当前连接、清重连计时器。幂等、不抛。 */
  dispose(): Promise<void>;
}

/**
 * 为一个工具构造订阅者作用域的注册定义（execute 绑定所属代的 client）。
 * 方案C：registry 对每个订阅者重新调用本函数实例化（不跨订阅者共享定义对象
 * ——register 纯度未证实，防挂元数据互相污染）。
 */
export function buildToolDefinition(
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
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** 本次断线周期内连续失败的尝试次数。 */
  let failedAttempts = 0;
  /** 当前代完成 connect + 首次 fetch 的时刻；断线期间为 undefined。 */
  let connectedAt: number | undefined;
  /** 首次尝试的真实错误，供 ready 诊断。 */
  let firstAttemptError: unknown;

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
   * 会话失效上报：execute / 重拉取在已建立的一代上识别出 "Session not found"
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
        ? "连接断开且重连已禁用——工具调用将持续失败，改配置文件或重启可恢复"
        : "连接失败且重连已禁用——无可用工具，改配置文件或重启可重试";
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
      currentTools = undefined;
      hooks.onGivenUp();
      log(`${label}: 连续 ${policy.maxAttempts} 次重连失败，放弃——已卸载订阅者的工具（订阅者保留）；新订阅或配置重载将重开预算`);
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
        if (isSessionLossError(e)) reportSessionLoss(generation);
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
      const tools = await fetchTools(generation, serverName);
      if (!isCurrent(generation)) return;
      currentTools = tools;
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
    reportSessionLoss,
    async dispose() {
      disposed = true;
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
