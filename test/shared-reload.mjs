/**
 * 方案C §6.7 reload 全语义 smoke：
 *   a. 配置变化 → 连接换代（新 pid、旧进程消亡）、订阅者重挂、进程数仍 1
 *   b. subscribe × reload 交错（dirty 全生命周期）→ 新订阅者被补跑落位
 *   c. grace × reload：全退订进 grace 后改文件 → 收尾回收 path 状态，
 *      grace 到期连接回收，无孤儿
 *   d. 配置读取失败（非法 yml）→ 保守保留现状（工具不掉）；修复后 reload 恢复
 *   e. ENOENT（删除 yml）→ 空条目集对账 → 全部摘除 + 整树回收
 *
 * 运行: node test/shared-reload.mjs（需先 npm run build）
 */

import { rm } from "node:fs/promises";
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
  sleep,
  writeYml,
} from "./shared-helpers.mjs";

const log = (msg) => console.error(`[reload] ${msg}`);

const ws = await makeTempWorkspace("reload");
const registry = makeRegistry({ idleDropMs: 250, reloadDebounceMs: 60 });

try {
  await writeYml(ws.ymlPath, counterEntryYml("alpha"));
  const a = makeAgentCtx();
  const b = makeAgentCtx();
  let c;
  registry.registerAgentPresence("agent-a", ws.cwd, a.ctx);
  registry.registerAgentPresence("agent-b", ws.cwd, b.ctx);
  await registry.ensureAgentServers("agent-a", ws.cwd, a.ctx);
  await registry.ensureAgentServers("agent-b", ws.cwd, b.ctx);
  await registry.whenSettled();
  await registry.readyOf(connKeyOf(ws.ymlPath, "alpha")); // 等首次 fetch 完成
  await registry.whenSettled();
  const pid1 = await pidVia(a.registered, "alpha");
  const key = registry.connectionKeys()[0];

  // ---- a. 配置变化 → 连接换代 ----
  await writeYml(ws.ymlPath, counterEntryYml("alpha", "gen2"));
  await pollUntil(async () => {
    const pid = await pidVia(a.registered, "alpha");
    return pid !== pid1 ? pid : undefined;
  }, { timeoutMs: 8000, what: "配置变化后连接换代（新 pid）" });
  await registry.whenSettled();
  const pid2 = await pidVia(a.registered, "alpha");
  const pid2b = await pidVia(b.registered, "alpha");
  expect(pid2 === pid2b, `换代后 A、B 仍共享同一新进程`);
  expect(registry.connectionKeys().length === 1, `换代后应仍 1 条连接`);
  await pollUntil(() => (!pidAlive(pid1) ? true : undefined), {
    timeoutMs: 8000,
    what: `旧进程 ${pid1} 消亡（树杀联动）`,
  });
  log(`a OK: 配置变化 → 换代（#${pid1} → #${pid2}），订阅者重挂，旧进程回收`);

  // ---- b. subscribe × reload 交错（dirty 生命周期） ----
  {
    await writeYml(ws.ymlPath, counterEntryYml("alpha", "gen3") + counterEntryYml("beta"));
    await sleep(80); // > reloadDebounceMs：确保 reload 已 in-flight（reloadOnce 进行中）
    c = makeAgentCtx();
    registry.registerAgentPresence("agent-c", ws.cwd, c.ctx);
    await registry.ensureAgentServers("agent-c", ws.cwd, c.ctx); // in-flight → 置 dirty
    await pollUntil(
      () => (c.registered.size === 8 && a.registered.size === 8 ? true : undefined),
      { timeoutMs: 10000, what: "dirty 补跑后 C 落位（alpha+beta 各 4 工具）" }
    );
    await registry.whenSettled();
    expect(registry.connectionKeys().length === 2, `交错后应 2 条连接（alpha+beta）`);
    const cAlpha = await pidVia(c.registered, "alpha");
    const aAlpha = await pidVia(a.registered, "alpha");
    expect(cAlpha === aAlpha, `C 应共享 alpha 连接`);
    log("b OK: subscribe × reload 交错 → dirty 补跑落位新订阅者");
  }

  // ---- d. 非法 yml → 保守保留现状 ----
  {
    await writeYml(ws.ymlPath, "servers: [broken-inline-sequence]\n  - bad");
    await sleep(300); // 等 reload 触发并走瞬态失败分支
    expect(a.registered.size === 8, `非法 yml 应保守保留工具，实际 ${a.registered.size}`);
    expect(registry.connectionKeys().length === 2, `非法 yml 不应动连接`);
    // 修复 → reload 恢复正常
    await writeYml(ws.ymlPath, counterEntryYml("alpha", "gen3") + counterEntryYml("beta"));
    await pollUntil(() => (registry.connectionKeys().length === 2 ? true : undefined), {
      timeoutMs: 8000,
      what: "修复 yml 后 reload 正常",
    });
    await registry.whenSettled();
    expect(a.registered.size === 8, `修复后工具应健在`);
    log("d OK: 配置读取失败 → 保守保留现状；修复后恢复");
  }

  // ---- e. ENOENT（删除 yml）→ 空条目集对账 → 全部摘除 + 整树回收 ----
  {
    const alphaPid = await pidVia(a.registered, "alpha");
    // 等 d 段最后写盘的 awaitWriteFinish 稳定窗（~300ms）过去再删，
    // 否则 unlink 与稳定窗重叠会被 chokidar 吞掉（事件缺失，非产品缺陷）
    await sleep(500);
    await rm(ws.ymlPath);
    await pollUntil(
      () => (a.registered.size === 0 && registry.connectionKeys().length === 0 ? true : undefined),
      { timeoutMs: 8000, what: "ENOENT 后空条目集对账（全摘除 + 回收）" }
    );
    await pollUntil(() => (!pidAlive(alphaPid) ? true : undefined), {
      timeoutMs: 8000,
      what: `alpha 进程 ${alphaPid} 消亡`,
    });
    log("e OK: ENOENT → 全部摘除 + 树杀回收");

    // 重新建文件 → liveAgents 仍登记 → 枚举重挂全员
    await writeYml(ws.ymlPath, counterEntryYml("alpha"));
    await pollUntil(
      () => (a.registered.size === 4 && b.registered.size === 4 && c.registered.size === 4 ? true : undefined),
      { timeoutMs: 8000, what: "重建 yml 后三 agent 全部重挂" }
    );
    log("e2 OK: yml 重建 → liveAgents × 条目 枚举全员重挂");
  }

  // ---- c. grace × reload：全退订后改文件 → 收尾回收 path；grace 到期回收连接 ----
  {
    await writeYml(ws.ymlPath, counterEntryYml("alpha", "gen4"));
    registry.agentDisposed("agent-a");
    registry.agentDisposed("agent-b");
    registry.agentDisposed("agent-c");
    // 等 reload 跑完（收尾 3：liveAgents 空 → path 状态回收）
    await pollUntil(() => (registry.pathKeys().length === 0 ? true : undefined), {
      timeoutMs: 8000,
      what: "liveAgents 清空后 path 状态回收",
    });
    // grace 到期 → 连接回收
    await pollUntil(() => (registry.connectionKeys().length === 0 ? true : undefined), {
      timeoutMs: 6000,
      what: "grace 到期连接回收",
    });
    log("c OK: grace × reload → path 状态回收 + 连接回收，无孤儿");
  }

  console.log("PASS: reload 全语义（换代/交错/失败保留/ENOENT/grace 交错）通过");
  process.exit(0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
} finally {
  await registry.disposeAll();
  await ws.cleanup();
}
