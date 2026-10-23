/**
 * 方案C §6.8 多 server 部分删除 smoke（R4 必改 #1 的试金石）：
 *   - agent 订阅双 server → yml 删一个 → reload 后存活 server 工具保持、
 *     被删 server 工具移除（且存活 server 不失明）
 *   - 再改一次文件 → 存活 server 仍被重挂（簿记摘除时机的试金石）
 *
 * 运行: node test/shared-multi-server-partial-remove.mjs（需先 npm run build）
 */

import {
  connKeyOf,
  counterEntryYml,
  expect,
  makeAgentCtx,
  makeRegistry,
  makeTempWorkspace,
  pidAlive,
  pidVia,
  pollUntil,
  writeYml,
} from "./shared-helpers.mjs";

const log = (msg) => console.error(`[partial-remove] ${msg}`);

const ws = await makeTempWorkspace("partial-remove");
const registry = makeRegistry({ idleDropMs: 250, reloadDebounceMs: 60 });

try {
  await writeYml(ws.ymlPath, counterEntryYml("alpha") + counterEntryYml("beta"));
  const a = makeAgentCtx();
  registry.registerAgentPresence("agent-a", ws.cwd, a.ctx);
  await registry.ensureAgentServers("agent-a", ws.cwd, a.ctx);
  await registry.whenSettled();
  await registry.readyOf(connKeyOf(ws.ymlPath, "alpha"));
  await registry.readyOf(connKeyOf(ws.ymlPath, "beta"));
  await registry.whenSettled();
  expect(a.registered.size === 8, `双 server 应 8 个工具，实际 ${a.registered.size}`);
  const betaPid1 = await pidVia(a.registered, "beta");

  // ---- 删除 alpha 条目 → alpha 工具移除 + 进程回收；beta 工具保持（不失明） ----
  await writeYml(ws.ymlPath, counterEntryYml("beta"));
  await pollUntil(() => (a.registered.size === 4 ? true : undefined), {
    timeoutMs: 8000,
    what: "删除 alpha 后 A 剩 4 个 beta 工具",
  });
  expect(!a.registered.has("mcp__alpha__pid"), `alpha 工具应移除`);
  const betaPid2 = await pidVia(a.registered, "beta");
  expect(betaPid2 === betaPid1, `beta 进程不得被误杀（${betaPid2} 应等于 ${betaPid1}）`);
  await registry.whenSettled();
  expect(registry.agentSubscriptionServerNames("agent-a").join(",") === "beta", `簿记应只剩 beta（摘除粒度 agentId×serverKey）`);
  log(`步骤1 OK: 删 alpha → alpha 移除回收、beta 保持不失明（#${betaPid2}）`);

  // ---- 再改一次文件（beta 内容变化）→ 存活 server 仍被重挂 ----
  await writeYml(ws.ymlPath, counterEntryYml("beta", "gen2"));
  await pollUntil(async () => {
    const pid = await pidVia(a.registered, "beta");
    return pid !== betaPid2 ? pid : undefined;
  }, { timeoutMs: 8000, what: "beta 内容变化后被重挂（新 pid）" });
  expect(a.registered.size === 4, `beta 重挂后仍 4 个工具`);
  const betaPid3 = await pidVia(a.registered, "beta");
  await pollUntil(() => (!pidAlive(betaPid2) ? true : undefined), {
    timeoutMs: 8000,
    what: `旧 beta 进程 ${betaPid2} 消亡`,
  });
  log(`步骤2 OK: 再改文件 → beta 照常重挂换代（#${betaPid2} → #${betaPid3}）——存活 server 不失明`);

  console.log("PASS: 多 server 部分删除 + 存活 server 重挂 全部通过");
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
} finally {
  await registry.disposeAll();
  await ws.cleanup();
}
