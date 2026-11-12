/**
 * 调用期失败的「重启自愈」错误分类（ADR-0009）。
 *
 * 原则：只把「可证明未到达工具执行」的失败归类为可恢复——重启后的 server
 * 在入口拒绝旧 session id（HTTP 404 / JSON-RPC -32001 / "Session not found"
 * 文案）、网关后无健康上游（502/503）、TCP 根本没建立（ECONNREFUSED /
 * ENOTFOUND / EAI_AGAIN）。这类失败重放调用不可能重复执行非幂等工具。
 * 刻意不归类：ECONNRESET、超时、abort、504 与其他 5xx——请求可能已到达
 * 垂死的 server，重放有重复执行风险，必须原样上抛。
 *
 * 形态兼容（鸭子类型判形，不 instanceof SDK 错误类——本插件依赖的
 * @modelcontextprotocol/sdk 与新版 @modelcontextprotocol/client 的错误类
 * 名不同，但携带的信息等价）：
 *   - HTTP 状态：新 SDK SdkHttpError.status / 老 SDK StreamableHTTPError.code
 *   - JSON-RPC code：新 SDK ProtocolError.code / 老 SDK McpError.code
 *   - 网络层：TypeError: fetch failed → cause（常为 AggregateError，其
 *     errors 数组内层携带 syscall code）——沿 cause 链与 errors 数组递归查找
 */

/** 可恢复失败的种类：会话失效 / server 不可达。 */
export type RestartRecoveryKind = "session-lost" | "server-unreachable";

/** JSON-RPC code：SDK 约定保留给失效的 streamable-http 会话。 */
const SESSION_NOT_FOUND_JSON_RPC_CODE = -32001;

/**
 * HTTP 状态白名单（请求可证明未触达任何工具执行）：404 = 重启后的 server
 * 在入口拒绝旧 session id；502/503 = 网关后面没有健康上游。刻意不含 504
 * 与网关超时——上游可能已收到并开始执行请求后才死。
 */
const ENTRY_REJECTED_HTTP_STATUSES: ReadonlySet<number> = new Set([404, 502, 503]);

/** syscall code 白名单（可证明没有 TCP 连接把请求送到 server）。 */
const UNREACHED_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/** cause 链遍历上限（undici 聚合与代理场景可嵌套超过一层）。 */
const CAUSE_CHAIN_LIMIT = 8;

/**
 * 会话失效文案特征：覆盖官方 SDK server（"Session not found"）、FastMCP 系
 * （"Session has expired"）及常见变体。沿用 ADR-0005 已接受的宽匹配——命中
 * 文案的错误都是 server 入口层对会话的拒绝，工具必然没有执行。
 */
const SESSION_LOSS_MESSAGE_PATTERN =
  /session not found|session (has )?expired|invalid or expired session|unknown session/i;

/**
 * 请求超时文案特征。老 SDK（@modelcontextprotocol/sdk 1.x）的本地超时错误
 * 是 McpError(-32001, "Request timed out")——与 server 会话失效的 -32001
 * 撞码（新 SDK @modelcontextprotocol/client 的超时错误类不同、不撞）。
 * 超时意味着请求可能已到达 server 并开始执行，属不可重试类，必须先行排除。
 */
const REQUEST_TIMEOUT_MESSAGE_PATTERN = /timed?\s*out|timeout|超时/i;

/**
 * 判定一个错误是否表明 server 侧会话已失效（server 重启 / 会话驱逐 / 重新部署）。
 * 等价于 classifyRestartRecovery(error) === 'session-lost'。
 */
export function isSessionLossError(error: unknown): boolean {
  return classifyRestartRecovery(error) === "session-lost";
}

function httpStatusKind(status: number): RestartRecoveryKind | undefined {
  if (status === 404) return "session-lost";
  if (ENTRY_REJECTED_HTTP_STATUSES.has(status)) return "server-unreachable";
  return undefined;
}

/**
 * 单节点分类：命中带明确 HTTP 状态语义的节点即出、不再下探 cause——
 * 一个已有 HTTP 结论的错误，其 cause 是同一响应的包装，下探只会引入误判。
 */
function classifyNode(node: unknown): RestartRecoveryKind | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const shape = node as { status?: unknown; code?: unknown; message?: unknown };
  if (typeof shape.status === "number") return httpStatusKind(shape.status);
  if (typeof shape.code === "number") {
    if (shape.code === SESSION_NOT_FOUND_JSON_RPC_CODE) {
      // 老 SDK 的本地请求超时同样用 -32001（ErrorCode.RequestTimeout）：
      // 超时 = 请求可能已到达并执行，不可重试；只有非超时文案的 -32001
      // 才是 server 的会话失效判定
      if (
        typeof shape.message === "string" &&
        REQUEST_TIMEOUT_MESSAGE_PATTERN.test(shape.message)
      ) {
        return undefined;
      }
      return "session-lost";
    }
    // 老 SDK 形态：StreamableHTTPError.code 即 HTTP 状态（正值 100-599；
    // JSON-RPC code 为负或 -32xxx 保留段，与此区间不相交）
    if (shape.code >= 100 && shape.code <= 599) return httpStatusKind(shape.code);
  }
  if (typeof shape.message === "string" && SESSION_LOSS_MESSAGE_PATTERN.test(shape.message)) {
    return "session-lost";
  }
  if (typeof shape.code === "string" && UNREACHED_NETWORK_CODES.has(shape.code)) {
    return "server-unreachable";
  }
  return undefined;
}

/**
 * 分类一个调用期失败：命中 session-lost / server-unreachable 之一表示
 * supervisor 可以安全地丢弃当前连接、重建并重试一次原调用；undefined 表示
 * 失败与重启无关（或无法证明未触达工具执行），必须原样上抛给调用方。
 *
 * 顶层节点先判；未命中则沿 cause 链（含 AggregateError.errors 数组的每个
 * 内层错误，递归）逐节点判，深度上限 CAUSE_CHAIN_LIMIT 防环。
 */
export function classifyRestartRecovery(error: unknown): RestartRecoveryKind | undefined {
  const top = classifyNode(error);
  if (top !== undefined) return top;
  let current: unknown = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; current !== undefined && current !== null && depth < CAUSE_CHAIN_LIMIT; depth++) {
    const kind = classifyNode(current);
    if (kind !== undefined) return kind;
    const inner = (current as { errors?: unknown }).errors;
    if (Array.isArray(inner)) {
      for (const item of inner) {
        const innerKind = classifyRestartRecovery(item);
        if (innerKind !== undefined) return innerKind;
      }
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}
