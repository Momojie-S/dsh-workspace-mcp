/**
 * 方案C §6.3 并发首订 smoke：两 agent 并发 subscribe 同 key → 只 spawn 一份
 * （同步段三件套的守护测试——get-or-create 必须在第一个 await 前同步完成）。
 *
 * 运行: node test/shared-concurrent-subscribe.mjs（需先 npm run build）
 */

import {
  connKeyOf,
  counterEntryYml,
  expect,
  makeAgentCtx,
  makeRegistry,
  makeTempWorkspace,
  pidVia,
  writeYml,
} from "./shared-helpers.mjs";

const log = (msg) => console.error(`[concurrent] ${msg}`);

const ws = await makeTempWorkspace("concurrent");
const registry = makeRegistry({ idleDropMs: 60_000 });

try {
  await writeYml(ws.ymlPath, counterEntryYml("alpha"));
  const a = makeAgentCtx();
  const b = makeAgentCtx();
  // 双入：同步段登记两个 agent（模拟 created 双触发/created+pre-step 交错）
  registry.registerAgentPresence("agent-a", ws.cwd, a.ctx);
  registry.registerAgentPresence("agent-a", ws.cwd, a.ctx);
  registry.registerAgentPresence("agent-b", ws.cwd, b.ctx);
  // 并发 ensure（不 await 第一个就发起第二个）
  await Promise.all([
    registry.ensureAgentServers("agent-a", ws.cwd, a.ctx),
    registry.ensureAgentServers("agent-b", ws.cwd, b.ctx),
    registry.ensureAgentServers("agent-a", ws.cwd, a.ctx),
  ]);
  await registry.whenSettled();

  expect(registry.connectionKeys().length === 1, `并发首订应只建 1 条连接，实际 ${registry.connectionKeys().length}`);
  expect(registry.connectionInfo(registry.connectionKeys()[0])?.refs === 2, `refs 应为 2`);
  await registry.readyOf(connKeyOf(ws.ymlPath, "alpha")); // 等首次 fetch 完成
  await registry.whenSettled();
  const pa = await pidVia(a.registered, "alpha");
  const pb = await pidVia(b.registered, "alpha");
  expect(pa === pb, `并发首订后应共享进程（${pa} vs ${pb}）`);
  log(`OK: 并发首订只 spawn 一份（#${pa}），refs=2`);
  console.log("PASS: 并发首订同步占位（只 spawn 一份）");
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
} finally {
  await registry.disposeAll();
  await ws.cleanup();
}
