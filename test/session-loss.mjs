/**
 * 会话失效自动重连测试（ADR-0005）：不经 DSH host，直接驱动 lib/mcp.js。
 *
 * 背景：streamable-http 的 server 重启/会话驱逐后，旧 session id 作废，但
 * transport 不 close、onclose 永不触发——supervisor 必须靠 execute 路径上的
 * 会话失效识别（isSessionLossError）主动换代重连。
 *
 * 场景链:
 *   1. 初始连接（initialize #1）→ echo 工具注册
 *   2. echo 调用正常
 *   3. server 清空全部会话（模拟重启/空闲驱逐）→ echo 调用收到 404
 *      "Session not found"（复刻真实报文）→ 应自动重连（initialize #2）恢复
 *   4. 偶发 500 不触发换代（initialize 计数不变，同会话继续可用）
 *   5. dispose → 工具卸载
 *
 * 运行: node test/session-loss.mjs（需先 npm run build）
 */

import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { startSupervisedConnection } from "../lib/mcp.js";

// ---- 最小 streamable-http MCP server（无 GET SSE：一律 405，SDK 视为不支持） ----
const state = {
  sessions: new Set(),
  initializeCount: 0,
  /** "fail-once"：下一次 tools/call 回 500 后自动复位（瞬时错误，不应触发换代）。 */
  mode: "normal",
};

const SESSION_NOT_FOUND_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: "server-error",
  error: { code: -32600, message: "Session not found" },
});

const httpServer = createServer((req, res) => {
  if (req.method === "GET" || req.method === "DELETE") {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const sessionId = req.headers["mcp-session-id"];

    // initialize：发新会话
    if (body.method === "initialize") {
      const newId = `sess-${++state.initializeCount}`;
      state.sessions.add(newId);
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": newId });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: body.params?.protocolVersion ?? "2025-03-26",
            capabilities: {},
            serverInfo: { name: "session-loss-test", version: "0.0.1" },
          },
        })
      );
      return;
    }
    // 通知（无 id）：202
    if (body.id === undefined || body.id === null) {
      res.writeHead(202).end();
      return;
    }
    // 会话校验：未知会话 → 404 + 真实报文（本测试的被测对象）
    if (!sessionId || !state.sessions.has(sessionId)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(SESSION_NOT_FOUND_BODY);
      return;
    }
    if (body.method === "tools/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "echo",
                description: "echo back",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                },
              },
            ],
          },
        })
      );
      return;
    }
    if (body.method === "tools/call") {
      if (state.mode === "fail-once") {
        state.mode = "normal";
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "boom" } }));
        return;
      }
      const text = body.params?.arguments?.text ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: `echo: ${text}` }] },
        })
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(SESSION_NOT_FOUND_BODY);
  });
});

await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const port = httpServer.address().port;
const url = `http://127.0.0.1:${port}/mcp`;

// ---- mock agent 上下文: tools.register 记录定义，disposer 删除 ----
const registered = new Map();
const agentCtx = {
  tools: {
    register(def) {
      registered.set(def.name, def);
      return () => registered.delete(def.name);
    },
  },
};

const log = (msg) => console.error(`[session-loss] ${msg}`);

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function callEcho(text) {
  const def = registered.get("mcp__http__echo");
  if (!def) throw new Error("echo 未注册");
  const result = await def.execute({ text }, {});
  return result.content[0].text;
}

async function pollUntil(fn, { timeoutMs, intervalMs = 100, what }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastError = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`poll 超时（${what}）: ${lastError?.message ?? lastError ?? "条件未满足"}`);
}

const sup = startSupervisedConnection(
  agentCtx,
  "http",
  { transport: "streamable-http", url, toolCallTimeoutMs: 5000 },
  { enabled: true, initialDelayMs: 100, maxDelayMs: 400, maxAttempts: 8 },
  log
);

const cleanup = async () => {
  await sup.dispose().catch(() => {});
  httpServer.close();
};
process.on("exit", () => httpServer.close());

// ---- 1. 初始连接 ----
{
  const ready = await sup.ready;
  if (ready.error) {
    await cleanup();
    fail(`初始连接失败: ${ready.error?.message ?? ready.error}`);
  }
  if (registered.size !== 1) {
    await cleanup();
    fail(`初始应注册 1 个工具，实际 ${registered.size}`);
  }
  log(`步骤1 OK: 初始连接（initialize #${state.initializeCount}）+ 1 个工具`);
}

// ---- 2. echo 正常 ----
{
  const text = await callEcho("hi");
  if (text !== "echo: hi") {
    await cleanup();
    fail(`echo 返回异常: ${text}`);
  }
  if (state.initializeCount !== 1) {
    await cleanup();
    fail(`应只 initialize 1 次，实际 ${state.initializeCount}`);
  }
  log("步骤2 OK: echo 调用正常，无多余握手");
}

// ---- 3. server 清空会话 → "Session not found" → 自动换代重连 ----
{
  state.sessions.clear(); // 模拟 server 重启 / 会话空闲驱逐：旧 session id 全部作废
  let staleError;
  try {
    await callEcho("stale");
  } catch (e) {
    staleError = e;
  }
  if (!staleError || !/Session not found/.test(String(staleError.message))) {
    await cleanup();
    fail(`旧会话调用应以 Session not found 失败，实际: ${staleError?.message ?? staleError}`);
  }
  log("步骤3a OK: 旧会话调用收到 Session not found（本次失败上抛）");

  const text = await pollUntil(() => callEcho("after-reconnect"), {
    timeoutMs: 20000,
    what: "会话失效后自动重连恢复",
  });
  if (text !== "echo: after-reconnect") {
    await cleanup();
    fail(`重连后 echo 返回异常: ${text}`);
  }
  if (state.initializeCount !== 2) {
    await cleanup();
    fail(`会话失效应触发恰好一次重新握手（initialize #2），实际 #${state.initializeCount}`);
  }
  log("步骤3b OK: 会话失效自动判定断线 → 换代重连（initialize #2）→ 工具恢复");
}

// ---- 4. 偶发 500 不触发换代 ----
{
  state.mode = "fail-once";
  let err500;
  try {
    await callEcho("boom");
  } catch (e) {
    err500 = e;
  }
  if (!err500) {
    await cleanup();
    fail("fail-once 模式下调用应失败");
  }
  await sleep(700); // 超过首次退避延迟，若误判断线此处必然已重新握手
  if (state.initializeCount !== 2) {
    await cleanup();
    fail(`偶发 500 不应触发换代（应保持 initialize #2，实际 #${state.initializeCount}）`);
  }
  const text = await callEcho("same-session");
  if (text !== "echo: same-session") {
    await cleanup();
    fail(`500 之后同会话调用应正常: ${text}`);
  }
  log("步骤4 OK: 偶发 500 不拆会话、不重新握手");
}

// ---- 5. dispose ----
await sup.dispose();
if (registered.size !== 0) {
  fail(`dispose 后应无注册工具，实际 ${registered.size}`);
}
log("步骤5 OK: dispose 卸载全部工具");

await cleanup();
console.log("PASS: 会话失效识别 → 自动换代重连 / 偶发错误不误判 全链路通过");
process.exit(0);
