/**
 * 方案C §6.6 生命周期 smoke：grace 计时器与退订幂等。
 *
 * 场景:
 *   1. 双 agent 退订其一 → 连接存活（另一人 refs=1，无 grace）
 *   2. 双双退订 → grace 到期 → 连接回收、进程消亡
 *   3. grace 窗口内重订 → 复用同一连接（无 respawn，pid 不变）
 *   4. 重复 agentDisposed → 幂等不抛
 *
 * 运行: node test/shared-lifecycle.mjs（需先 npm run build）
 */

import {
  counterEntryYml,
  expect,
  makeAgentCtx,
  makeRegistry,
  makeTempWorkspace,
  pidAlive,
  pidVia,
  pollUntil,
  sleep,
  writeYml,
} from "./shared-helpers.mjs";

const log = (msg) => console.error(`[lifecycle] ${msg}`);

const ws = await makeTempWorkspace("lifecycle");
const registry = makeRegistry({ idleDropMs: 300 });

try {
  await writeYml(ws.ymlPath, counterEntryYml("alpha"));
  const a = makeAgentCtx();
  const b = makeAgentCtx();
  registry.registerAgentPresence("agent-a", ws.cwd, a.ctx);
  registry.registerAgentPresence("agent-b", ws.cwd, b.ctx);
  await registry.ensureAgentServers("agent-a", ws.cwd, a.ctx);
  await registry.ensureAgentServers("agent-b", ws.cwd, b.ctx);
  await registry.whenSettled();
  const key = registry.connectionKeys()[0];
  await registry.readyOf(key); // 等首次 fetch 完成
  await registry.whenSettled();
  const pid = await pidVia(a.registered, "alpha");

  // ---- 1. 退订其一 → 存活 ----
  registry.agentDisposed("agent-a");
  await registry.whenSettled();
  await sleep(100);
  expect(registry.connectionInfo(key)?.refs === 1, `A 退订后 refs 应为 1`);
  expect(registry.connectionKeys().length === 1, `B 仍在订阅，连接必须存活`);
  await sleep(400); // 若错误地 arm 了 grace，这里会现形
  expect(registry.connectionKeys().length === 1, `refs>0 不应进入 grace`);
  expect(pidAlive(pid), `进程应保持存活`);
  log("步骤1 OK: 退订其一 → 连接存活（无 grace 误布防）");

  // ---- 4（先验幂等）. 重复 disposed 不抛、状态不错位 ----
  registry.agentDisposed("agent-a");
  registry.agentDisposed("agent-a");
  expect(registry.connectionInfo(key)?.refs === 1, `重复 disposed 后 refs 仍应为 1`);
  log("步骤4 OK: agentDisposed 幂等（重复调用不抛、refs 不变）");

  // ---- 3. 全退订 → grace 窗口内重订 → 复用（无 respawn） ----
  registry.agentDisposed("agent-b");
  await registry.whenSettled();
  expect(registry.connectionKeys().length === 1, `grace 窗口内连接应仍存活`);
  // 立即重订 A（窗口 = 300ms 内）
  registry.registerAgentPresence("agent-a", ws.cwd, a.ctx);
  await registry.ensureAgentServers("agent-a", ws.cwd, a.ctx);
  await registry.whenSettled();
  const pid2 = await pidVia(a.registered, "alpha");
  expect(pid2 === pid, `grace 内重订应复用连接（pid ${pid2} 应等于 ${pid}）`);
  log(`步骤3 OK: grace 窗口内重订复用（pid 不变 #${pid}）`);

  // ---- 2. 全退订 → grace 到期 → 回收 + 进程消亡 ----
  registry.agentDisposed("agent-a");
  await pollUntil(() => (registry.connectionKeys().length === 0 ? true : undefined), {
    timeoutMs: 4000,
    what: "grace 到期后连接回收",
  });
  await pollUntil(() => (!pidAlive(pid) ? true : undefined), {
    timeoutMs: 8000,
    what: `回收后进程 ${pid} 消亡`,
  });
  log("步骤2 OK: 全退订 → grace 到期 → 连接回收、进程消亡");

  console.log("PASS: grace / 退订幂等 / 窗口复用 全部通过");
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
} finally {
  await registry.disposeAll();
  await ws.cleanup();
}
