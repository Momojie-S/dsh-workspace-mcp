/**
 * 启动失败重试 + 预算耗尽放弃 的 smoke 测试（经 registry 入口）。
 *
 * 场景: command 指向不存在的可执行文件 → 每次尝试必然失败 →
 *   supervisor 应按退避重试 maxAttempts 次后放弃（given-up），且不注册任何工具。
 *
 * 运行: node test/reconnect-giveup.mjs（需先 npm run build）
 */

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceMcpRegistry, connKeyOf } from "../lib/registry.js";

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

const base = await mkdtemp(join(tmpdir(), "ws-mcp-giveup-"));
const cwd = join(base, "ws");
await mkdir(join(cwd, ".dsh"), { recursive: true });
const registry = new WorkspaceMcpRegistry({
  configFile: ".dsh/mcp.servers.yml",
  log,
  reloadDebounceMs: 500,
  idleDropMs: 60_000,
  reconnect: { enabled: true, initialDelayMs: 50, maxDelayMs: 100, maxAttempts: 3 },
});
const key = connKeyOf(resolve(cwd, ".dsh/mcp.servers.yml"), "broken");

try {
  registry.registerAgentPresence("agent-1", cwd, agentCtx);
  await registry.ensureAgentServersInline("agent-1", cwd, agentCtx, {
    broken: { transport: "stdio", command: "definitely-not-a-real-command-xyz", args: [] },
  });

  const ready = await registry.readyOf(key);
  if (!ready || !ready.error) {
    throw new Error("FAIL: 连接一个不存在的命令不应成功");
  }
  if (registered.size !== 0) {
    throw new Error(`FAIL: 失败期间不应注册工具，实际 ${registered.size}`);
  }

  // 放弃判定：出现"放弃"日志（3 次尝试 × 退避 50/100/100ms，留足余量）
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (logs.some((m) => m.includes("放弃"))) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const retryLogs = logs.filter((m) => m.includes("重连（"));
  if (retryLogs.length !== 3) {
    throw new Error(`FAIL: 应恰好重试 3 次，实际 ${retryLogs.length}: ${retryLogs.join(" | ")}`);
  }
  if (!logs.some((m) => m.includes("放弃"))) {
    throw new Error("FAIL: 未出现放弃日志");
  }
  const info = registry.connectionInfo(key);
  if (!info?.givenUp) {
    throw new Error("FAIL: 连接应处于 given-up 状态");
  }

  console.log("PASS: 启动失败重试 3 次后放弃（given-up），无工具注册");
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
} finally {
  await registry.disposeAll().catch(() => {});
  await rm(base, { recursive: true, force: true }).catch(() => {});
}
