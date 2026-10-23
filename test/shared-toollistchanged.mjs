/**
 * 方案C §6.11 toolListChanged 多订阅者分发 smoke：server 热改工具列表 →
 * 每个订阅者的工具集同步更新（换代分发是共享化后的新交互面）。
 *
 * 运行: node test/shared-toollistchanged.mjs（需先 npm run build）
 */

import {
  connKeyOf,
  counterEntryYml,
  expect,
  makeAgentCtx,
  makeRegistry,
  makeTempWorkspace,
  pollUntil,
  writeYml,
} from "./shared-helpers.mjs";

const log = (msg) => console.error(`[toolchange] ${msg}`);

const ws = await makeTempWorkspace("toolchange");
const registry = makeRegistry({ idleDropMs: 60_000 });

try {
  await writeYml(ws.ymlPath, counterEntryYml("alpha"));
  const a = makeAgentCtx();
  const b = makeAgentCtx();
  const c = makeAgentCtx();
  for (const [id, m] of [
    ["agent-a", a],
    ["agent-b", b],
    ["agent-c", c],
  ]) {
    registry.registerAgentPresence(id, ws.cwd, m.ctx);
    await registry.ensureAgentServers(id, ws.cwd, m.ctx);
  }
  await registry.whenSettled();
  await registry.readyOf(connKeyOf(ws.ymlPath, "alpha")); // 等首次 fetch 完成
  await registry.whenSettled();
  for (const m of [a, b, c]) {
    expect(m.registered.size === 4, `初始应 4 工具/订阅者`);
  }

  // server 端热加工具 → toolListChanged → 三个订阅者全部同步
  await a.registered.get("mcp__alpha__addtool").execute({}, {});
  await pollUntil(
    () => (b.registered.size === 5 && c.registered.size === 5 ? true : undefined),
    { timeoutMs: 8000, what: "B、C 同步出新工具" }
  );
  expect(a.registered.size === 5, `发起者 A 也应有 5 个工具`);
  for (const m of [a, b, c]) {
    expect(m.registered.has("mcp__alpha__extra-1"), `extra-1 应在全部订阅者注册`);
  }
  log("OK: toolListChanged → 3 个订阅者全部同步（共享连接的分发面）");

  console.log("PASS: toolListChanged 多订阅者分发 通过");
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
} finally {
  await registry.disposeAll();
  await ws.cleanup();
}
