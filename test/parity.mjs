/**
 * 官方对齐（parity）测试（ADR-0006）：不经 DSH host，直接驱动 lib/mcp.js。
 *
 * 覆盖从官方 dsh-mcp-client 补齐移植的五个行为：
 *   A. 重复 public 名守卫：server 列出两个归一化后同名的工具 → 拒绝整代，0 注册
 *   B. 输出契约：outputSchema 受支持 → structuredContent 进契约且 required；
 *      未声明 → structuredContent 为 {} 且仅 content required
 *   C. taskSupport=required → execute 明确报错，不发起调用
 *   D. 注册冲突整代回滚：任一 register 抛错 → 本 server 0 个工具（无半代状态）
 *   E. stdio scrubbed 父环境继承：普通父变量可见 / DSH_* 剥离 /
 *      凭据形状名剥离但显式 env 覆盖可传
 *
 * 运行: node test/parity.mjs（需先 npm run build）
 */

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { startSupervisedConnection } from "../lib/mcp.js";

// ---- E 段准备：往测试进程（=supervisor 宿主）注入探针变量 ----
// （必须在子进程 spawn 之前：子进程 env 在 spawn 时定格）
process.env.PARITY_PARENT_VAR = "from-parent";
process.env.DSH_PARITY_LEAK = "leak";
process.env.PARITY_SECRET_TOKEN = "implicit-secret"; // 显式 env 覆盖成 explicit-pass
process.env.PARITY_IMPLICIT_KEY = "implicit-key";    // 仅存在于父进程的敏感名，不得泄漏

// ---- 最小 streamable-http MCP server：tools/list 内容按 state.toolset 切换 ----
const state = {
  sessions: new Set(),
  initializeCount: 0,
  /** "normal" | "duplicate" | "lossy" */
  toolset: "normal",
};

const STRUCTURED_SCHEMA = {
  type: "object",
  properties: { answer: { type: "number" } },
  required: ["answer"],
  additionalProperties: false,
};

function toolsetFor(mode) {
  if (mode === "duplicate") {
    // 同一 raw name 列两次：官方守卫抓的就是这种非法列表
    return {
      tools: [
        { name: "same", description: "first", inputSchema: { type: "object", properties: {} } },
        { name: "same", description: "second", inputSchema: { type: "object", properties: {} } },
      ],
    };
  }
  if (mode === "lossy") {
    // 归一化有损但 raw name 不同：身份哈希保证 publicName 不坍缩
    return {
      tools: [
        { name: "v.a", description: "dot variant", inputSchema: { type: "object", properties: {} } },
        { name: "v a", description: "space variant", inputSchema: { type: "object", properties: {} } },
      ],
    };
  }
  return {
    tools: [
      {
        name: "plain",
        description: "no outputSchema",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "structured",
        description: "with outputSchema",
        inputSchema: { type: "object", properties: {} },
        outputSchema: STRUCTURED_SCHEMA,
      },
      {
        name: "taskreq",
        description: "requires task-based execution",
        inputSchema: { type: "object", properties: {} },
        execution: { taskSupport: "required" },
      },
    ],
  };
}

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
            serverInfo: { name: "parity-test", version: "0.0.1" },
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
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id: "server-error", error: { code: -32600, message: "Session not found" } })
      );
      return;
    }
    if (body.method === "tools/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: toolsetFor(state.toolset) }));
      return;
    }
    if (body.method === "tools/call") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: `called ${body.params?.name}` }] },
        })
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32600, message: "Session not found" } }));
  });
});

await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${httpServer.address().port}/mcp`;

const log = (msg) => console.error(`[parity] ${msg}`);

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  try { httpServer.close(); } catch { /* 忽略 */ }
  process.exit(1);
}

function mockAgentCtx(registerImpl) {
  const registered = new Map();
  return {
    registered,
    ctx: {
      tools: {
        register(def) {
          if (registerImpl) registerImpl(def);
          registered.set(def.name, def);
          return () => registered.delete(def.name);
        },
      },
    },
  };
}

const fastPolicy = { enabled: true, initialDelayMs: 100, maxDelayMs: 400, maxAttempts: 3 };

// ---- A. 重复 raw name → 拒绝整代；归一化有损但不同名 → 哈希防坍缩 ----
{
  state.toolset = "duplicate";
  const { ctx, registered } = mockAgentCtx();
  const sup = startSupervisedConnection(
    ctx, "dup", { transport: "streamable-http", url }, fastPolicy, log
  );
  const ready = await sup.ready;
  if (!ready.error || !/归一化后同名|more than once/.test(String(ready.error.message))) {
    await sup.dispose();
    fail(`重复名应以归一化同名错误失败，实际: ${ready.error?.message ?? ready.error}`);
  }
  if (registered.size !== 0) {
    await sup.dispose();
    fail(`重复名场景应 0 注册，实际 ${registered.size}`);
  }
  await sup.dispose();
  log("A1 OK: server 重复列出同一 raw name → 拒绝整代，0 注册");

  // 归一化有损（非法字符）但 raw name 不同 → 身份哈希后缀防坍缩
  state.toolset = "lossy";
  const { ctx: ctx2, registered: registered2 } = mockAgentCtx();
  const sup2 = startSupervisedConnection(
    ctx2, "lossy", { transport: "streamable-http", url }, fastPolicy, log
  );
  const ready2 = await sup2.ready;
  if (ready2.error) {
    await sup2.dispose();
    fail(`lossy toolset 连接失败: ${ready2.error?.message}`);
  }
  const names = [...registered2.keys()];
  if (names.length !== 2 || names[0] === names[1]) {
    await sup2.dispose();
    fail(`两个有损名应各自注册且不坍缩，实际: ${names.join(", ")}`);
  }
  if (!names.every((n) => /^mcp__lossy__v_a_[0-9a-f]{12}$/.test(n))) {
    await sup2.dispose();
    fail(`有损名应带身份哈希后缀，实际: ${names.join(", ")}`);
  }
  await sup2.dispose();
  log("A2 OK: 归一化有损的不同 raw name → 哈希后缀防坍缩");
}

// ---- B/C. 输出契约 + taskSupport 守卫 ----
{
  state.toolset = "normal";
  const { ctx, registered } = mockAgentCtx();
  const sup = startSupervisedConnection(
    ctx, "meta", { transport: "streamable-http", url }, fastPolicy, log
  );
  const ready = await sup.ready;
  if (ready.error) {
    await sup.dispose();
    fail(`normal toolset 连接失败: ${ready.error?.message}`);
  }
  if (registered.size !== 3) {
    await sup.dispose();
    fail(`应注册 3 个工具，实际 ${registered.size}`);
  }

  const plain = registered.get("mcp__meta__plain");
  const structured = registered.get("mcp__meta__structured");
  if (!plain || !structured) {
    await sup.dispose();
    fail(`plain/structured 未注册: ${[...registered.keys()].join(", ")}`);
  }

  // B: 声明 outputSchema → structuredContent = schema，双 required，封死额外属性
  const so = structured.output.schema;
  if (JSON.stringify(so.properties.structuredContent) !== JSON.stringify(STRUCTURED_SCHEMA)) {
    await sup.dispose();
    fail(`structuredContent 应原样保留受支持 schema: ${JSON.stringify(so.properties.structuredContent)}`);
  }
  if (JSON.stringify(so.required) !== JSON.stringify(["content", "structuredContent"])) {
    await sup.dispose();
    fail(`structured 的 required 应为两项: ${JSON.stringify(so.required)}`);
  }
  if (so.additionalProperties !== false) {
    await sup.dispose();
    fail("additionalProperties 应为 false");
  }

  // B: 未声明 → structuredContent 空对象占位，仅 content required
  const po = plain.output.schema;
  if (JSON.stringify(po.properties.structuredContent) !== "{}" || JSON.stringify(po.required) !== JSON.stringify(["content"])) {
    await sup.dispose();
    fail(`plain 契约异常: ${JSON.stringify(po)}`);
  }

  // C: taskSupport=required → 明确错误
  let taskErr;
  try {
    await registered.get("mcp__meta__taskreq").execute({}, {});
  } catch (e) {
    taskErr = e;
  }
  if (!taskErr || !/requires task-based execution/.test(String(taskErr.message))) {
    await sup.dispose();
    fail(`taskreq 应明确报 requires task-based execution，实际: ${taskErr?.message}`);
  }

  // 对照：正常工具可调用
  const out = await plain.execute({}, {});
  if (out.content[0].text !== "called plain") {
    await sup.dispose();
    fail(`plain 调用异常: ${out.content[0].text}`);
  }
  await sup.dispose();
  log("B OK: outputSchema → structuredContent 契约（声明/未声明两路）");
  log("C OK: taskSupport=required 明确拒绝");
}

// ---- D. 注册冲突整代回滚 ----
{
  state.toolset = "normal";
  // "structured"（列表第 2 个）注册抛错；第 1 个 plain 已注册 → 必须被回滚
  const { ctx, registered } = mockAgentCtx((def) => {
    if (def.name === "mcp__meta__structured") throw new Error("namespace squatted");
  });
  const sup = startSupervisedConnection(
    ctx, "meta", { transport: "streamable-http", url }, fastPolicy, log
  );
  await sup.ready;
  if (registered.size !== 0) {
    await sup.dispose();
    fail(`注册冲突应整代回滚到 0，实际 ${registered.size}`);
  }
  await sup.dispose();
  log("D OK: 任一注册冲突 → 整代回滚，无半代状态");
}

// ---- E. stdio scrubbed 父环境继承 ----
{
  const { ctx, registered } = mockAgentCtx();
  const sup = startSupervisedConnection(
    ctx,
    "probe",
    {
      transport: "stdio",
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/env-probe-server.mjs", import.meta.url))],
      // 显式 env 覆盖 scrub：敏感名也允许显式传（merge 在 scrub 之后）
      env: { PARITY_SECRET_TOKEN: "explicit-pass" },
      toolCallTimeoutMs: 5000,
    },
    fastPolicy,
    log
  );
  const ready = await sup.ready;
  if (ready.error) {
    await sup.dispose();
    fail(`probe 连接失败: ${ready.error?.message}`);
  }
  const getenv = async (name) => {
    const r = await registered.get("mcp__probe__getenv").execute({ name }, {});
    return r.content[0].text;
  };

  const parentVar = await getenv("PARITY_PARENT_VAR");
  if (parentVar !== "from-parent") {
    await sup.dispose();
    fail(`普通父变量应继承，实际 "${parentVar}"`);
  }
  const dshLeak = await getenv("DSH_PARITY_LEAK");
  if (dshLeak !== "(unset)") {
    await sup.dispose();
    fail(`DSH_* 应被剥离，实际 "${dshLeak}"`);
  }
  const secret = await getenv("PARITY_SECRET_TOKEN");
  if (secret !== "explicit-pass") {
    await sup.dispose();
    fail(`敏感名应被 scrub 但显式 env 覆盖可传，实际 "${secret}"`);
  }
  // 未显式传的敏感名（隐式存在于父进程）不得泄漏
  const leak2 = await getenv("PARITY_IMPLICIT_KEY");
  if (leak2 !== "(unset)") {
    await sup.dispose();
    fail(`父进程隐式敏感名不得泄漏，实际 "${leak2}"`);
  }
  await sup.dispose();
  log("E OK: 父环境继承 + DSH_*/凭据形状名 scrub + 显式覆盖优先");
}

httpServer.close();
console.log("PASS: 官方对齐五项（重复名守卫/输出契约/taskSupport/整代回滚/scrubbed env）全链路通过");
process.exit(0);
