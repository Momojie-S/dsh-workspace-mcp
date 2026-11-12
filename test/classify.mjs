/**
 * 错误分类器单元测试（ADR-0009）：classifyRestartRecovery 只把「可证明未
 * 触达工具执行」的失败归类为可恢复（session-lost / server-unreachable），
 * 其余一律 undefined（原样上抛，不重试）。
 *
 * 覆盖：新 SDK 形态（.status=HTTP 状态）、老 SDK 形态（.code=HTTP 状态 /
 * JSON-RPC code）、cause 链 + AggregateError.errors 网络码、不重试类
 * （ECONNRESET/超时/abort/504/500）、cause 环防死循环。
 *
 * 运行: node test/classify.mjs（需先 npm run build）
 */

import { classifyRestartRecovery, isSessionLossError } from "../lib/diagnostic.js";

/** 新 SDK SdkHttpError 鸭子形态。 */
const httpErr = (status, text) =>
  Object.assign(new Error(`Error POSTing to endpoint: ${text}`), { status });
/** 老 SDK StreamableHTTPError 鸭子形态（code 即 HTTP 状态）。 */
const legacyHttpErr = (status, text) =>
  Object.assign(new Error(`Error POSTing to endpoint: ${text}`), { code: status });
/** JSON-RPC 错误鸭子形态（McpError / ProtocolError，code 为负）。 */
const jsonRpcErr = (code, text) => Object.assign(new Error(text), { code });
/** undici 聚合网络失败形态：TypeError: fetch failed → AggregateError → 内层 syscall。 */
const aggregateNet = (code) => {
  const inner = new Error(`connect ${code} 127.0.0.1:3927`);
  inner.code = code;
  const agg = new AggregateError([inner], code);
  const outer = new TypeError("fetch failed", { cause: agg });
  return outer;
};
const netErr = (code) => {
  const e = new Error(`connect ${code} 127.0.0.1:3927`);
  e.code = code;
  return e;
};

const cases = [
  // ---- session-lost：重启后的 server 在入口拒绝旧 session ----
  ["http 404 + session-not-found 文案 (status 形态)", httpErr(404, "Session not found"), "session-lost"],
  ["http 404 其他文案 (status 形态)", httpErr(404, "Not Found"), "session-lost"],
  ["http 404 (老 SDK code 形态)", legacyHttpErr(404, "Session not found"), "session-lost"],
  ["jsonrpc -32001", jsonRpcErr(-32001, "Session not found"), "session-lost"],
  [
    "真实样本: HTTP 404 body 带 -32600 Session not found（靠文案命中）",
    Object.assign(
      new Error(
        'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","id":"server-error","error":{"code":-32600,"message":"Session not found"}}'
      ),
      { code: 404 }
    ),
    "session-lost",
  ],
  [
    "真实样本: 同上但无 code 属性（纯文案）",
    new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","id":"server-error","error":{"code":-32600,"message":"Session not found"}}'
    ),
    "session-lost",
  ],
  ["包装过的 session not found 文案", new Error("tool call failed: Error POSTing to endpoint: Session not found"), "session-lost"],
  ["FastMCP session has expired 文案", new Error("Error POSTing to endpoint: Session has expired"), "session-lost"],
  ["invalid or expired session 文案", new Error("Error: Invalid or expired session"), "session-lost"],
  ["cause 链深层的 404", new Error("outer", { cause: httpErr(404, "Not Found") }), "session-lost"],

  // ---- server-unreachable：网关无上游 / TCP 没建立 ----
  ["http 502 (status 形态)", httpErr(502, "Bad Gateway"), "server-unreachable"],
  ["http 503 (status 形态)", httpErr(503, "Service Unavailable"), "server-unreachable"],
  ["http 503 (老 SDK code 形态)", legacyHttpErr(503, "Service Unavailable"), "server-unreachable"],
  ["fetch failed + AggregateError ECONNREFUSED", aggregateNet("ECONNREFUSED"), "server-unreachable"],
  ["fetch failed + AggregateError ENOTFOUND", aggregateNet("ENOTFOUND"), "server-unreachable"],
  ["fetch failed + AggregateError EAI_AGAIN", aggregateNet("EAI_AGAIN"), "server-unreachable"],
  ["直接 ECONNREFUSED", netErr("ECONNREFUSED"), "server-unreachable"],

  // ---- 不重试：请求可能已到达垂死的 server，重放有重复执行风险 ----
  ["http 504 (status 形态)", httpErr(504, "Gateway Timeout"), undefined],
  ["http 500 (status 形态)", httpErr(500, "Internal Server Error"), undefined],
  ["http 500 (老 SDK code 形态)", legacyHttpErr(500, "boom"), undefined],
  ["jsonrpc -32602 业务错误", jsonRpcErr(-32602, "Invalid params"), undefined],
  [
    "老 SDK 超时: McpError(-32001, Request timed out) 撞码排除",
    jsonRpcErr(-32001, "Request timed out"),
    undefined,
  ],
  ["老 SDK 超时: Maximum total timeout exceeded", jsonRpcErr(-32001, "Maximum total timeout exceeded"), undefined],
  [
    "真实样本: server 侧 unknown tool（JSON-RPC 错误形态）",
    jsonRpcErr(-32602, 'Unknown tool: list_operations'),
    undefined,
  ],
  [
    "真实样本: 工具结果 isError 形态的 unknown tool（不走分类器，防御确认）",
    new Error('unknown tool "mcp__sr_od__list_operations"'),
    undefined,
  ],
  ["fetch failed + AggregateError ECONNRESET", aggregateNet("ECONNRESET"), undefined],
  ["直接 ECONNRESET", netErr("ECONNRESET"), undefined],
  ["abort", new Error("This operation was aborted"), undefined],
  ["超时错误", new Error("Request timed out"), undefined],
  ["普通业务错误", new Error("boom"), undefined],
  ["非错误输入 null", null, undefined],
  ["非错误输入字符串", "Session not found", undefined],
];

// cause 环：A → B → A，深度上限必须终止
{
  const a = new Error("a");
  const b = new Error("b", { cause: a });
  a.cause = b;
  cases.push(["cause 环不死循环", a, undefined]);
}

let failed = 0;
for (const [name, error, expected] of cases) {
  const got = classifyRestartRecovery(error);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got ${got ?? "undefined"}${ok ? "" : ` expected ${expected ?? "undefined"}`}`);
}

// isSessionLossError 与分类器一致
const sl = isSessionLossError(httpErr(404, "x")) && !isSessionLossError(httpErr(502, "x")) && !isSessionLossError(new Error("boom"));
console.log(`${sl ? "PASS" : "FAIL"}  isSessionLossError 与分类器一致`);
if (!sl) failed++;

console.log(failed === 0 ? "ALL PASS" : `${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
