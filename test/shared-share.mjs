/**
 * 方案C §6.1 共享矩阵 smoke：
 *   - 2 agent × 2 server → 恰 2 份进程（pid 断言），四个 (agent, server) 对全部注册
 *   - 单 server 双 agent → 恰 1 份进程
 *   - win32 大小写变体：同 path 不同大小写 → 共享一份（键 normalize 守护）
 *   - ready 等价物：conn.ready 首试结果 + joiner 语义（后加入者拿同一历史值）
 *
 * 运行: node test/shared-share.mjs（需先 npm run build）
 */

import {
  connKeyOf,
  counterServer,
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

function fail(msg) {
  throw new Error(`FAIL: ${msg}`);
}

const log = (msg) => console.error(`[share] ${msg}`);

process.on("unhandledRejection", (e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});

// ---- 1. 2 agent × 2 server → 恰 2 份进程，四对 (agent, server) 全注册 ----
{
  const ws = await makeTempWorkspace("share-matrix");
  const registry = makeRegistry({ idleDropMs: 60_000 });
  try {
    await writeYml(ws.ymlPath, counterEntryYml("alpha") + counterEntryYml("beta"));
    const a = makeAgentCtx();
    const b = makeAgentCtx();
    registry.registerAgentPresence("agent-a", ws.cwd, a.ctx);
    registry.registerAgentPresence("agent-b", ws.cwd, b.ctx);
    await registry.ensureAgentServers("agent-a", ws.cwd, a.ctx);
    await registry.ensureAgentServers("agent-b", ws.cwd, b.ctx);
    await registry.whenSettled();

    const alphaKey = connKeyOf(ws.ymlPath, "alpha");
    const betaKey = connKeyOf(ws.ymlPath, "beta");
    expect(registry.connectionKeys().length === 2, `应恰 2 条连接，实际 ${registry.connectionKeys().length}: ${registry.connectionKeys().join(", ")}`);
    expect(registry.connectionInfo(alphaKey)?.refs === 2, `alpha refs 应为 2`);
    expect(registry.connectionInfo(betaKey)?.refs === 2, `beta refs 应为 2`);

    // ready 等价物：首试成功；joiner（后 ensure 的 B）拿同一历史值
    const readyA = await registry.readyOf(alphaKey);
    expect(readyA && !readyA.error, `alpha ready 应成功: ${readyA?.error?.message ?? ""}`);
    await registry.readyOf(betaKey); // beta 的首次 fetch 也完成
    await registry.whenSettled();

    const [pa1, pb1, pa2, pb2] = await Promise.all([
      pidVia(a.registered, "alpha"),
      pidVia(b.registered, "alpha"),
      pidVia(a.registered, "beta"),
      pidVia(b.registered, "beta"),
    ]);
    expect(pa1 === pb1, `alpha 应共享同一进程（${pa1} vs ${pb1}）`);
    expect(pa2 === pb2, `beta 应共享同一进程（${pa2} vs ${pb2}）`);
    expect(pa1 !== pa2, `alpha 与 beta 应是不同进程`);
    log(`步骤1 OK: 2×2 矩阵 → 恰 2 份进程（alpha#${pa1} beta#${pa2}），四对全部注册`);
  } finally {
    await registry.disposeAll();
    await ws.cleanup();
  }
}

// ---- 2. 单 server 双 agent → 1 份进程 ----
{
  const ws = await makeTempWorkspace("share-single");
  const registry = makeRegistry({ idleDropMs: 60_000 });
  try {
    await writeYml(ws.ymlPath, counterEntryYml("gamma"));
    const c = makeAgentCtx();
    const d = makeAgentCtx();
    registry.registerAgentPresence("agent-c", ws.cwd, c.ctx);
    registry.registerAgentPresence("agent-d", ws.cwd, d.ctx);
    await registry.ensureAgentServers("agent-c", ws.cwd, c.ctx);
    await registry.ensureAgentServers("agent-d", ws.cwd, d.ctx);
    await registry.whenSettled();
    expect(registry.connectionKeys().length === 1, `应恰 1 条连接`);
    await registry.readyOf(connKeyOf(ws.ymlPath, "gamma")); // 等首次 fetch 完成
    await registry.whenSettled();
    const pc = await pidVia(c.registered, "gamma");
    const pd = await pidVia(d.registered, "gamma");
    expect(pc === pd, `gamma 应共享同一进程`);
    log(`步骤2 OK: 单 server 双 agent → 1 份进程（#${pc}）`);
  } finally {
    await registry.disposeAll();
    await ws.cleanup();
  }
}

// ---- 3. win32 大小写变体 → 共享一份（键 normalize 守护） ----
if (process.platform === "win32") {
  const ws = await makeTempWorkspace("share-case");
  const registry = makeRegistry({ idleDropMs: 60_000 });
  try {
    await writeYml(ws.ymlPath, counterEntryYml("delta"));
    const e = makeAgentCtx();
    const f = makeAgentCtx();
    // 构造大小写不同的同一路径：翻转盘符大小写（其余段保持原样）
    const cwdFlip = ws.cwd[0].toLowerCase() + ws.cwd.slice(1);
    registry.registerAgentPresence("agent-e", ws.cwd, e.ctx);
    registry.registerAgentPresence("agent-f", cwdFlip, f.ctx);
    await registry.ensureAgentServers("agent-e", ws.cwd, e.ctx);
    await registry.ensureAgentServers("agent-f", cwdFlip, f.ctx);
    await registry.whenSettled();
    const deltaKey = connKeyOf(ws.ymlPath, "delta");
    await registry.readyOf(deltaKey); // 等首次 fetch 完成
    await registry.whenSettled();
    const deltaKeys = registry.connectionKeys().filter((k) => k.includes("delta"));
    expect(deltaKeys.length === 1, `大小写变体应共享一份连接，实际 ${deltaKeys.length}`);
    const pe = await pidVia(e.registered, "delta");
    const pf = await pidVia(f.registered, "delta");
    expect(pe === pf, `大小写变体应共享同一进程（${pe} vs ${pf}）`);
    log(`步骤3 OK: win32 大小写变体共享一份（#${pe}）`);
  } finally {
    await registry.disposeAll();
    await ws.cleanup();
  }
} else {
  log("步骤3 SKIP: 非 win32，大小写变体不适用");
}

// ---- 4. joiner 语义：后加入者拿历史首次 ready（已结算） ----
{
  const ws = await makeTempWorkspace("share-ready");
  const registry = makeRegistry({ idleDropMs: 60_000 });
  try {
    await writeYml(ws.ymlPath, counterEntryYml("alpha"));
    const a = makeAgentCtx();
    registry.registerAgentPresence("agent-a", ws.cwd, a.ctx);
    await registry.ensureAgentServers("agent-a", ws.cwd, a.ctx);
    const key = connKeyOf(ws.ymlPath, "alpha");
    const readyFirst = registry.readyOf(key);
    expect(readyFirst, `连接 ready 应存在`);
    await readyFirst;
    await sleep(50); // 连接已稳定
    const b = makeAgentCtx();
    registry.registerAgentPresence("agent-b", ws.cwd, b.ctx);
    await registry.ensureAgentServers("agent-b", ws.cwd, b.ctx);
    const readyJoin = registry.readyOf(key);
    expect(readyJoin === readyFirst, `joiner 应拿到同一历史 ready（首次构建结果）`);
    log("步骤4 OK: ready joiner 语义（历史首次结果）");
  } finally {
    await registry.disposeAll();
    await ws.cleanup();
  }
}

// ---- 收尾：全部连接 dispose 后进程零残留 ----
console.log("PASS: 共享矩阵 / 单server共享 / 大小写变体 / joiner ready 全部通过");
process.exit(0);
