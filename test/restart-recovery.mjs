/**
 * 调用内重启自愈测试（ADR-0009）：不经 DSH host，直接驱动 lib/registry.js。
 *
 * 覆盖 session-loss.mjs（404 会话失效）之外的恢复面：
 *   1. 重启窗口中调用（TCP 拨号 ECONNREFUSED）→ server 在等待预算内拉起
 *      → 调用内自动恢复，调用方无感知
 *   2. 窗口超过等待预算（重连放弃）→ 上抛原始调用错误（ECONNREFUSED）
 *   3. 挂起不响应的 server（超时类，请求可能已到达）→ 不重试，原样上抛
 *   4. 并发调用撞同一重启 → 共享一次重建（initialize 恰好 +1），各自成功
 *
 * 运行: node test/restart-recovery.mjs（需先 npm run build）
 */

import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WorkspaceMcpRegistry } from "../lib/registry.js";

// ---- 可关停的测试 server：tools/call 支持 hang-once 模式 ----
function makeTestServer() {
  const state = {
    sessions: new Set(),
    initializeCount: 0,
    /** hang-once：下一次 tools/call 挂起不响应（超时类失败），随后复位。 */
    mode: "normal",
    /** 已处理的 tools/call 次数（hang 的那次不计入）。 */
    callCount: 0,
  };
  const SESSION_NOT_FOUND_BODY = JSON.stringify({
    jsonrpc: "2.0",
    id: "server-error",
    error: { code: -32600, message: "Session not found" },
  });
  const server = createServer((req, res) => {
    if (req.method === "GET" || req.method === "DELETE") {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const sessionId = req.headers["mcp-session-id"];
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
              serverInfo: { name: "restart-recovery-test", version: "0.0.1" },
            },
          })
        );
        return;
      }
      if (body.id === undefined || body.id === null) {
        res.writeHead(202).end();
        return;
      }
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
                  inputSchema: { type: "object", properties: { text: { type: "string" } } },
                },
              ],
            },
          })
        );
        return;
      }
      if (body.method === "tools/call") {
        if (state.mode === "hang-once") {
          state.mode = "normal";
          return; // 不响应：让客户端超时（请求可能已到达 → 不可重试类）
        }
        state.callCount += 1;
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
  return { server, state };
}

const { server: httpServer, state } = makeTestServer();
const listen = (port = 0) => new Promise((r) => httpServer.listen(port, "127.0.0.1", r));
await listen();
const port = httpServer.address().port;
const url = `http://127.0.0.1:${port}/mcp`;

// ---- mock agent 上下文 ----
const registered = new Map();
const agentCtx = {
  tools: {
    register(def) {
      registered.set(def.name, def);
      return () => registered.delete(def.name);
    },
  },
};

const log = (msg) => console.error(`[restart-recovery] ${msg}`);

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

const mkRegistry = (reconnect) =>
  new WorkspaceMcpRegistry({
    configFile: ".dsh/mcp.servers.yml",
    log,
    reloadDebounceMs: 500,
    idleDropMs: 60_000,
    reconnect,
  });

// ---- registry A：正常退避（场景 1/3/4） ----
const base = await mkdtemp(join(tmpdir(), "ws-mcp-restartrec-"));
const cwd = join(base, "ws");
await mkdir(join(cwd, ".dsh"), { recursive: true });
const registryA = mkRegistry({ enabled: true, initialDelayMs: 100, maxDelayMs: 400, maxAttempts: 8 });

registryA.registerAgentPresence("agent-1", cwd, agentCtx);
await registryA.ensureAgentServersInline("agent-1", cwd, agentCtx, {
  http: { transport: "streamable-http", url, toolCallTimeoutMs: 5000 },
});
await registryA.readyOf(
  (await import("../lib/registry.js")).connKeyOf(resolve(cwd, ".dsh/mcp.servers.yml"), "http")
);

const cleanupA = async () => {
  await registryA.disposeAll().catch(() => {});
  httpServer.closeAllConnections?.();
  httpServer.close();
  await rm(base, { recursive: true, force: true }).catch(() => {});
};

// ---- 1. 重启窗口中调用：ECONNREFUSED → 窗口内 server 拉起 → 调用内恢复 ----
{
  // 确认基线
  if ((await callEcho("warm")) !== "echo: warm") {
    await cleanupA();
    fail("基线调用失败");
  }
  const initsBefore = state.initializeCount;
  // 关停 server（断开全部连接，模拟进程死亡）
  httpServer.closeAllConnections?.();
  await new Promise((r) => httpServer.close(r));
  // 等 undici 连接池感知并驱逐死连接：复用被 RST 的连接得到的是 ECONNRESET
  // （刻意不重试类）；真实重启后进程死亡、池驱逐完毕，新调用走新拨号 →
  // ECONNREFUSED（server-unreachable，恢复类）
  await sleep(150);
  const t0 = Date.now();
  // 在重启窗口中发起调用（ECONNREFUSED），300ms 后把 server 拉起
  const callP = callEcho("window");
  const reviveP = sleep(300).then(() => listen(port));
  const text = await callP;
  await reviveP;
  const elapsed = Date.now() - t0;
  if (text !== "echo: window") {
    await cleanupA();
    fail(`重启窗口调用应自动恢复，实际返回: ${text}`);
  }
  if (state.initializeCount !== initsBefore + 1) {
    await cleanupA();
    fail(`恢复应恰好重建一次连接（+1 initialize），实际 ${state.initializeCount - initsBefore} 次`);
  }
  log(`步骤1 OK: ECONNREFUSED 窗口 → 调用内恢复成功（${elapsed}ms，重建 1 次）`);
}

// ---- 2. 窗口超过预算：重连放弃 → 上抛原始错误 ----
{
  // 独立 registered/agentCtx：与 registryA 的同名注册互不覆盖
  const registeredB = new Map();
  const agentCtxB = {
    tools: {
      register(def) {
        registeredB.set(def.name, def);
        return () => registeredB.delete(def.name);
      },
    },
  };
  /** 展开整条错误链（含 AggregateError.errors）为文本。 */
  const chainText = (e) => {
    let out = String(e?.message ?? e);
    let c = e?.cause;
    for (let i = 0; c && i < 8; i++) {
      out += ` ${c?.message ?? ""} ${
        Array.isArray(c?.errors) ? c.errors.map((x) => x?.message ?? x).join(" ") : ""
      }`;
      c = c?.cause;
    }
    return out;
  };
  const { server: httpServerB } = makeTestServer();
  await new Promise((r) => httpServerB.listen(0, "127.0.0.1", r));
  const urlB = `http://127.0.0.1:${httpServerB.address().port}/mcp`;
  const registryB = mkRegistry({ enabled: true, initialDelayMs: 300, maxDelayMs: 600, maxAttempts: 2 });
  const baseB = await mkdtemp(join(tmpdir(), "ws-mcp-restartrec-b-"));
  const cwdB = join(baseB, "ws");
  await mkdir(join(cwdB, ".dsh"), { recursive: true });
  registryB.registerAgentPresence("agent-b", cwdB, agentCtxB);
  await registryB.ensureAgentServersInline("agent-b", cwdB, agentCtxB, {
    http: { transport: "streamable-http", url: urlB, toolCallTimeoutMs: 1200 },
  });
  const { connKeyOf } = await import("../lib/registry.js");
  const readyB = await registryB.readyOf(connKeyOf(resolve(cwdB, ".dsh/mcp.servers.yml"), "http"));
  if (!readyB || readyB.error) {
    fail(`registryB 初始连接失败: ${readyB?.error?.message ?? ""}`);
  }
  const echoB = registeredB.get("mcp__http__echo");
  if (!echoB || (await echoB.execute({ text: "b0" }, {})).content[0].text !== "echo: b0") {
    fail("registryB 基线调用失败");
  }
  // 关停且不再拉起：调用应最终以原始 ECONNREFUSED 错误失败（预算 1.2s 内）
  httpServerB.closeAllConnections?.();
  await new Promise((r) => httpServerB.close(r));
  await sleep(150); // 池驱逐死连接，让调用走新拨号（ECONNREFUSED 而非 ECONNRESET）
  const t0 = Date.now();
  let err;
  try {
    await echoB.execute({ text: "b1" }, {});
  } catch (e) {
    err = e;
  }
  const elapsed = Date.now() - t0;
  await registryB.disposeAll().catch(() => {});
  await rm(baseB, { recursive: true, force: true }).catch(() => {});
  if (!err || !/ECONNREFUSED/i.test(chainText(err))) {
    await cleanupA();
    fail(`预算耗尽应上抛原始 ECONNREFUSED 错误，实际: ${chainText(err) ?? "未抛错"}`);
  }
  if (elapsed > 5000) {
    await cleanupA();
    fail(`预算耗尽路径耗时 ${elapsed}ms，应被 min(1200ms, 30s) 预算限制`);
  }
  log(`步骤2 OK: 窗口超预算 → 重连放弃 → 原始错误上抛（${elapsed}ms）`);
}

// ---- 3. 挂起不响应（超时类）→ 不重试，原样上抛 ----
{
  const initsBefore = state.initializeCount;
  const callsBefore = state.callCount;
  state.mode = "hang-once";
  let err;
  const t0 = Date.now();
  try {
    // toolCallTimeoutMs=5000 太长，直接用短超时配置不可行（注册已固定）——
    // 挂起 5s 后 SDK 5000ms 超时；此处等满超时窗口
    await callEcho("hang");
  } catch (e) {
    err = e;
  }
  const elapsed = Date.now() - t0;
  if (!err) {
    await cleanupA();
    fail("挂起调用应以超时失败");
  }
  await sleep(700); // 超过首次退避，若误判断线此处必然已重新握手/重试
  if (state.callCount !== callsBefore) {
    await cleanupA();
    fail(`超时类失败不可重试（server 应只见 ${callsBefore} 次调用，实际 ${state.callCount}）`);
  }
  if (state.initializeCount !== initsBefore) {
    await cleanupA();
    fail(`超时类失败不应触发换代（initialize 应保持 ${initsBefore}，实际 ${state.initializeCount}）`);
  }
  log(`步骤3 OK: 挂起超时（${elapsed}ms）→ 原样上抛，无重试无换代`);
}

// ---- 4. 并发调用撞同一重启 → 共享一次重建 ----
{
  const initsBefore = state.initializeCount;
  state.sessions.clear(); // 模拟重启：全部会话作废
  const calls = await Promise.all([callEcho("c1"), callEcho("c2"), callEcho("c3")]);
  if (calls.join("|") !== "echo: c1|echo: c2|echo: c3") {
    await cleanupA();
    fail(`并发恢复结果异常: ${calls.join("|")}`);
  }
  if (state.initializeCount !== initsBefore + 1) {
    await cleanupA();
    fail(`并发调用应共享一次重建（恰好 +1 initialize），实际 +${state.initializeCount - initsBefore}`);
  }
  log("步骤4 OK: 并发 3 调用共享一次重建，全部成功");
}

// ---- 收尾 ----
await registryA.disposeAll();
if (registered.size !== 0) {
  fail(`dispose 后应无注册工具，实际 ${registered.size}`);
}
await cleanupA();
console.log("PASS: 重启自愈（ECONNREFUSED 窗口 / 预算耗尽 / 超时不重试 / 并发共享）全链路通过");
process.exit(0);
