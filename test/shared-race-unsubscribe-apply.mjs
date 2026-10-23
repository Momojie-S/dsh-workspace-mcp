/**
 * 方案C §6.4 竞速 smoke：unsubscribe × apply 交错 + unsubscribe × reload 交错。
 *
 * 场景:
 *   1. 排队多次 apply（addtool 连发）后立刻 disposed agentA →
 *      A 的注册全部摘除且排队的 apply 不复活它们；B 完整无损；refs 不错位
 *   2. reload 窗口内退订：触发文件 reload 后立刻 disposed agentB →
 *      reload 后 B 不被重挂、无残留注册；A 照常重挂
 *
 * 运行: node test/shared-race-unsubscribe-apply.mjs（需先 npm run build）
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
import { setTimeout as sleep } from "node:timers/promises";

const log = (msg) => console.error(`[race-unsub] ${msg}`);

const ws = await makeTempWorkspace("race-unsub");
const registry = makeRegistry({ idleDropMs: 60_000, reloadDebounceMs: 80 });

try {
  await writeYml(ws.ymlPath, counterEntryYml("alpha"));
  const a = makeAgentCtx();
  const b = makeAgentCtx();
  registry.registerAgentPresence("agent-a", ws.cwd, a.ctx);
  registry.registerAgentPresence("agent-b", ws.cwd, b.ctx);
  await registry.ensureAgentServers("agent-a", ws.cwd, a.ctx);
  await registry.ensureAgentServers("agent-b", ws.cwd, b.ctx);
  await registry.whenSettled();
  await registry.readyOf(connKeyOf(ws.ymlPath, "alpha")); // 等首次 fetch 完成
  await registry.whenSettled();

  // ---- 场景 1：apply 排队 + 退订竞速 ----
  {
    const add = a.registered.get("mcp__alpha__addtool");
    // 连发两次 addtool → 两条 toolListChanged → 两个 apply 任务排队
    await add.execute({}, {});
    await add.execute({}, {});
    // 不等 apply 落地立刻退订 A（ disposed → active=false → apply 跳过 + 摘除）
    registry.agentDisposed("agent-a");
    await registry.whenSettled();
    await sleep(200); // 给可能复活的错误注册留时间（若守卫失效会在这里现形）
    expect(a.registered.size === 0, `退订后 A 应 0 注册（含排队 apply 不得复活），实际 ${a.registered.size}`);
    expect(b.registered.size === 6, `B 应保持 6 个工具（4 基础 + 2 extra），实际 ${b.registered.size}`);
    const key = registry.connectionKeys()[0];
    expect(registry.connectionInfo(key)?.refs === 1, `refs 应为 1，实际 ${registry.connectionInfo(key)?.refs}`);
    log("场景1 OK: 排队 apply × 退订竞速 → 无复活、无残留、refs 正确");
  }

  // ---- 场景 2：reload 窗口内退订 ----
  {
    // 内容变化触发 reload（gen 后缀进 args，深比较可识别）
    // 注意 chokidar awaitWriteFinish 有 ~300ms 稳定窗：reload 实际触发晚于本段开头，
    // 断言必须轮询「换代后的可观测特征」（新进程 = 场景 1 的 extra 工具消失）
    await writeYml(ws.ymlPath, counterEntryYml("alpha", "r2"));
    // A 在 reload 排队窗口回归（presence 登记 + 自愈 ensure；外部订阅会置 dirty，
    // 由 reload 收尾补跑落位——正是本场景要覆盖的交错）
    registry.registerAgentPresence("agent-a", ws.cwd, a.ctx);
    await registry.ensureAgentServers("agent-a", ws.cwd, a.ctx);
    // 不等 reload 落地立刻退订 B（B 从 liveAgents 摘除 → 枚举看不见它）
    registry.agentDisposed("agent-b");
    await pollUntil(
      () =>
        a.registered.size === 4 && !a.registered.has("mcp__alpha__extra-1")
          ? true
          : undefined,
      { timeoutMs: 10000, what: "reload 换代后 A 被补跑落位（4 基础工具、extra 消失）" }
    );
    await registry.whenSettled();
    await sleep(200);
    expect(b.registered.size === 0, `reload 窗口内退订的 B 不得被重挂，实际 ${b.registered.size}`);
    expect(a.registered.size === 4, `A 应为 4 个基础工具，实际 ${a.registered.size}`);
    const key = registry.connectionKeys()[0];
    expect(registry.connectionInfo(key)?.refs === 1, `reload 后 refs 应为 1`);
    log("场景2 OK: reload 窗口内回归+退订 → A 补跑落位、B 不重挂、无残留");
  }

  console.log("PASS: unsubscribe × apply / reload 竞速全部通过");
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
} finally {
  await registry.disposeAll();
  await ws.cleanup();
}
