/**
 * 方案C §6.5 竞速 smoke：dispose/删表 与队列任务交错 → 已死连接上的任务
 * no-op、零工具注册泄漏、订阅者经对账恢复。
 *
 * 场景:
 *   1. B 经 inline 入口订阅正在被 reload 判死的连接 → reload dispose 后
 *      B 的订阅任务 no-op、无注册泄漏（B 0 工具、旧进程消亡）
 *   2. 条目重新加回 yml → reload 枚举（liveAgents × yml）把 A、B 都补订到
 *      新连接 → 双方工具恢复（对账义务）
 *
 * 运行: node test/shared-race-dispose-queue.mjs（需先 npm run build）
 */

import { writeFile } from "node:fs/promises";
import {
  connKeyOf,
  counterEntryYml,
  counterServer,
  expect,
  makeAgentCtx,
  makeRegistry,
  makeTempWorkspace,
  pollUntil,
  pidAlive,
  writeYml,
} from "./shared-helpers.mjs";

const log = (msg) => console.error(`[race-dispose] ${msg}`);

const ws = await makeTempWorkspace("race-dispose");
const registry = makeRegistry({ idleDropMs: 60_000, reloadDebounceMs: 80 });

try {
  await writeYml(ws.ymlPath, counterEntryYml("alpha"));
  const a = makeAgentCtx();
  const b = makeAgentCtx();
  registry.registerAgentPresence("agent-a", ws.cwd, a.ctx);
  registry.registerAgentPresence("agent-b", ws.cwd, b.ctx);
  await registry.ensureAgentServers("agent-a", ws.cwd, a.ctx);
  await registry.whenSettled();
  await registry.readyOf(connKeyOf(ws.ymlPath, "alpha")); // 等首次 fetch 完成
  await registry.whenSettled();
  const oldPid = Number((await a.registered.get("mcp__alpha__pid").execute({}, {})).content[0].text);

  // ---- 场景 1：inline 订阅（强制交错窗口）+ reload 判死 ----
  {
    // yml 先改为空条目集 servers: {}（reload 已排队未跑），再用 inline 入口让 B 订阅
    // 仍存在的 alpha 连接——B 的订阅任务入队后，reload 判死连接
    await writeFile(ws.ymlPath, "servers: {}\n");
    registry.ensureAgentServersInline("agent-b", ws.cwd, b.ctx, {
      alpha: { transport: "stdio", command: process.execPath, args: [counterServer] },
    });
    // 等 reload 防抖到期并完成判死
    await pollUntil(
      () => (registry.connectionKeys().length === 0 ? true : undefined),
      { timeoutMs: 5000, what: "reload 判死 alpha 连接" }
    );
    await registry.whenSettled();
    await pollUntil(() => (!pidAlive(oldPid) ? true : undefined), {
      timeoutMs: 8000,
      what: `旧进程 ${oldPid} 消亡（树杀联动）`,
    });
    expect(a.registered.size === 0, `A 的 alpha 工具应被摘除，实际 ${a.registered.size}`);
    expect(b.registered.size === 0, `B 的滞留订阅任务不得注册任何工具（活性守卫），实际 ${b.registered.size}`);
    log(`场景1 OK: dispose × 队列交错 → 任务 no-op、零泄漏、旧进程 ${oldPid} 已回收`);
  }

  // ---- 场景 2：条目加回 → liveAgents × yml 对账把 A、B 都补齐 ----
  {
    await writeYml(ws.ymlPath, counterEntryYml("alpha"));
    await pollUntil(
      () => (a.registered.size === 4 && b.registered.size === 4 ? true : undefined),
      { timeoutMs: 8000, what: "对账后 A、B 工具恢复" }
    );
    await registry.whenSettled();
    const newPid = Number((await a.registered.get("mcp__alpha__pid").execute({}, {})).content[0].text);
    expect(newPid !== oldPid, `新连接应为新进程`);
    const bPid = Number((await b.registered.get("mcp__alpha__pid").execute({}, {})).content[0].text);
    expect(bPid === newPid, `恢复后 A、B 仍共享同一进程`);
    log(`场景2 OK: 对账义务恢复 A、B 订阅（共享新进程 #${newPid}）`);
  }

  console.log("PASS: dispose/删表 × 队列交错 + 对账恢复 全部通过");
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
} finally {
  await registry.disposeAll();
  await ws.cleanup();
}
