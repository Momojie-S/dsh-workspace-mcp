/**
 * 断线重连 smoke 测试：不经 DSH host，直接驱动 lib/mcp.js 的 supervisor。
 *
 * 场景链:
 *   1. 初始连接 → 3 个工具注册
 *   2. echo 调用正常
 *   3. 调 die 杀掉 server 子进程 → supervisor 应自动重连（新进程）→ echo 恢复
 *   4. 调 addtool → toolListChanged 通知 → 客户端重同步出第 4 个工具
 *   5. dispose → 全部工具卸载
 *
 * 运行: node test/reconnect-smoke.mjs（需先 npm run build）
 */

import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { startSupervisedConnection } from "../lib/mcp.js";

const serverScript = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

// ---- mock agent 上下域: tools.register 记录定义，disposer 删除 ----
const registered = new Map();
const agentCtx = {
  tools: {
    register(def) {
      registered.set(def.name, def);
      return () => registered.delete(def.name);
    },
  },
};

const log = (msg) => console.error(`[smoke] ${msg}`);

const sup = startSupervisedConnection(
  agentCtx,
  "smoke",
  {
    transport: "stdio",
    command: process.execPath,
    args: [serverScript],
    toolCallTimeoutMs: 5000,
  },
  // 小延迟加速测试；maxAttempts 覆盖 die 后的单次断线
  { enabled: true, initialDelayMs: 100, maxDelayMs: 400, maxAttempts: 8 },
  log
);

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function callEcho(text) {
  const def = registered.get("mcp__smoke__echo");
  if (!def) throw new Error("echo 未注册");
  const result = await def.execute({ text }, {});
  return result.content[0].text;
}

async function pollUntil(fn, { timeoutMs, intervalMs = 150, what }) {
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

// ---- 1. 初始连接 ----
const ready = await sup.ready;
if (ready.error) fail(`初始连接失败: ${ready.error?.message ?? ready.error}`);
if (registered.size !== 3) fail(`初始应注册 3 个工具，实际 ${registered.size}`);
log(`步骤1 OK: 初始连接 + ${registered.size} 个工具`);

// ---- 2. echo 正常 ----
{
  const text = await callEcho("hi");
  if (text !== "echo: hi") fail(`echo 返回异常: ${text}`);
  log("步骤2 OK: echo 调用正常");
}

// ---- 3. die → 自动重连 ----
{
  const def = registered.get("mcp__smoke__die");
  await def.execute({}, {});
  await sleep(600); // 等 50ms 退出 + onclose + 首次退避 100ms
  const text = await pollUntil(() => callEcho("after-reconnect"), {
    timeoutMs: 20000,
    what: "重连后 echo 恢复",
  });
  if (text !== "echo: after-reconnect") fail(`重连后 echo 返回异常: ${text}`);
  if (registered.size !== 3) fail(`重连后应保持 3 个工具，实际 ${registered.size}`);
  log("步骤3 OK: server 进程被杀后自动重连，工具恢复");
}

// ---- 4. addtool → 通知重同步 ----
{
  const def = registered.get("mcp__smoke__addtool");
  const result = await def.execute({}, {});
  if (result.content[0].text !== "added extra-1") fail(`addtool 返回异常: ${result.content[0].text}`);
  await pollUntil(() => (registered.size === 4 ? true : undefined), {
    timeoutMs: 10000,
    what: "toolListChanged 重同步出第 4 个工具",
  });
  if (!registered.has("mcp__smoke__extra-1")) fail("mcp__smoke__extra-1 未注册");
  log("步骤4 OK: 工具列表变化通知触发重同步");
}

// ---- 5. dispose ----
await sup.dispose();
if (registered.size !== 0) fail(`dispose 后应无注册工具，实际 ${registered.size}`);
log("步骤5 OK: dispose 卸载全部工具");

console.log("PASS: 断线重连 / 工具重同步 / dispose 全链路通过");
process.exit(0);
