/**
 * 方案C §6.9 given-up 重建 smoke：
 *   - server 文件不存在 → 预算耗尽 → given-up（订阅者工具清空、订阅者保留）
 *   - server 文件补上 + 新 agent 订阅 → 重开预算重建 → 连接成功
 *   - 旧订阅者随共享重建一并恢复工具（given-up 增量的本尊断言）
 *
 * 运行: node test/shared-giveup-retry.mjs（需先 npm run build）
 */

import { rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  counterServer,
  expect,
  makeAgentCtx,
  makeRegistry,
  makeTempWorkspace,
  pidVia,
  pollUntil,
  sleep,
  writeYml,
} from "./shared-helpers.mjs";

const log = (msg) => console.error(`[giveup-retry] ${msg}`);

const ws = await makeTempWorkspace("giveup-retry");
const lateServerPath = fileURLToPath(new URL("./fixtures/late-server.mjs", import.meta.url));
// 清掉历史运行残留（上轮写入的 fixture 会让 server 变得可启动，given-up 不复现）
await rm(lateServerPath, { force: true });
const registry = makeRegistry({ idleDropMs: 60_000, maxAttempts: 3 });

try {
  // command 指向尚不存在的文件 → 每次尝试必失败
  await writeYml(
    ws.ymlPath,
    `  alpha:\n    transport: stdio\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(lateServerPath)}]\n`
  );
  const a = makeAgentCtx();
  registry.registerAgentPresence("agent-a", ws.cwd, a.ctx);
  await registry.ensureAgentServers("agent-a", ws.cwd, a.ctx);

  // 等预算耗尽（3 次 × 50/150/150ms + 余量）
  await pollUntil(
    () => (registry.logs.some((m) => m.includes("预算耗尽")) ? true : undefined),
    { timeoutMs: 10000, what: "预算耗尽（given-up）" }
  );
  const key = registry.connectionKeys()[0];
  expect(registry.connectionInfo(key)?.givenUp === true, `连接应处于 given-up`);
  await registry.whenSettled();
  expect(a.registered.size === 0, `given-up 后 A 的工具应清空，实际 ${a.registered.size}`);
  // 订阅者条目保留（重建后随共享恢复）
  expect(registry.connectionInfo(key)?.refs === 1, `given-up 后订阅者应保留（refs=1）`);
  log("步骤1 OK: 预算耗尽 → given-up，A 工具清空但订阅者保留");

  // server 文件补上 + 新 agent B 订阅 → 重开预算重建
  await writeFile(
    lateServerPath,
    [
      `import { Server } from "@modelcontextprotocol/sdk/server/index.js";`,
      `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";`,
      `import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";`,
      `const server = new Server({ name: "late-smoke", version: "0.0.1" }, { capabilities: { tools: {} } });`,
      `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [`,
      `  { name: "pid", description: "pid", inputSchema: { type: "object", properties: {} } },`,
      `]}));`,
      `server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: String(process.pid) }] }));`,
      `await server.connect(new StdioServerTransport());`,
    ].join("\n")
  );
  const b = makeAgentCtx();
  registry.registerAgentPresence("agent-b", ws.cwd, b.ctx);
  await registry.ensureAgentServers("agent-b", ws.cwd, b.ctx); // 新订阅 → 重开预算

  // 重建成功后，A（旧订阅者）与 B 都恢复/获得工具
  await pollUntil(
    () => (a.registered.size === 1 && b.registered.size === 1 ? true : undefined),
    { timeoutMs: 15000, what: "重建后 A、B 都拿到工具（旧订阅者随共享恢复）" }
  );
  const pa = await pidVia(a.registered, "alpha");
  const pb = await pidVia(b.registered, "alpha");
  expect(pa === pb, `重建后 A、B 应共享同一新进程`);
  expect(!registry.connectionInfo(key)?.givenUp, `重建后 givenUp 应解除`);
  log(`步骤2 OK: 新订阅重开预算 → 重建成功，A、B 共享 #${pa}`);

  console.log("PASS: given-up 保留订阅者 + 新订阅重开预算 + 旧订阅者恢复 全部通过");
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
} finally {
  await registry.disposeAll();
  await ws.cleanup();
}
