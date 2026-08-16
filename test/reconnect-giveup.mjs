/**
 * 启动失败重试 + 预算耗尽放弃 的 smoke 测试。
 *
 * 场景: command 指向不存在的可执行文件 → 每次尝试必然失败 →
 *   supervisor 应按退避重试 maxAttempts 次后放弃，且不注册任何工具。
 *
 * 运行: node test/reconnect-giveup.mjs（需先 npm run build）
 */

import { startSupervisedConnection } from "../lib/mcp.js";

const registered = new Map();
const agentCtx = {
  tools: {
    register(def) {
      registered.set(def.name, def);
      return () => registered.delete(def.name);
    },
  },
};

const logs = [];
const log = (msg) => {
  logs.push(msg);
  console.error(`[smoke-giveup] ${msg}`);
};

const sup = startSupervisedConnection(
  agentCtx,
  "broken",
  {
    transport: "stdio",
    command: "definitely-not-a-real-command-xyz",
    args: [],
  },
  { enabled: true, initialDelayMs: 50, maxDelayMs: 100, maxAttempts: 3 },
  log
);

const ready = await sup.ready;
if (!ready.error) {
  console.error("FAIL: 连接一个不存在的命令不应成功");
  process.exit(1);
}
if (registered.size !== 0) {
  console.error(`FAIL: 失败期间不应注册工具，实际 ${registered.size}`);
  process.exit(1);
}

// 放弃判定：出现"放弃"日志（3 次尝试 × 退避 50/100/100ms，留足余量）
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  if (logs.some((m) => m.includes("放弃"))) break;
  await new Promise((r) => setTimeout(r, 200));
}
const retryLogs = logs.filter((m) => m.includes("重连（"));
if (retryLogs.length !== 3) {
  console.error(`FAIL: 应恰好重试 3 次，实际 ${retryLogs.length}: ${retryLogs.join(" | ")}`);
  process.exit(1);
}
if (!logs.some((m) => m.includes("放弃"))) {
  console.error("FAIL: 未出现放弃日志");
  process.exit(1);
}

await sup.dispose();
console.log("PASS: 启动失败重试 3 次后放弃，无工具注册");
process.exit(0);
